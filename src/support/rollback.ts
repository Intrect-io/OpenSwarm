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
 */
async function resolveStashRef(projectPath: string, message: string): Promise<string | undefined> {
  const { stdout } = await gitExec(projectPath, 'stash', 'list');
  const line = stdout.split('\n').find((entry) => entry.includes(message));
  return line?.match(/stash@\{\d+\}/)?.[0];
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
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function checkpointFilePath(checkpointId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(checkpointId) || checkpointId === '.' || checkpointId === '..') {
    throw new Error(`Invalid checkpoint id: ${checkpointId}`);
  }
  const filePath = resolve(CHECKPOINT_DIR, `${checkpointId}.json`);
  if (!isPathInside(CHECKPOINT_DIR, filePath)) {
    throw new Error(`Checkpoint path escapes checkpoint directory: ${checkpointId}`);
  }
  return filePath;
}

function parseCheckpoint(content: string): Checkpoint | null {
  try {
    const parsed = CheckpointSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Save checkpoint
 */
async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  const filePath = checkpointFilePath(checkpoint.id);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load checkpoint
 */
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

// Git Operations

/**
 * Safe git command execution (no shell)
 */
async function gitExec(projectPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const expandedPath = projectPath.replace('~', homedir());
  try {
    return await execFileAsync('git', args, { cwd: expandedPath });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string })?.stderr;
    throw new Error(`Git command failed: git ${args.join(' ')}\n${stderr || detail}`);
  }
}

/**
 * Get current commit hash
 */
async function getCurrentCommit(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'rev-parse', 'HEAD');
  return stdout.trim();
}

/**
 * Get current branch name
 */
async function getCurrentBranch(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'branch', '--show-current');
  return stdout.trim() || 'HEAD';
}

/**
 * Check if there are uncommitted changes
 */
async function hasChanges(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(projectPath, 'status', '--porcelain');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get list of changed files
 */
async function getChangedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await gitExec(projectPath, 'status', '--porcelain');
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}

// Checkpoint Creation

/**
 * Create checkpoint before workflow starts
 */
