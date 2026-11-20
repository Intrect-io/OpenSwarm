import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STALE_SANDBOX_AGE_MS, sweepStaleVerifySandboxes, verifySandboxScratchRoots } from './sandboxSweep.js';
import { configureSandboxExecutor, resetSandboxExecutorForTests } from '../sandboxExecutor/runtime.js';

let root: string;
const NOW = Date.UTC(2026, 10, 15, 12);

async function sandbox(name: string, ageMs: number): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, 'worktree', '.git'), { recursive: true });
  await writeFile(join(path, 'worktree', '.git', 'pack'), 'x');
  const at = new Date(NOW - ageMs);
  await utimes(path, at, at);
  return path;
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'osw-sandbox-sweep-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sweepStaleVerifySandboxes', () => {
  it('removes stale head and base sandboxes and keeps fresh ones', async () => {
    const staleHead = await sandbox('.openswarm-verify-head-cSMUrc', DEFAULT_STALE_SANDBOX_AGE_MS + 1);
    const staleBase = await sandbox('.openswarm-verify-base-3zSAeP', 2 * DEFAULT_STALE_SANDBOX_AGE_MS);
    const fresh = await sandbox('.openswarm-verify-head-UY8fMU', 60_000);

    const result = await sweepStaleVerifySandboxes({ root, now: NOW });

    expect(result.removed.sort()).toEqual([staleBase, staleHead].sort());
    expect(result.keptFresh).toBe(1);
    expect(result.failed).toEqual([]);
    expect(existsSync(staleHead)).toBe(false);
    expect(existsSync(staleBase)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('leaves anything that is not a verify sandbox alone', async () => {
    const other = await sandbox('openswarm-verify-trust-abc', DEFAULT_STALE_SANDBOX_AGE_MS * 3);
    const lookalike = await sandbox('.openswarm-verify-head-abc.keep', DEFAULT_STALE_SANDBOX_AGE_MS * 3);
    const result = await sweepStaleVerifySandboxes({ root, now: NOW });
    expect(result.removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
  });

  it('does not follow a symlink that matches the pattern', async () => {
    const target = await mkdtemp(join(tmpdir(), 'osw-sandbox-sweep-target-'));
    try {
      await writeFile(join(target, 'keep'), 'x');
      await symlink(target, join(root, '.openswarm-verify-head-link01'));
      const result = await sweepStaleVerifySandboxes({ root, now: NOW + DEFAULT_STALE_SANDBOX_AGE_MS * 10 });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(target, 'keep'))).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('returns an empty result for a missing root', async () => {
    const result = await sweepStaleVerifySandboxes({ root: join(root, 'missing'), now: NOW });
    expect(result).toEqual({ removed: [], keptFresh: 0, failed: [] });
  });

  it('sweeps the strict sandbox executor roots as well as the temp dir', async () => {
    const strictRoot = join(root, 'work');
    await mkdir(strictRoot);
    try {
      configureSandboxExecutor({
        socketPath: '/run/x.sock', allowedRoots: [strictRoot], connectTimeoutMs: 1, maxRequestBytes: 1,
        maxOutputBytes: 1, maxTimeoutMs: 1, maxConcurrent: 1,
      });
      expect(verifySandboxScratchRoots()).toEqual([tmpdir(), strictRoot]);
    } finally {
      resetSandboxExecutorForTests();
    }
    expect(verifySandboxScratchRoots()).toEqual([tmpdir()]);

    const inTmp = await sandbox('.openswarm-verify-head-tmp001', DEFAULT_STALE_SANDBOX_AGE_MS + 1);
    const strict = join(strictRoot, '.openswarm-verify-base-wrk001');
    await mkdir(strict);
    await utimes(strict, new Date(NOW - 2 * DEFAULT_STALE_SANDBOX_AGE_MS), new Date(NOW - 2 * DEFAULT_STALE_SANDBOX_AGE_MS));
    const result = await sweepStaleVerifySandboxes({ roots: [root, strictRoot], now: NOW });
    expect(result.removed.sort()).toEqual([inTmp, strict].sort());
  });

  it('removes a sandbox holding the uv cache overlay\'s mode-000 work dir', async () => {
    const path = await sandbox('.openswarm-verify-head-ovl001', DEFAULT_STALE_SANDBOX_AGE_MS + 1);
    await mkdir(join(path, 'uv-cache', 'work', 'work'), { recursive: true });
    await chmod(join(path, 'uv-cache', 'work', 'work'), 0o000);
    await utimes(path, new Date(NOW - 2 * DEFAULT_STALE_SANDBOX_AGE_MS), new Date(NOW - 2 * DEFAULT_STALE_SANDBOX_AGE_MS));
    const result = await sweepStaleVerifySandboxes({ root, now: NOW });
    expect(result).toMatchObject({ removed: [path], failed: [] });
    expect(existsSync(path)).toBe(false);
  });

  describe('a base sandbox preserved after `git worktree remove` failed', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    async function repoWithCommit(name: string): Promise<string> {
      const repo = join(root, name);
      await mkdir(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
      return repo;
    }
    const age = async (path: string) => {
      const at = new Date(NOW - 2 * DEFAULT_STALE_SANDBOX_AGE_MS);
      await utimes(path, at, at);
    };

    it('is deleted and its repository worktree entry pruned', async () => {
      const repo = await repoWithCommit('repo');
      const base = join(root, '.openswarm-verify-base-prn001');
      await mkdir(base);
      git(repo, 'worktree', 'add', '-q', '--detach', join(base, 'worktree'));
      await age(base);
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(base);

      const result = await sweepStaleVerifySandboxes({ root, now: NOW });

      expect(result).toMatchObject({ removed: [base], failed: [] });
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(base);
    });

    it('does not prune a repository named only by a pointer the sandbox could have forged', async () => {
      const victim = await repoWithCommit('victim');
      const elsewhere = join(root, 'victim-wt');
      git(victim, 'worktree', 'add', '-q', '--detach', elsewhere);
      await rm(elsewhere, { recursive: true, force: true }); // now prunable, so a prune would show
      const forged = join(root, '.openswarm-verify-base-frg001');
      await mkdir(join(forged, 'worktree'), { recursive: true });
      await writeFile(join(forged, 'worktree', '.git'), `gitdir: ${join(victim, '.git', 'worktrees', 'victim-wt')}\n`);
      await age(forged);

      const result = await sweepStaleVerifySandboxes({ root, now: NOW });

      expect(result).toMatchObject({ removed: [forged], failed: [] });
      expect(git(victim, 'worktree', 'list', '--porcelain')).toContain(elsewhere);
    });
  });
});
