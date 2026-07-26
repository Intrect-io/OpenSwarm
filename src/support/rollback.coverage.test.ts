import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// rollback.ts resolves CHECKPOINT_DIR from node:os homedir() at import time and
// every checkpoint read/write goes through node:fs/promises. Mock both so this
// file never touches the real ~/.openswarm/checkpoints directory (the existing
// rollback.test.ts already covers the "real disk" convention for a few basic
// cases; this file adds an isolated in-memory store to safely exercise the
// remaining functions/branches without side effects on the developer machine).
const { fsState, fsMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const notFound = (path: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  return {
    fsState: store,
    fsMock: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, content: string) => {
        store.set(String(path), String(content));
      }),
      readFile: vi.fn(async (path: string) => {
        const key = String(path);
        if (!store.has(key)) throw notFound(key);
        return store.get(key)!;
      }),
      readdir: vi.fn(async (dir: string) => {
        const prefix = `${String(dir)}/`;
        const names = new Set<string>();
        for (const key of store.keys()) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            if (rest && !rest.includes('/')) names.add(rest);
          }
        }
        return Array.from(names);
      }),
      unlink: vi.fn(async (path: string) => {
        const key = String(path);
        if (!store.has(key)) throw notFound(key);
        store.delete(key);
      }),
    },
  };
});

vi.mock('node:fs/promises', () => fsMock);
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => '/test-home-rollback' };
});

const {
  createCheckpoint,
  findCheckpointByExecution,
  rollbackToCheckpoint,
  rollbackExecution,
  cleanupOldCheckpoints,
  listCheckpoints,
  getGitStatus,
} = await import('./rollback.js');
type Checkpoint = Awaited<ReturnType<typeof createCheckpoint>>;

const FAKE_HOME = '/test-home-rollback';
const CHECKPOINT_DIR = resolve(FAKE_HOME, '.openswarm/checkpoints');

function checkpointPath(id: string): string {
  return resolve(CHECKPOINT_DIR, `${id}.json`);
}