export async function createCheckpoint(
  executionId: string,
  projectPath: string,
  description?: string
): Promise<Checkpoint> {
  console.log(`[Rollback] Creating checkpoint for execution: ${executionId}`);

  const expandedPath = projectPath.replace('~', homedir());
  const commitHash = await getCurrentCommit(expandedPath);
  const branchName = await getCurrentBranch(expandedPath);
  let stashId: string | undefined;

  // Stash if there are changes
  if (await hasChanges(expandedPath)) {
    const changedFiles = await getChangedFiles(expandedPath);
    console.log(`[Rollback] Stashing ${changedFiles.length} changed files`);

    const stashMessage = checkpointStashMessage(executionId);
    await gitExec(expandedPath, 'stash', 'push', '-m', stashMessage, '--include-untracked');

    // Find Stash ID
    const { stdout } = await gitExec(expandedPath, 'stash', 'list');
    const stashLine = stdout.split('\n').find(line => line.includes(stashMessage));
    if (stashLine) {
      stashId = stashLine.match(/stash@\{(\d+)\}/)?.[0];
    }
  }

  const checkpoint: Checkpoint = {
    id: `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    executionId,
    projectPath: expandedPath,
    createdAt: Date.now(),
    commitHash,
    stashId,
    branchName,
    description: description || `Checkpoint for ${executionId}`,
  };

  await saveCheckpoint(checkpoint);
  console.log(`[Rollback] Checkpoint created: ${checkpoint.id}`);

  return checkpoint;
}

// Rollback Operations

/**
 * Rollback to checkpoint
 */
export async function rollbackToCheckpoint(
  checkpointId: string,
  strategy: RollbackStrategy = 'reset_hard'
): Promise<RollbackResult> {
  const checkpoint = await loadCheckpoint(checkpointId);
  if (!checkpoint) {
    return {
      success: false,
      checkpoint: null!,
      action: 'reset',
      message: 'Checkpoint not found',
      error: `Checkpoint ${checkpointId} does not exist`,
    };
  }

  return rollback(checkpoint, strategy);
}

/**
 * Rollback by execution ID
 */
export async function rollbackExecution(
  executionId: string,
  strategy: RollbackStrategy = 'reset_hard'
): Promise<RollbackResult> {
  const checkpoint = await findCheckpointByExecution(executionId);
  if (!checkpoint) {
    return {
      success: false,
      checkpoint: null!,
      action: 'reset',
      message: 'Checkpoint not found for execution',
      error: `No checkpoint found for execution ${executionId}`,
    };
  }

  return rollback(checkpoint, strategy);
}

/**
 * Perform actual rollback
 */
async function rollback(
  checkpoint: Checkpoint,
  strategy: RollbackStrategy
): Promise<RollbackResult> {
  console.log(`[Rollback] Rolling back to checkpoint: ${checkpoint.id}`);
  console.log(`[Rollback] Strategy: ${strategy}`);
  console.log(`[Rollback] Target commit: ${checkpoint.commitHash}`);

  try {
    switch (strategy) {
      case 'reset_hard':
        // Discard all changes and restore to checkpoint
        await gitExec(checkpoint.projectPath, 'reset', '--hard', checkpoint.commitHash);

        // Restore stash if it existed
        if (checkpoint.stashId) {
          try {
            // Resolved by message, never by the stored index — see resolveStashRef.
            const stashRef = await resolveStashRef(
              checkpoint.projectPath, checkpointStashMessage(checkpoint.executionId),
            );
            if (!stashRef) throw new Error('checkpoint stash is no longer in the stash list');
            await gitExec(checkpoint.projectPath, 'stash', 'pop', stashRef);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log('[Rollback] Stash pop failed, may have conflicts');
            return {
              success: false,
              checkpoint,
              action: 'stash_pop',
              message: `Reset to ${checkpoint.commitHash.slice(0, 7)}, but stash restoration failed`,
              error: msg,
            };
          }
        }

        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Reset to ${checkpoint.commitHash.slice(0, 7)}`,
        };

      case 'reset_soft':
        // Keep changes in staged state
        await gitExec(checkpoint.projectPath, 'reset', '--soft', checkpoint.commitHash);

        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Soft reset to ${checkpoint.commitHash.slice(0, 7)}, changes staged`,
        };

      case 'stash':
        // Stash current changes and go to checkpoint
        if (await hasChanges(checkpoint.projectPath)) {
          const stashMsg = `rollback-preserve-${Date.now()}`;
          await gitExec(checkpoint.projectPath, 'stash', 'push', '-m', stashMsg, '--include-untracked');
        }
        await gitExec(checkpoint.projectPath, 'checkout', checkpoint.commitHash);

        // Restore original stash
        if (checkpoint.stashId) {
          try {
            // Must be resolved AFTER the rollback-preserve push above, which
            // shifted the checkpoint's stash down by one.
            const stashRef = await resolveStashRef(
              checkpoint.projectPath, checkpointStashMessage(checkpoint.executionId),
            );
            if (!stashRef) throw new Error('checkpoint stash is no longer in the stash list');
            await gitExec(checkpoint.projectPath, 'stash', 'pop', stashRef);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log('[Rollback] Original stash pop failed');
            return {
              success: false,
              checkpoint,
              action: 'stash_pop',
              message: `Checked out ${checkpoint.commitHash.slice(0, 7)}, but original stash restoration failed`,
              error: msg,
            };
          }
        }

        return {
          success: true,
          checkpoint,
          action: 'stash_pop',
          message: `Checked out ${checkpoint.commitHash.slice(0, 7)}, current changes stashed`,
        };

      case 'checkout_files':
        // Restore files to checkpoint state (keep commits)
        await gitExec(checkpoint.projectPath, 'checkout', checkpoint.commitHash, '--', '.');

        return {
          success: true,
          checkpoint,
          action: 'checkout',
          message: `Files restored from ${checkpoint.commitHash.slice(0, 7)}`,
        };

      default:
        throw new Error(`Unknown rollback strategy: ${strategy}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Rollback] Failed:', msg);
    return {
      success: false,
      checkpoint,
      action: 'reset',
      message: 'Rollback failed',
      error: msg,
    };
  }
}

// Cleanup

/**
 * Clean up old checkpoints
 */
export async function cleanupOldCheckpoints(maxAgeDays: number = 7): Promise<number> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const files = await fs.readdir(CHECKPOINT_DIR);
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = resolve(CHECKPOINT_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const checkpoint = parseCheckpoint(content);
      if (!checkpoint) continue;

      if (now - checkpoint.createdAt > maxAge) {
        await fs.unlink(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[Rollback] Cleaned up ${deleted} old checkpoints`);
    }

    return deleted;
  } catch {
    return 0;
  }
}

/**
 * List checkpoints
 */
export async function listCheckpoints(): Promise<Checkpoint[]> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const files = await fs.readdir(CHECKPOINT_DIR);
    const checkpoints: Checkpoint[] = [];

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

  return {
    branch: await getCurrentBranch(expandedPath),
    commit: await getCurrentCommit(expandedPath),
    hasChanges: await hasChanges(expandedPath),
    changedFiles: await getChangedFiles(expandedPath),
  };
}
