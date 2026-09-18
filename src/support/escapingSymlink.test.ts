import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSymlinkMode, symlinkTargetEscapes } from './escapingSymlink.js';
import { stagePreservableWorktreeChanges, unstageEscapingSymlinkAdditions } from './worktreeEphemeralOps.js';

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

describe('symlinkTargetEscapes (AGT-4431)', () => {
  const root = '/repo';

  it('treats any absolute target as an escape — it names a path on one machine', () => {
    expect(symlinkTargetEscapes({
      root, linkPath: '/repo/apps/portal/node_modules',
      target: '/Users/unohee/dev/cgf-portal/apps/portal/node_modules',
    })).toBe(true);
  });

  it('accepts a relative target that stays inside the root', () => {
    expect(symlinkTargetEscapes({ root, linkPath: '/repo/apps/web/shared', target: '../../shared' }))
      .toBe(false);
    expect(symlinkTargetEscapes({ root, linkPath: '/repo/docs/readme.md', target: './README.md' }))
      .toBe(false);
  });

  it('rejects a relative target that climbs out', () => {
    expect(symlinkTargetEscapes({ root, linkPath: '/repo/apps/portal/node_modules', target: '../../../shared/node_modules' }))
      .toBe(true);
  });

  it('does not treat a sibling directory with the root as a prefix as inside it', () => {
    expect(symlinkTargetEscapes({ root, linkPath: '/repo/link', target: '../repo-backup/file' }))
      .toBe(true);
  });

  it('accepts a link pointing at the root itself', () => {
    expect(symlinkTargetEscapes({ root, linkPath: '/repo/self', target: '.' })).toBe(false);
  });

  it('names only the symlink git mode', () => {
    expect(isSymlinkMode('120000')).toBe(true);
    expect(isSymlinkMode('100644')).toBe(false);
    expect(isSymlinkMode('160000')).toBe(false);
  });
});

describe('stagePreservableWorktreeChanges — escaping symlinks (AGT-4431)', () => {
  let repo: string;
  let outside: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'openswarm-symlink-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'openswarm-outside-')));
    mkdirSync(join(outside, 'node_modules'));
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'apps', 'portal'), { recursive: true });
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'asset.txt'), 'in repo\n');
    writeFileSync(join(repo, 'apps', 'portal', 'app.ts'), 'export const a = 1;\n');
    // cgf-portal's own pattern: a trailing slash matches a directory, not a link.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('replays the AX-1556 shape: the worker edit is staged, the escaping link is not', async () => {
    writeFileSync(join(repo, 'apps', 'portal', 'app.ts'), 'export const a = 2;\n');
    symlinkSync(join(outside, 'node_modules'), join(repo, 'apps', 'portal', 'node_modules'));

    // The repository's own ignore rule does not cover the link — this is why
    // `git add -A` staged it in the first place.
    expect(() => git(repo, 'check-ignore', '-q', '--', 'apps/portal/node_modules')).toThrow();

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual(['apps/portal/app.ts']);
  });

  it('keeps an in-repo relative link — a repository may track its own links', async () => {
    symlinkSync('../../shared/asset.txt', join(repo, 'apps', 'portal', 'asset.txt'));

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual(['apps/portal/asset.txt']);
  });

  it('leaves an escaping link the branch already tracks alone (AGT-4410)', async () => {
    symlinkSync(join(outside, 'node_modules'), join(repo, 'tracked-link'));
    git(repo, 'add', '-f', 'tracked-link');
    git(repo, 'commit', '-q', '-m', 'the repository tracks this on purpose');
    writeFileSync(join(repo, 'apps', 'portal', 'app.ts'), 'export const a = 3;\n');

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual(['apps/portal/app.ts']);
    expect(git(repo, 'ls-tree', 'HEAD', 'tracked-link')).toContain('120000');
  });

  it('reports every link it dropped, so the branch does not go quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    symlinkSync(join(outside, 'node_modules'), join(repo, 'apps', 'portal', 'node_modules'));
    symlinkSync(outside, join(repo, 'shared', 'vendor'));
    git(repo, 'add', '-A'); // the filter reads the index, so stage first

    const dropped = await unstageEscapingSymlinkAdditions(repo);

    expect(dropped.sort()).toEqual(['apps/portal/node_modules', 'shared/vendor']);
    expect(warn.mock.calls.flat().join(' ')).toContain('escaping symlink');
  });

  it('stages nothing extra when there is no link at all', async () => {
    writeFileSync(join(repo, 'apps', 'portal', 'app.ts'), 'export const a = 4;\n');

    await stagePreservableWorktreeChanges(repo);

    expect(staged(repo)).toEqual(['apps/portal/app.ts']);
    expect(await unstageEscapingSymlinkAdditions(repo)).toEqual([]);
  });
});
