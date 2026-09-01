// ============================================
// OpenSwarm - Git-based Rollback System
// Automatic recovery on workflow failure
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// Types

/**
 * Checkpoint information
 */
export interface Checkpoint {
  id: string;
  executionId: string;
  projectPath: string;
  createdAt: number;
  commitHash: string;
  stashId?: string;
  branchName: string;
  description: string;
}

/**
 * Rollback result
 */
export interface RollbackResult {
  success: boolean;
  checkpoint: Checkpoint;
  action: 'reset' | 'stash_pop' | 'checkout';
  message: string;
  error?: string;
}

/**
 * Rollback strategy
 */
export type RollbackStrategy = 'reset_hard' | 'reset_soft' | 'stash' | 'checkout_files';

// Checkpoint Storage

const CHECKPOINT_DIR = resolve(homedir(), '.openswarm/checkpoints');
const CHECKPOINT_STASH_PREFIX = 'openswarm-checkpoint-';

function checkpointStashMessage(executionId: string): string {
  return `${CHECKPOINT_STASH_PREFIX}${executionId}`;
}

/**
 * Current `stash@{N}` for a stash identified by its message, or undefined if it
 * is no longer in the list.
 *
 * `stash@{N}` is a POSITION, not an identity: every `git stash push` inserts at
 * 0 and shifts everything down. The checkpoint's index was captured at creation
 * time and reused verbatim at pop time, so any stash created in between made it
 * point at the wrong entry — and the `stash` rollback strategy creates one
 * itself, immediately before popping, so it reliably restored the
 * `rollback-preserve-*` stash it had just made and orphaned the checkpoint's.
 * Resolving by message at pop time is stable under that shifting.
 *
 * Uses exact message matching so that an execution ID that is a prefix of
 * another execution ID (e.g. "abc" vs "abcd") does not select the wrong stash,
 * and intervening stashes with overlapping messages are ignored.
 *
 * `git stash list` output format:
 *   stash@{0}: On branch: <message>
 *   stash@{1}: On branch: <other-message>
 *
 * We split on ": " and compare the last segment exactly.
 */
async function resolveStashRef(projectPath: string, message: string): Promise<string | undefined> {
  const { stdout } = await gitExec(projectPath, 'stash', 'list');
  const lines = stdout.split('\n').filter(Boolean);
  // Match stashes by exact message identity, processing from newest to oldest
  for (const line of lines) {
    // Format: stash@{N}: On branch: <message>
    const colonIdx = line.indexOf(': ');
    if (colonIdx === -1) continue;
    const fullMsg = line.slice(colonIdx + 2);
    // Extract message after "On <context>: " prefix
    const msgMatch = fullMsg.match(/^On [^:]+: (.*)/);
    if (!msgMatch) continue;
    const msg = msgMatch[1];
    // Exact string match on message content
    if (msg === message) {
      const refMatch = line.match(/stash@\{\d+\}/);
      if (refMatch) return refMatch[0];
    }
  }
  return undefined;
}

const CheckpointSchema = z.object({
  id: z.string().min(1),
  executionId: z.string().min(1),
  projectPath: z.string().min(1),
  createdAt: z.number().finite(),
  commitHash: z.string().regex(/^[0-9a-f]{7,40}$/i),
  stashId: z.string().optional(),
  branchName: z.string().min(1),
  description: z.string().default(''),
});

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function checkpointFilePath(checkpointId: string): string {
  return resolve(CHECKPOINT_DIR, `${checkpointId}.json`);
}

function parseCheckpoint(content: string): Checkpoint | null {
  try {
    const parsed = JSON.parse(content);
    const result = CheckpointSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  const filePath = checkpointFilePath(checkpoint.id);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
}

async function loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
  try {
    const filePath = checkpointFilePath(checkpointId);
    const content = await fs.readFile(filePath, 'utf-8');
    return parseCheckpoint(content);
  } catch {
    return null;
  }
}

/**
 * Find checkpoint by execution ID
 */
