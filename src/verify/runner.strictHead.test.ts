// Created: 2026-11-22
// Purpose: Strict-companion head sandbox is a detached worktree, falls back to a full copy, and is always unregistered (AGT-4785).
// Dependencies: vitest, git, ./runner.js (fake sandboxExecutorSessionFactory, no real companion)
// Test Status: passing

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyCommand } from './manifest.js';
import { runVerify } from './runner.js';

let root: string;
let repo: string;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function verify(run: string): VerifyCommand {
  return { name: 'fixture', run, kind: 'test', timeoutMs: 2_000 };
}

function result(exitCode: number) {
  return { output: `exit-${exitCode}`, exitCode, signal: null, timedOut: false, truncated: false, outputLimitExceeded: false };
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  gitIn(path, 'config', 'user.email', 'test@example.com');
  gitIn(path, 'config', 'user.name', 'Test');
  await writeFile(join(path, 'kept.txt'), 'committed\n');
  await writeFile(join(path, 'deleted.txt'), 'will be deleted\n');
  gitIn(path, 'add', '-A');
  gitIn(path, 'commit', '-q', '-m', 'base');
  gitIn(path, 'gc', '--quiet');
}

interface HeadSnapshot {
  dotGitIsFile: boolean;
  dotGitIsDirectory: boolean;
  gitdir: string;
  hasObjects: boolean;
  /** Object or pack files anywhere under the sandbox root. */
  copiedObjects: string[];
  files: string[];
  kept: string;
  headResolves: boolean;
}

