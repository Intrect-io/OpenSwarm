import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_TREE,
  SnapshotError,
  captureSnapshot,
  clearSnapshots,
  diffSnapshots,
  ensureSnapshotStore,
  pruneSnapshots,
  restoreSnapshot,
  snapshotDir,
} from './worktreeSnapshot.js';

let base: string;
let mainRepo: string;
let worktree: string;
const previous = process.env.OPENSWARM_SNAPSHOT_DIR;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const refCount = () => git(mainRepo, 'for-each-ref').split('\n').filter(Boolean).length;
const looseObjects = () =>
  execFileSync('find', [join(mainRepo, '.git', 'objects'), '-type', 'f'], { encoding: 'utf8' })
    .split('\n').filter((line) => line && !line.includes('/info/')).length;

beforeEach(() => {
  // realpath: on macOS /var is a symlink to /private/var, and git reports the
  // resolved path — an unresolved fixture path would fail the alternates check
  // for a reason that has nothing to do with the code under test.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-snapshot-')));
  process.env.OPENSWARM_SNAPSHOT_DIR = join(base, 'snapshots');
  mainRepo = join(base, 'main');
  worktree = join(base, 'wt');
  mkdirSync(mainRepo);
  git(mainRepo, 'init', '--quiet', '.');
  git(mainRepo, 'config', 'user.email', 't@t');
  git(mainRepo, 'config', 'user.name', 't');
  writeFileSync(join(mainRepo, 'edit.txt'), 'orig\n');
  writeFileSync(join(mainRepo, 'keep.txt'), 'keep\n');
  writeFileSync(join(mainRepo, '.gitignore'), 'ignored/\n');
  git(mainRepo, 'add', '-A');
  git(mainRepo, 'commit', '--quiet', '-m', 'base');
  // A linked worktree, which is what a daemon worker actually runs in: its
  // `.git` is a FILE and its objects live in the main checkout.
  git(mainRepo, 'worktree', 'add', '--quiet', worktree, '-b', 'feature');
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSWARM_SNAPSHOT_DIR;
  else process.env.OPENSWARM_SNAPSHOT_DIR = previous;
  rmSync(base, { recursive: true, force: true });
});

describe('capture', () => {
  it('records a non-empty tree for a linked worktree', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(tree).not.toBe(EMPTY_TREE);
  });

  it('shares the real object store instead of copying it', async () => {
    await ensureSnapshotStore('AX-1', worktree);
    const alternates = readFileSync(
      join(snapshotDir('AX-1'), 'objects', 'info', 'alternates'), 'utf8',
    ).trim();
    // The main checkout's objects — NOT `<worktree>/.git/objects`, which for a
    // linked worktree is not a directory at all.
    expect(alternates).toBe(join(mainRepo, '.git', 'objects'));
    expect(existsSync(alternates)).toBe(true);
  });

  it('refuses an empty tree rather than storing a snapshot that would erase the worktree', async () => {
    // A worktree with nothing in it produces the empty tree, which is also what
    // a misconfigured store returns (`git init --bare` sets core.bare=true,
    // which refuses core.worktree — git warns and write-tree returns this
    // instead of failing). Storing it would make the next restore delete
    // everything, so it is refused either way.
    rmSync(join(worktree, 'edit.txt'));
    rmSync(join(worktree, 'keep.txt'));
    rmSync(join(worktree, '.gitignore'));

    await expect(captureSnapshot('AX-1', worktree)).rejects.toBeInstanceOf(SnapshotError);
    await expect(captureSnapshot('AX-1', worktree)).rejects.toThrow(EMPTY_TREE);
  });

  it('discards a store that was built for a different worktree', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    // The hazard this closes: a run id reused across checkouts — or a test
    // using a live identifier — leaves trees describing the wrong repository,
    // and a restore would write those files here and delete everything else.
    const other = join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '--quiet', '.');
    git(other, 'config', 'user.email', 't@t');
    git(other, 'config', 'user.name', 't');
    writeFileSync(join(other, 'unrelated.txt'), 'different repo\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--quiet', '-m', 'other');

    const reused = await captureSnapshot('AX-1', other);

    expect(reused).not.toBe(tree);
    // The old tree is gone with the store, so it cannot be restored by mistake.
    await expect(restoreSnapshot('AX-1', other, tree)).rejects.toBeTruthy();
  });

  it('leaves the repository under work untouched', async () => {
    const refsBefore = refCount();
    const objectsBefore = looseObjects();
    await captureSnapshot('AX-1', worktree);
    expect(refCount()).toBe(refsBefore);
    expect(looseObjects()).toBe(objectsBefore);
  });
});

