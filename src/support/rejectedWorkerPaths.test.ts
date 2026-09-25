import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkerPaths,
  noteRejectedWorkerPaths,
  rejectedWorkerPaths,
  releaseRejectedWorkerPaths,
  resetRejectedWorkerPathsForTests,
} from './rejectedWorkerPaths.js';
import { stagePreservableWorktreeChanges, unstageRejectedWorkerAdditions } from './worktreeEphemeralOps.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function staged(cwd: string): string[] {
  return git(cwd, '-c', 'core.quotepath=false', 'diff', '--cached', '--name-only')
    .split('\n').filter(Boolean).sort();
}

describe('the rejected-path registry (AGT-4440)', () => {
  beforeEach(() => resetRejectedWorkerPathsForTests());

  it('remembers what the fence rejected for one worktree', () => {
    noteRejectedWorkerPaths('/w/a', ['apps/apps/x.json']);
    noteRejectedWorkerPaths('/w/b', ['other.py']);
    expect(rejectedWorkerPaths('/w/a')).toEqual(['apps/apps/x.json']);
    expect(rejectedWorkerPaths('/w/b')).toEqual(['other.py']);
  });

  it('forgets a path once an iteration writes it legitimately inside scope', () => {
    // The drafted scope drifts across iterations (measured 7 → 13 → 9 files for
    // one issue), so yesterday's out-of-scope path is today's deliverable. A
    // run-wide denylist would drop real work.
    noteRejectedWorkerPaths('/w/a', ['apps/portal/x.ts', 'apps/apps/x.json']);
    acceptWorkerPaths('/w/a', ['apps/portal/x.ts']);
    expect(rejectedWorkerPaths('/w/a')).toEqual(['apps/apps/x.json']);
  });

  it('keys on one canonical spelling, so the worker and the staging helper agree', () => {
    // The worker keys on `expandPath(projectPath)` and the staging helper on
    // the manager's `worktreePath`; on macOS those differ by the /var →
    // /private/var symlink alone, and a missed lookup is a silent no-op.
    const real = mkdtempSync(join(tmpdir(), 'osw-rejected-key-'));
    try {
      noteRejectedWorkerPaths(real, ['a.json']);
      expect(rejectedWorkerPaths(realpathSync(real))).toEqual(['a.json']);
      expect(rejectedWorkerPaths(`${real}/./`)).toEqual(['a.json']);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('drops the entry on release, so a recycled path inherits no stale denylist', () => {
    noteRejectedWorkerPaths('/w/a', ['x.json']);
    releaseRejectedWorkerPaths('/w/a');
    expect(rejectedWorkerPaths('/w/a')).toEqual([]);
  });

  it('releases the entry even though the directory is gone by then', () => {
    // Release runs after `git worktree remove`, and on macOS the un-resolved
    // spelling of a tmp path differs from its realpath by the /var →
    // /private/var symlink. Keying on the path itself therefore produced one
    // key while the worktree existed and another once it did not, and the
    // release deleted nothing — a recycled path would inherit the denylist and
    // silently unstage a later run's real file.
    const parent = mkdtempSync(join(tmpdir(), 'osw-rejected-gone-'));
    const worktree = join(parent, 'worktree', 'AX-1');
    mkdirSync(worktree, { recursive: true });
    try {
      // Noted under the spelling the worker would use, while it exists.
      noteRejectedWorkerPaths(worktree, ['apps/apps/x.json']);
      expect(rejectedWorkerPaths(worktree)).toEqual(['apps/apps/x.json']);

      rmSync(worktree, { recursive: true, force: true });
      releaseRejectedWorkerPaths(worktree);

      // Recreated at the same path: a fresh run must see an empty denylist.
      mkdirSync(worktree, { recursive: true });
      expect(rejectedWorkerPaths(worktree)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('bounds both the paths per worktree and the worktrees tracked', () => {
    noteRejectedWorkerPaths('/w/a', Array.from({ length: 500 }, (_, i) => `f${i}.txt`));
    expect(rejectedWorkerPaths('/w/a')).toHaveLength(200);
    for (let i = 0; i < 70; i += 1) noteRejectedWorkerPaths(`/w/x${i}`, ['f.txt']);
    // The oldest entries were evicted rather than accumulating for the life of
    // the daemon; the newest is still there.
    expect(rejectedWorkerPaths('/w/x69')).toEqual(['f.txt']);
    expect(rejectedWorkerPaths('/w/x0')).toEqual([]);
  });

  it('accepting a path for an untracked worktree is a no-op, not a throw', () => {
    expect(() => acceptWorkerPaths('/w/never-seen', ['a.txt'])).not.toThrow();
  });
});

describe('the preserve commit leaves a rejected iteration out (AGT-4440)', () => {
  let repo: string;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    resetRejectedWorkerPathsForTests();
    warn.mockClear();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'osw-rejected-repo-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, 'apps', 'portal', 'test', 'fixtures'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** The measured AX-1556 shape: a fixture written to a doubled `apps/apps/…` path. */
  function writeTheAx1556Shape(): { stray: string; real: string } {
    const stray = 'apps/apps/portal/test/fixtures/canonical-mutation-contracts.json';
    const real = 'apps/portal/test/fixtures/canonical-mutation-contracts.json';
    mkdirSync(join(repo, 'apps', 'apps', 'portal', 'test', 'fixtures'), { recursive: true });
    writeFileSync(join(repo, stray), '{"stray":true}\n');
    writeFileSync(join(repo, real), '{"real":true}\n');
    return { stray, real };
  }

  it('keeps the doubled-prefix fixture off the branch and stages the real one', async () => {
    const { stray, real } = writeTheAx1556Shape();
    noteRejectedWorkerPaths(repo, [stray]);

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual([real]);
    expect(warn.mock.calls.flat().join(' ')).toContain(stray);
  });

  it('stages a path that was rejected once and then written inside scope', async () => {
    // Without this the fix silently deletes real work on the iteration that
    // finally gets the path right.
    const { real } = writeTheAx1556Shape();
    noteRejectedWorkerPaths(repo, [real]);
    acceptWorkerPaths(repo, [real]);

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toContain(real);
  });

  it('leaves a modification to a file the branch already tracks alone', async () => {
    // AGT-4410's rule: a tracked path is the repository's own file, so a
    // rejected-looking name must not revert a real edit. This is the
    // contract-test case — the second AX-1556 instance edited a tracked file.
    const tracked = 'apps/pipelines/tests/test_contracts.py';
    mkdirSync(join(repo, 'apps', 'pipelines', 'tests'), { recursive: true });
    writeFileSync(join(repo, tracked), 'def test_x():\n    assert True\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add the contract test');

    writeFileSync(join(repo, tracked), 'def test_x():\n    assert False\n');
    noteRejectedWorkerPaths(repo, [tracked]);

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual([tracked]);
  });

  it('is a no-op when the fence rejected nothing', async () => {
    writeFileSync(join(repo, 'apps', 'portal', 'a.ts'), 'export const a = 1;\n');
    expect(await unstageRejectedWorkerAdditions(repo)).toEqual([]);
    await stagePreservableWorktreeChanges(repo);
    expect(staged(repo)).toEqual(['apps/portal/a.ts']);
  });

  it('ignores a rejected path this iteration never wrote', async () => {
    writeFileSync(join(repo, 'apps', 'portal', 'a.ts'), 'export const a = 1;\n');
    noteRejectedWorkerPaths(repo, ['apps/apps/gone.json']);
    await stagePreservableWorktreeChanges(repo);
    expect(staged(repo)).toEqual(['apps/portal/a.ts']);
  });
});