function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    gitIn(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

/** Record the head workspace inside the factory: it is gone once runVerify returns. */
async function snapshot(workspace: string): Promise<HeadSnapshot> {
  const dotGit = await lstat(join(workspace, '.git'));
  return {
    dotGitIsFile: dotGit.isFile(),
    dotGitIsDirectory: dotGit.isDirectory(),
    gitdir: dotGit.isFile() ? (await readFile(join(workspace, '.git'), 'utf8')).trim() : '',
    hasObjects: existsSync(join(workspace, '.git', 'objects')),
    copiedObjects: execFileSync('find', [dirname(workspace), '-path', '*/objects/*', '-type', 'f'], { encoding: 'utf8' })
      .split('\n').filter(Boolean),
    files: (await readdir(workspace)).filter((name) => name !== '.git').sort(),
    kept: await readFile(join(workspace, 'kept.txt'), 'utf8'),
    headResolves: gitSucceeds(workspace, 'cat-file', '-e', 'HEAD:kept.txt'),
  };
}

function strictFactory(exitCode = 0) {
  const heads: HeadSnapshot[] = [];
  const factory = vi.fn(async (workspace: string) => {
    if (workspace.includes('.openswarm-verify-head-')) heads.push(await snapshot(workspace));
    return { execute: vi.fn(async () => result(exitCode)) };
  });
  return { heads, factory };
}

const sandboxEntries = async (scratch: string) =>
  (await readdir(scratch)).filter((name) => name.startsWith('.openswarm-verify-'));
const worktreeCount = (path: string) =>
  gitIn(path, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-strict-head-')));
  repo = join(root, 'repo');
  await initRepo(repo);
  await writeFile(join(repo, 'kept.txt'), 'uncommitted edit\n');
  await unlink(join(repo, 'deleted.txt'));
  await writeFile(join(repo, 'added.txt'), 'untracked\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('strict companion head sandbox (AGT-4785)', () => {
  it('builds the strict head sandbox as a detached worktree instead of a full copy', async () => {
    const { heads, factory } = strictFactory();
    const [evidence] = await runVerify({
      projectPath: repo, commands: [verify('true')], baseRef: 'HEAD',
      sandboxExecutorSessionFactory: factory, sandboxScratchRoot: root,
    });

    expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
    expect(heads).toHaveLength(1);
    const [head] = heads;
    expect(head.dotGitIsFile).toBe(true);
    expect(head.gitdir.startsWith(`gitdir: ${join(repo, '.git', 'worktrees')}/`)).toBe(true);
    expect(head.hasObjects).toBe(false);
    expect(head.copiedObjects).toEqual([]);
    expect(head.headResolves).toBe(true);
    // The overlay mirrors the live tree: the edit, the deletion and the untracked file.
    expect(head.kept).toBe('uncommitted edit\n');
    expect(head.files).toEqual(['added.txt', 'kept.txt']);
    expect(await sandboxEntries(root)).toEqual([]);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('falls back to a full copy when the common git dir is not mountable', async () => {
    // The project is a linked worktree whose common dir lies outside the scratch root.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-strict-main-')));
    try {
      const main = join(outside, 'main');
      await initRepo(main);
      const scratch = join(root, 'scratch');
      const linked = join(scratch, 'linked');
      await mkdir(scratch);
      gitIn(main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
      await writeFile(join(linked, 'kept.txt'), 'linked edit\n');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { heads, factory } = strictFactory();
      try {
        const [evidence] = await runVerify({
          projectPath: linked, commands: [verify('true')], baseRef: 'HEAD',
          sandboxExecutorSessionFactory: factory, sandboxScratchRoot: scratch,
        });
        expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
        const logged = warn.mock.calls.map((call) => call.map(String).join(' '));
        expect(logged.some((line) => line.includes('falls back to a full copy')
          && line.includes('is not mountable by the companion'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
      expect(heads).toHaveLength(1);
      expect(heads[0].dotGitIsDirectory).toBe(true);
      expect(heads[0].hasObjects).toBe(true);
      expect(heads[0].copiedObjects.some((path) => path.endsWith('.pack'))).toBe(true);
      expect(heads[0].headResolves).toBe(true);
      expect(heads[0].kept).toBe('linked edit\n');
      expect(await sandboxEntries(scratch)).toEqual([]);
      // Only main and the linked project: no head worktree was registered or left.
      expect(worktreeCount(main)).toBe(2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes and prunes the head worktree on success, command failure and a thrown error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = (exitCode: number) => {
      const strict = strictFactory(exitCode);
      return {
        heads: strict.heads,
        verdict: runVerify({
          projectPath: repo, commands: [verify('true')], baseRef: 'HEAD',
          sandboxExecutorSessionFactory: strict.factory, sandboxScratchRoot: root,
        }),
      };
    };
    const adminEntries = () => (existsSync(join(repo, '.git', 'worktrees')) ? readdir(join(repo, '.git', 'worktrees')) : []);
    // No fallback means every head below took the worktree path.
    const fellBack = () => warn.mock.calls.some((call) => call.map(String).join(' ').includes('falls back to a full copy'));
    try {
      const passing = run(0);
      expect((await passing.verdict)[0].headStatus).toBe('pass');
      expect(passing.heads.map((head) => head.dotGitIsFile)).toEqual([true]);
      expect(await sandboxEntries(root)).toEqual([]);
      expect(worktreeCount(repo)).toBe(1);

      // A failing head also runs the base worktree; neither may be left behind.
      const failing = run(1);
      expect((await failing.verdict)[0]).toMatchObject({ headStatus: 'fail', baseStatus: 'fail' });
      expect(failing.heads.map((head) => head.dotGitIsFile)).toEqual([true]);
      expect(await sandboxEntries(root)).toEqual([]);
      expect(worktreeCount(repo)).toBe(1);

      // An escaping, non-ignored symlink makes the head build throw after the worktree
      // exists (runVerify reports it as a security failure); unlike a chmod 0 file
      // this also throws under uid 0.
      await symlink('/etc/hostname', join(repo, 'escape.txt'));
      const throwing = run(0);
      expect((await throwing.verdict)[0]).toMatchObject({
        headStatus: 'fail', securityFailure: true, rawOutputTail: expect.stringMatching(/escaping symlink: escape\.txt/),
      });
      expect(throwing.heads).toEqual([]);
      expect(fellBack()).toBe(false);
      expect(await sandboxEntries(root)).toEqual([]);
      expect(worktreeCount(repo)).toBe(1);
      expect(await adminEntries()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