describe('restore', () => {
  it('undoes a modification, a deletion and an addition in one pass', async () => {
    const tree = await captureSnapshot('AX-1', worktree);

    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    rmSync(join(worktree, 'keep.txt'));
    writeFileSync(join(worktree, '_apply_edit.py'), 'junk\n');

    const result = await restoreSnapshot('AX-1', worktree, tree);

    expect(git(worktree, 'status', '--short').trim()).toBe('');
    expect(readFileSync(join(worktree, 'edit.txt'), 'utf8')).toBe('orig\n');
    expect(readFileSync(join(worktree, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(worktree, '_apply_edit.py'))).toBe(false);
    expect(result.removed).toContain('_apply_edit.py');
  });

  it('removes the directory a rejected iteration created, not just its files', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    // The AX-1556 case: a doubled-prefix path a person had to delete by hand.
    mkdirSync(join(worktree, 'apps', 'apps'), { recursive: true });
    writeFileSync(join(worktree, 'apps', 'apps', 'dup.txt'), 'x\n');

    await restoreSnapshot('AX-1', worktree, tree);

    expect(existsSync(join(worktree, 'apps'))).toBe(false);
  });

  it('keeps the worktree usable as a git checkout afterwards', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    await restoreSnapshot('AX-1', worktree, tree);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
  });

  it('does not touch ignored files, and says which paths it did change', async () => {
    mkdirSync(join(worktree, 'ignored'), { recursive: true });
    writeFileSync(join(worktree, 'ignored', 'build.js'), 'before\n');
    const tree = await captureSnapshot('AX-1', worktree);

    writeFileSync(join(worktree, 'ignored', 'build.js'), 'after\n');
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');

    const result = await restoreSnapshot('AX-1', worktree, tree);

    // Ignored content survives a restore — the notice must not claim otherwise.
    expect(readFileSync(join(worktree, 'ignored', 'build.js'), 'utf8')).toBe('after\n');
    expect(result.changed.join(' ')).toContain('edit.txt');
    expect(result.changed.join(' ')).not.toContain('ignored/build.js');
  });

  it('adds no refs or objects to the repository under work', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    const refsBefore = refCount();
    const objectsBefore = looseObjects();

    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    await restoreSnapshot('AX-1', worktree, tree);

    expect(refCount()).toBe(refsBefore);
    expect(looseObjects()).toBe(objectsBefore);
  });
});

describe('diffSnapshots', () => {
  it('reports per-file status between two snapshots', async () => {
    const before = await captureSnapshot('AX-1', worktree);
    writeFileSync(join(worktree, 'edit.txt'), 'WRONG\n');
    rmSync(join(worktree, 'keep.txt'));
    writeFileSync(join(worktree, 'added.txt'), 'new\n');
    const after = await captureSnapshot('AX-1', worktree);

    const diff = (await diffSnapshots('AX-1', worktree, before, after)).join('\n');
    expect(diff).toMatch(/M\s+edit\.txt/);
    expect(diff).toMatch(/D\s+keep\.txt/);
    expect(diff).toMatch(/A\s+added\.txt/);
  });

  it('is empty between a snapshot and itself', async () => {
    const tree = await captureSnapshot('AX-1', worktree);
    expect(await diffSnapshots('AX-1', worktree, tree, tree)).toEqual([]);
  });
});

describe('cleanup', () => {
  it('clearSnapshots removes the run store', async () => {
    await captureSnapshot('AX-1', worktree);
    await clearSnapshots('AX-1');
    expect(existsSync(snapshotDir('AX-1'))).toBe(false);
  });

  it('prunes a stale store but spares one touched inside the safety window', async () => {
    const root = join(base, 'snapshots');
    mkdirSync(join(root, 'stale'), { recursive: true });
    mkdirSync(join(root, 'live'), { recursive: true });
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    utimesSync(join(root, 'stale'), longAgo, longAgo);

    expect(pruneSnapshots(7, root)).toBe(1);
    expect(readdirSync(root)).toEqual(['live']);
  });

  it('returns zero when nothing was ever snapshotted', () => {
    expect(pruneSnapshots(7, join(base, 'missing'))).toBe(0);
  });
});
