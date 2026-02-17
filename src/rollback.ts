// ============================================
// Claude Swarm - Git-based Rollback System
// Automatic recovery on workflow failure
// ============================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

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

// ============================================
// Checkpoint Storage
// ============================================

const CHECKPOINT_DIR = resolve(homedir(), '.claude-swarm/checkpoints');

/**
 * Save checkpoint
 */
async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  const filePath = resolve(CHECKPOINT_DIR, `${checkpoint.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load checkpoint
 */
async function loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
  try {
    const filePath = resolve(CHECKPOINT_DIR, `${checkpointId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
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
        const checkpoint: Checkpoint = JSON.parse(content);
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

// ============================================
// Git Operations
// ============================================

/**
 * Git command execution helper
 */
async function gitExec(projectPath: string, command: string): Promise<{ stdout: string; stderr: string }> {
  const expandedPath = projectPath.replace('~', homedir());
  try {
    return await execAsync(`git ${command}`, { cwd: expandedPath });
  } catch (error: any) {
    throw new Error(`Git command failed: git ${command}\n${error.stderr || error.message}`);
  }
}

/**
 * Get current commit hash
 */
async function getCurrentCommit(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'rev-parse HEAD');
  return stdout.trim();
}

/**
 * Get current branch name
 */
async function getCurrentBranch(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'branch --show-current');
  return stdout.trim() || 'HEAD';
}

/**
 * Check if there are uncommitted changes
 */
async function hasChanges(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(projectPath, 'status --porcelain');
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
    const { stdout } = await gitExec(projectPath, 'status --porcelain');
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}

// ============================================
// Checkpoint Creation
// ============================================

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

    const stashMessage = `claude-swarm-checkpoint-${executionId}`;
    await gitExec(expandedPath, `stash push -m "${stashMessage}" --include-untracked`);

    // Find Stash ID
    const { stdout } = await gitExec(expandedPath, 'stash list');
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

// ============================================
// Rollback Operations
// ============================================

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
      checkpoint: null as any,
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
      checkpoint: null as any,
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
        await gitExec(checkpoint.projectPath, `reset --hard ${checkpoint.commitHash}`);

        // Restore stash if it existed
        if (checkpoint.stashId) {
          try {
            await gitExec(checkpoint.projectPath, `stash pop ${checkpoint.stashId}`);
          } catch {
            console.log('[Rollback] Stash pop failed, may have conflicts');
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
        await gitExec(checkpoint.projectPath, `reset --soft ${checkpoint.commitHash}`);

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
          await gitExec(checkpoint.projectPath, `stash push -m "${stashMsg}" --include-untracked`);
        }
        await gitExec(checkpoint.projectPath, `checkout ${checkpoint.commitHash}`);

        // Restore original stash
        if (checkpoint.stashId) {
          try {
            await gitExec(checkpoint.projectPath, `stash pop ${checkpoint.stashId}`);
          } catch {
            console.log('[Rollback] Original stash pop failed');
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
        await gitExec(checkpoint.projectPath, `checkout ${checkpoint.commitHash} -- .`);

        return {
          success: true,
          checkpoint,
          action: 'checkout',
          message: `Files restored from ${checkpoint.commitHash.slice(0, 7)}`,
        };

      default:
        throw new Error(`Unknown rollback strategy: ${strategy}`);
    }
  } catch (error: any) {
    console.error('[Rollback] Failed:', error.message);
    return {
      success: false,
      checkpoint,
      action: 'reset',
      message: 'Rollback failed',
      error: error.message,
    };
  }
}

// ============================================
// Cleanup
// ============================================

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
      const checkpoint: Checkpoint = JSON.parse(content);

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
        checkpoints.push(JSON.parse(content));
      }
    }

    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

// ============================================
// Utility Functions
// ============================================

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
