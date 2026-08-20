import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rollbackToCheckpoint, type Checkpoint } from './rollback.js';

const CHECKPOINT_DIR = resolve(homedir(), '.openswarm/checkpoints');

describe('rollback checkpoint safety', () => {
  let repo: string;
  let root: string;
  let checkpointFiles: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-rollback-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'file.txt'), 'initial\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(async () => {
    for (const file of checkpointFiles) {
      await unlink(file).catch(() => undefined);
    }
    checkpointFiles = [];
    vi.restoreAllMocks();
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function writeCheckpoint(patch: Partial<Checkpoint>): Promise<Checkpoint> {
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    const checkpoint: Checkpoint = {
      id: `ckpt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      executionId: 'exec-1',
      projectPath: repo,
      createdAt: Date.now(),
      commitHash,
      branchName: 'main',
      description: 'test',
      ...patch,
    };
    mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const file = resolve(CHECKPOINT_DIR, `${checkpoint.id}.json`);
    writeFileSync(file, JSON.stringify(checkpoint, null, 2));
    checkpointFiles.push(file);
    return checkpoint;
  }

  it('rejects invalid checkpoint ids before reading from disk', async () => {
    const result = await rollbackToCheckpoint('../outside');

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('ignores checkpoint files that fail schema validation', async () => {
    const checkpoint = await writeCheckpoint({ commitHash: 'not-a-commit' });

    const result = await rollbackToCheckpoint(checkpoint.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('reports failure when reset_hard cannot restore the checkpoint stash', async () => {
    const checkpoint = await writeCheckpoint({ stashId: 'stash@{999}' });
    writeFileSync(join(repo, 'file.txt'), 'changed\n');

    const result = await rollbackToCheckpoint(checkpoint.id, 'reset_hard');

    expect(result.success).toBe(false);
    expect(result.action).toBe('stash_pop');
    expect(result.message).toContain('stash restoration failed');
  });
});