function seedCheckpoint(overrides: Partial<Checkpoint> & { commitHash: string }): Checkpoint {
  const checkpoint: Checkpoint = {
    id: `ckpt-fixture-${Math.random().toString(36).slice(2, 8)}`,
    executionId: 'exec-fixture',
    projectPath: '/tmp/does-not-matter',
    createdAt: Date.now(),
    branchName: 'main',
    description: 'fixture',
    ...overrides,
  };
  fsState.set(checkpointPath(checkpoint.id), JSON.stringify(checkpoint));
  return checkpoint;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content);
  execFileSync('git', ['add', name], { cwd: dir });
  execFileSync('git', ['commit', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

function headCommit(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

function stashList(dir: string): string {
  return execFileSync('git', ['stash', 'list'], { cwd: dir }).toString();
}

describe('rollback.ts coverage', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    fsState.clear();
    fsMock.mkdir.mockClear();
    fsMock.writeFile.mockClear();
    fsMock.readFile.mockClear();
    fsMock.readdir.mockClear();
    fsMock.unlink.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    root = join('/tmp', `openswarm-rollback-cov-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    repo = join(root, 'repo');
    initRepo(repo);
    writeFileSync(join(repo, 'file.txt'), 'initial\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('createCheckpoint', () => {
    it('creates a checkpoint with no stash when the working tree is clean', async () => {
      const checkpoint = await createCheckpoint('exec-clean', repo);

      expect(checkpoint.executionId).toBe('exec-clean');
      expect(checkpoint.branchName).toBe('main');
      expect(checkpoint.commitHash).toBe(headCommit(repo));
      expect(checkpoint.stashId).toBeUndefined();
      expect(checkpoint.description).toBe('Checkpoint for exec-clean');
      expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    });

    it('uses a custom description when provided', async () => {
      const checkpoint = await createCheckpoint('exec-desc', repo, 'custom description');

      expect(checkpoint.description).toBe('custom description');
    });

    it('stashes uncommitted changes and records the stash id', async () => {
      writeFileSync(join(repo, 'file.txt'), 'dirty\n');
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');

      const checkpoint = await createCheckpoint('exec-dirty', repo);

      expect(checkpoint.stashId).toMatch(/^stash@\{\d+\}$/);
      // Stashing should have cleaned the working tree.
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();
      expect(status.trim()).toBe('');
      expect(stashList(repo)).toContain(`openswarm-checkpoint-exec-dirty`);
    });

    it('finds the saved checkpoint afterwards by execution id', async () => {
      const created = await createCheckpoint('exec-findme', repo);

      const found = await findCheckpointByExecution('exec-findme');

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });
  });

  describe('findCheckpointByExecution', () => {
    it('returns null when no checkpoint matches', async () => {
      seedCheckpoint({ commitHash: headCommit(repo), executionId: 'other-exec' });

      const result = await findCheckpointByExecution('missing-exec');

      expect(result).toBeNull();
    });

    it('skips non-json files and invalid entries while scanning', async () => {
      fsState.set(resolve(CHECKPOINT_DIR, 'notes.txt'), 'ignore me');
      fsState.set(resolve(CHECKPOINT_DIR, 'broken.json'), '{ not valid json');
      seedCheckpoint({ commitHash: 'not-a-commit', executionId: 'exec-target' }); // fails schema
      const good = seedCheckpoint({ commitHash: headCommit(repo), executionId: 'exec-target' });

      const result = await findCheckpointByExecution('exec-target');

      expect(result?.id).toBe(good.id);
    });

    it('returns null when the readdir call itself fails', async () => {
      fsMock.readdir.mockRejectedValueOnce(new Error('ENOENT: no such directory'));

      const result = await findCheckpointByExecution('exec-anything');

      expect(result).toBeNull();
    });
  });

  describe('rollbackToCheckpoint id validation', () => {
    it('rejects "." as a checkpoint id', async () => {
      const result = await rollbackToCheckpoint('.');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('rejects ".." as a checkpoint id', async () => {
      const result = await rollbackToCheckpoint('..');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('rollbackExecution', () => {
    it('returns an error result when no checkpoint exists for the execution', async () => {
      const result = await rollbackExecution('exec-none');

      expect(result.success).toBe(false);
      expect(result.action).toBe('reset');
      expect(result.error).toContain('No checkpoint found for execution exec-none');
    });

    it('rolls back to the checkpoint matching the execution id', async () => {
      // Point the checkpoint at the *initial* commit, then advance HEAD further
      // so the rollback has real work to do.
      const initialHash = headCommit(repo);
      const checkpoint = seedCheckpoint({
        commitHash: initialHash,
        executionId: 'exec-rb',
        projectPath: repo,
      });
      commitFile(repo, 'file.txt', 'second\n', 'second commit');

      const result = await rollbackExecution('exec-rb', 'reset_hard');

      expect(result.success).toBe(true);
      expect(result.action).toBe('reset');
      expect(result.checkpoint.id).toBe(checkpoint.id);
      expect(headCommit(repo)).toBe(initialHash);
    });
  });

  describe('rollback strategies', () => {
    it('reset_hard succeeds and moves HEAD back when there is no stash to restore', async () => {
      const checkpoint = seedCheckpoint({ commitHash: headCommit(repo), projectPath: repo });
      commitFile(repo, 'file.txt', 'second\n', 'second commit');

      const result = await rollbackToCheckpoint(checkpoint.id, 'reset_hard');

      expect(result.success).toBe(true);
      expect(result.action).toBe('reset');
      expect(headCommit(repo)).toBe(checkpoint.commitHash);
    });

    it('reset_soft moves HEAD but keeps the diff staged', async () => {
      const checkpoint = seedCheckpoint({ commitHash: headCommit(repo), projectPath: repo });
      commitFile(repo, 'file.txt', 'second\n', 'second commit');

      const result = await rollbackToCheckpoint(checkpoint.id, 'reset_soft');

      expect(result.success).toBe(true);
      expect(result.message).toContain('changes staged');
      expect(headCommit(repo)).toBe(checkpoint.commitHash);
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo }).toString();
      expect(staged.trim()).toBe('file.txt');
    });

    it('checkout_files restores file contents without moving HEAD', async () => {
      const checkpoint = seedCheckpoint({ commitHash: headCommit(repo), projectPath: repo });
      const laterCommit = commitFile(repo, 'file.txt', 'second\n', 'second commit');

      const result = await rollbackToCheckpoint(checkpoint.id, 'checkout_files');

      expect(result.success).toBe(true);
      expect(result.action).toBe('checkout');
      expect(headCommit(repo)).toBe(laterCommit);
      expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('initial\n');
    });

    it('stash strategy stashes current changes when there are none pending from the checkpoint', async () => {
      const checkpoint = seedCheckpoint({ commitHash: headCommit(repo), projectPath: repo });
      commitFile(repo, 'file.txt', 'second\n', 'second commit');
      writeFileSync(join(repo, 'file.txt'), 'uncommitted-edit\n');

      const result = await rollbackToCheckpoint(checkpoint.id, 'stash');

      expect(result.success).toBe(true);
      expect(result.action).toBe('stash_pop');
      expect(result.message).toContain('current changes stashed');
      expect(headCommit(repo)).toBe(checkpoint.commitHash);
      expect(stashList(repo)).toContain('rollback-preserve-');
    });

    it('stash strategy restores a pre-existing stash after checking out', async () => {
      writeFileSync(join(repo, 'file.txt'), 'stashed-value\n');
      // The message must be the one createCheckpoint actually writes: the stash is
      // now located by message rather than by its (shifting) stash@{N} position,
      // so a fixture using an arbitrary message describes a checkpoint that
      // createCheckpoint could never produce.
      execFileSync('git', ['stash', 'push', '-m', 'openswarm-checkpoint-exec-fixture'], { cwd: repo });
      const stashLine = stashList(repo).split('\n').find(line => line.includes('openswarm-checkpoint-exec-fixture'));
      const stashId = stashLine?.match(/stash@\{(\d+)\}/)?.[0];
      expect(stashId).toBeDefined();

      const checkpoint = seedCheckpoint({
        commitHash: headCommit(repo),
        projectPath: repo,
        stashId,
      });

      const result = await rollbackToCheckpoint(checkpoint.id, 'stash');

      expect(result.success).toBe(true);
      expect(result.action).toBe('stash_pop');
      expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('stashed-value\n');
      expect(stashList(repo).trim()).toBe('');
    });

    it('stash strategy reports failure when the original stash cannot be restored', async () => {
      const checkpoint = seedCheckpoint({
        commitHash: headCommit(repo),
        projectPath: repo,
        stashId: 'stash@{999}',
      });

      const result = await rollbackToCheckpoint(checkpoint.id, 'stash');

      expect(result.success).toBe(false);
      expect(result.action).toBe('stash_pop');
      expect(result.message).toContain('original stash restoration failed');
      expect(result.error).toBeDefined();
    });

    it('returns a failure result for an unknown strategy', async () => {
      const checkpoint = seedCheckpoint({ commitHash: headCommit(repo), projectPath: repo });

      const result = await rollbackToCheckpoint(checkpoint.id, 'bogus_strategy' as unknown as Parameters<
        typeof rollbackToCheckpoint
      >[1]);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Rollback failed');
      expect(result.error).toContain('Unknown rollback strategy');
    });
  });

  describe('cleanupOldCheckpoints', () => {
    it('returns 0 when there are no checkpoints', async () => {
      const deleted = await cleanupOldCheckpoints();

      expect(deleted).toBe(0);
    });

    it('deletes checkpoints older than maxAgeDays and keeps recent ones', async () => {
      const now = Date.now();
      const old = seedCheckpoint({ commitHash: headCommit(repo), createdAt: now - 10 * 24 * 60 * 60 * 1000 });
      const recent = seedCheckpoint({ commitHash: headCommit(repo), createdAt: now });

      const deleted = await cleanupOldCheckpoints(7);

      expect(deleted).toBe(1);
      expect(fsState.has(checkpointPath(old.id))).toBe(false);
      expect(fsState.has(checkpointPath(recent.id))).toBe(true);
    });

    it('leaves invalid checkpoint entries untouched and does not count them', async () => {
      fsState.set(resolve(CHECKPOINT_DIR, 'corrupt.json'), '{ this is not json');

      const deleted = await cleanupOldCheckpoints(0);

      expect(deleted).toBe(0);
      expect(fsState.has(resolve(CHECKPOINT_DIR, 'corrupt.json'))).toBe(true);
    });

    it('ignores non-.json files entirely, never inspecting or deleting them', async () => {
      fsState.set(resolve(CHECKPOINT_DIR, 'README.md'), '# not a checkpoint');

      const deleted = await cleanupOldCheckpoints(0);

      expect(deleted).toBe(0);
      expect(fsState.has(resolve(CHECKPOINT_DIR, 'README.md'))).toBe(true);
    });

    it('returns 0 when the checkpoint directory cannot be prepared', async () => {
      fsMock.mkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const deleted = await cleanupOldCheckpoints();

      expect(deleted).toBe(0);
    });
  });

  describe('listCheckpoints', () => {
    it('returns an empty array when there are no checkpoints', async () => {
      const result = await listCheckpoints();

      expect(result).toEqual([]);
    });

    it('returns checkpoints sorted by createdAt descending and skips invalid entries', async () => {
      fsState.set(resolve(CHECKPOINT_DIR, 'ignored.log'), 'not a checkpoint');
      fsState.set(resolve(CHECKPOINT_DIR, 'broken.json'), '{ invalid');
      const older = seedCheckpoint({ commitHash: headCommit(repo), createdAt: 1000 });
      const newer = seedCheckpoint({ commitHash: headCommit(repo), createdAt: 2000 });

      const result = await listCheckpoints();

      expect(result.map(c => c.id)).toEqual([newer.id, older.id]);
    });

    it('returns an empty array when the checkpoint directory cannot be prepared', async () => {
      fsMock.mkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await listCheckpoints();

      expect(result).toEqual([]);
    });
  });

  describe('getGitStatus', () => {
    it('reports a clean working tree', async () => {
      const status = await getGitStatus(repo);

      expect(status.branch).toBe('main');
      expect(status.commit).toBe(headCommit(repo));
      expect(status.hasChanges).toBe(false);
      expect(status.changedFiles).toEqual([]);
    });

    it('reports changed files when the working tree is dirty', async () => {
      writeFileSync(join(repo, 'new-file.txt'), 'content\n');
      writeFileSync(join(repo, 'file.txt'), 'edited\n');

      const status = await getGitStatus(repo);

      expect(status.hasChanges).toBe(true);
      expect(status.changedFiles.sort()).toEqual(['file.txt', 'new-file.txt']);
    });

    it('falls back to false/[] when "git status" fails but refs still resolve', async () => {
      // `rev-parse HEAD` and `branch --show-current` only touch refs, so they keep
      // working even with a corrupted index; `status --porcelain` needs the index
      // and fails, exercising hasChanges()/getChangedFiles()'s own catch branches.
      writeFileSync(join(repo, '.git', 'index'), 'not-a-valid-index-file');

      const status = await getGitStatus(repo);

      expect(status.branch).toBe('main');
      expect(status.commit).toBe(headCommit(repo));
      expect(status.hasChanges).toBe(false);
      expect(status.changedFiles).toEqual([]);
    });

    it('falls back to "HEAD" as the branch name in detached HEAD state', async () => {
      const commit = headCommit(repo);
      // -c suppresses the noisy "you are in detached HEAD state" advisory on stderr.
      execFileSync('git', ['-c', 'advice.detachedHead=false', 'checkout', commit], { cwd: repo });

      const status = await getGitStatus(repo);

      expect(status.branch).toBe('HEAD');
      expect(status.commit).toBe(commit);
    });
  });
});