export async function findCheckpointByExecution(executionId: string): Promise<Checkpoint | null> {
  try {
    const files = await fs.readdir(CHECKPOINT_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(resolve(CHECKPOINT_DIR, file), 'utf-8');
        const checkpoint = parseCheckpoint(content);
        if (!checkpoint) continue;
        if (checkpoint.executionId === executionId) {
          return checkpoint;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Git Helpers

async function gitExec(projectPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function getCurrentCommit(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'rev-parse', 'HEAD');
  return stdout;
}

async function getCurrentBranch(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  return stdout;
}

export async function hasChanges(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(projectPath, 'status', '--porcelain');
    return stdout.length > 0;
  } catch {
    return false;
  }
}

// Checkpoint Creation

/**
 * Create a checkpoint before executing a task
 */
export async function createCheckpoint(
  executionId: string,
  projectPath: string,
  description: string = '',
): Promise<Checkpoint> {
  const branchName = await getCurrentBranch(projectPath);
  const commitHash = await getCurrentCommit(projectPath);

  const checkpoint: Checkpoint = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    executionId,
    projectPath,
    createdAt: Date.now(),
    commitHash,
    branchName,
    description,
  };

  // Save checkpoint metadata
  await saveCheckpoint(checkpoint);

  return checkpoint;
}

/**
 * Create a checkpoint with stash for dirty working tree
 */
export async function createCheckpointWithStash(
  executionId: string,
  projectPath: string,
  description: string = '',
): Promise<Checkpoint> {
  const branchName = await getCurrentBranch(projectPath);
  const commitHash = await getCurrentCommit(projectPath);

  // Stash any uncommitted changes
  const stashMessage = checkpointStashMessage(executionId);
  await gitExec(projectPath, 'stash', 'push', '-m', stashMessage);

  // Find the stash ref by exact message
  const stashRef = await resolveStashRef(projectPath, stashMessage);

  const checkpoint: Checkpoint = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    executionId,
    projectPath,
    createdAt: Date.now(),
    commitHash,
    stashId: stashRef,
    branchName,
    description,
  };

  await saveCheckpoint(checkpoint);

  return checkpoint;
}

// Rollback Execution

/**
 * Rollback to a checkpoint
 */
export async function rollbackToCheckpoint(
  checkpoint: Checkpoint,
  strategy: RollbackStrategy = 'reset_hard',
): Promise<RollbackResult> {
  try {
    switch (strategy) {
      case 'reset_hard': {
        await gitExec(checkpoint.projectPath, 'checkout', checkpoint.branchName);
        await gitExec(checkpoint.projectPath, 'reset', '--hard', checkpoint.commitHash);
        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Hard reset to commit ${checkpoint.commitHash} on branch ${checkpoint.branchName}`,
        };
      }

      case 'reset_soft': {
        await gitExec(checkpoint.projectPath, 'checkout', checkpoint.branchName);
        await gitExec(checkpoint.projectPath, 'reset', '--soft', checkpoint.commitHash);
        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Soft reset to commit ${checkpoint.commitHash} on branch ${checkpoint.branchName}`,
        };
      }

      case 'stash': {
        if (!checkpoint.stashId) {
          return {
            success: false,
            checkpoint,
            action: 'stash_pop',
            message: 'No stash associated with checkpoint',
            error: 'Checkpoint has no stashId',
          };
        }
        // Resolve stash by exact message at pop time (stable under shifting indices)
        const stashMessage = checkpointStashMessage(checkpoint.executionId);
        const currentRef = await resolveStashRef(checkpoint.projectPath, stashMessage);
        if (!currentRef) {
          return {
            success: false,
            checkpoint,
            action: 'stash_pop',
            message: 'Stash no longer exists',
            error: `Stash with message "${stashMessage}" not found in stash list`,
          };
        }
        await gitExec(checkpoint.projectPath, 'stash', 'pop', currentRef);
        return {
          success: true,
          checkpoint,
          action: 'stash_pop',
          message: `Popped stash ${currentRef}`,
        };
      }

      case 'checkout_files': {
        await gitExec(checkpoint.projectPath, 'checkout', checkpoint.commitHash, '--', '.');
        return {
          success: true,
          checkpoint,
          action: 'checkout',
          message: `Checked out files from commit ${checkpoint.commitHash}`,
        };
      }

      default:
        return {
          success: false,
          checkpoint,
          action: 'reset',
          message: `Unknown rollback strategy: ${strategy}`,
          error: `Strategy "${strategy}" is not implemented`,
        };
    }
  } catch (error) {
    return {
      success: false,
      checkpoint,
      action: 'reset',
      message: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// List Checkpoints

/**
 * List all checkpoints
 */
export async function listCheckpoints(): Promise<Checkpoint[]> {
  try {
    const checkpoints: Checkpoint[] = [];
    const files = await fs.readdir(CHECKPOINT_DIR);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(resolve(CHECKPOINT_DIR, file), 'utf-8');
        const checkpoint = parseCheckpoint(content);
        if (checkpoint) checkpoints.push(checkpoint);
      }
    }

    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

// Utility Functions

/**
 * Get current git status summary
 */
export async function getGitStatus(projectPath: string): Promise<{
  branch: string;
  commit: string;
  hasChanges: boolean;
  changedFiles: string[];
}> {
  const expandedPath = projectPath.replace('~', homedir());
  const branch = await getCurrentBranch(expandedPath);
  const commit = await getCurrentCommit(expandedPath);
  const changed = await hasChanges(expandedPath);

  let changedFiles: string[] = [];
  if (changed) {
    try {
      const { stdout } = await gitExec(expandedPath, 'status', '--porcelain');
      changedFiles = stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
    } catch {
      changedFiles = [];
    }
  }

  return { branch, commit, hasChanges: changed, changedFiles };
}