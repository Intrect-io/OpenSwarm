/**
 * Point-in-time snapshots of a worktree, so a wrong turn can be undone.
 *
 * Nothing rolls back between iterations today, so the loop builds on its own
 * mistakes: on AX-1556 attempt 7 the same blocking guard fired with a
 * byte-identical message at iteration 1 and iteration 2, and the branch carries
 * two `chore:` commits where a person performed the rollback by hand — one of
 * them deleting an `apps/apps/` path a rejected iteration had written.
 *
 * The mechanism is opencode's (`packages/opencode/src/snapshot/index.ts`): a
 * second git directory that shares the real repository's object store through
 * `objects/info/alternates` and records each state as a bare **tree**. No
 * commits, no refs, no index inside the repository under work — the repository
 * is left exactly as found, and an unchanged blob is never copied.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/**
 * git's hash for "a tree with nothing in it".
 *
 * Worth naming because it is what `write-tree` returns when the shadow store is
 * misconfigured — see `ensureSnapshotStore` — and storing it as a snapshot
 * would mean a later restore deletes the entire worktree.
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Snapshots outlive a run this long, so a parked task can still be rolled back. */
export const SNAPSHOT_RETENTION_DAYS = 7;
/** A sweep never touches this window, so a live run keeps its snapshots. */
const PRUNE_SAFETY_WINDOW_MS = 60 * 60_000;

export function snapshotRoot(): string {
  return process.env.OPENSWARM_SNAPSHOT_DIR ?? join(homedir(), '.openswarm', 'snapshots');
}

/** Explicitly disabled with `OPENSWARM_SNAPSHOT=0`; on otherwise. */
export function snapshotEnabled(): boolean {
  return process.env.OPENSWARM_SNAPSHOT !== '0';
}

function safeSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

export function snapshotDir(runId: string): string {
  return join(snapshotRoot(), safeSegment(runId, 'adhoc'));
}

async function git(gitDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--git-dir', gitDir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/**
 * Where the repository actually keeps its objects.
 *
 * A worker runs in a linked worktree, where `<worktree>/.git` is a *file*
 * holding a `gitdir:` pointer and the object store lives in the main checkout.
 * Pointing `alternates` at `<worktree>/.git/objects` would name a path that
 * does not exist, and git would quietly fall back to copying every blob.
 */
async function objectStoreOf(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { timeout: GIT_TIMEOUT_MS },
  );
  return join(stdout.trim(), 'objects');
}

/** What worktree an existing store was built for, or undefined if it has none. */
async function recordedWorktree(shadowDir: string): Promise<string | undefined> {
  const value = await git(shadowDir, 'config', '--get', 'core.worktree').catch(() => '');
  return value.trim() || undefined;
}

/**
 * Create (or reuse) the run's shadow git directory.
 *
 * ⚠️ `git init --bare` sets `core.bare=true`, and a bare repository refuses
 * `core.worktree`: git warns "core.bare and core.worktree do not make sense"
 * and then `write-tree` returns the EMPTY tree rather than failing. Setting
 * `core.bare false` is not tidiness — without it every snapshot silently
 * captures nothing, and the first restore would empty the worktree.
 */
export async function ensureSnapshotStore(runId: string, worktreePath: string): Promise<string> {
  const dir = snapshotDir(runId);
  // A store already here for a DIFFERENT worktree describes a different
  // checkout, and restoring one of its trees would write that repository's
  // files into this one and delete everything else. Discard it rather than
  // re-point it. Seen for real: a unit test using a live run's identifier left
  // a store under that name holding trees of the test's own checkout.
  if (existsSync(join(dir, 'HEAD')) && (await recordedWorktree(dir)) !== worktreePath) {
    await rm(dir, { recursive: true, force: true });
  }
  if (!existsSync(join(dir, 'HEAD'))) {
    await mkdir(dir, { recursive: true });
    await execFileAsync('git', ['init', '--quiet', '--bare', dir], { timeout: GIT_TIMEOUT_MS });
  }
  await git(dir, 'config', 'core.bare', 'false');
  await git(dir, 'config', 'core.worktree', worktreePath);
  await mkdir(join(dir, 'objects', 'info'), { recursive: true });
  await writeFile(join(dir, 'objects', 'info', 'alternates'), `${await objectStoreOf(worktreePath)}\n`, 'utf8');
  return dir;
}

/**
 * Record the worktree's current state and return its tree hash.
 *
 * `add --all` honours `.gitignore`, so `node_modules` and build output cost
 * nothing — and are equally not restored later, which the rollback notice has
 * to say rather than imply a total revert.
 *
 * Deliberately no per-file size cap, unlike opencode's 2 MB one: a file left
 * out of the tree is a file the *restore* deletes, and losing a large artifact
 * an agent legitimately produced is worse than a slower snapshot.
 */
export async function captureSnapshot(runId: string, worktreePath: string): Promise<string> {
  const dir = await ensureSnapshotStore(runId, worktreePath);
  await git(dir, 'add', '--all');
  const tree = (await git(dir, 'write-tree')).trim();
  if (tree === EMPTY_TREE) {
    throw new SnapshotError(
      `snapshot of ${worktreePath} came back empty (${EMPTY_TREE}). The shadow store at ${dir} is `
      + 'misconfigured — check that core.bare is false — and storing this would make a restore '
      + 'delete the worktree.',
    );
  }
  return tree;
}

export interface SnapshotRestore {
  /** Paths the restore changed, as `git diff --name-status` reports them. */
  changed: string[];
  /** Files that existed only after the snapshot and were removed. */
  removed: string[];
}

/**
 * Put the worktree back to `tree`.
 *
 * Three steps, because git alone does not do all of it: load the tree into the
 * shadow index, write that index over the worktree, then delete whatever is
 * present now and was not in the tree. The last one is why a plain checkout is
 * not enough — a file an agent *added* is invisible to a checkout of a tree
 * that never had it.
 */
export async function restoreSnapshot(
  runId: string,
  worktreePath: string,
  tree: string,
): Promise<SnapshotRestore> {
  const dir = await ensureSnapshotStore(runId, worktreePath);
  const changed = await changedSince(dir, tree);

  await git(dir, 'read-tree', tree);
  await git(dir, 'checkout-index', '-a', '-f');

  const listed = await git(dir, 'ls-files', '--others', '--exclude-standard', '-z');
  const removed = listed.split('\0').filter(Boolean);
  for (const file of removed) {
    await rm(join(worktreePath, file), { force: true }).catch(() => undefined);
  }
  await pruneEmptyDirs(worktreePath);
  return { changed, removed };
}

/** What differs between a snapshot and the worktree right now. */
export async function changedSince(shadowDir: string, tree: string): Promise<string[]> {
  const out = await git(shadowDir, 'diff', '--name-status', tree).catch(() => '');
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Per-file `A`/`M`/`D` between two snapshots — free, and the record of one step. */
export async function diffSnapshots(
  runId: string,
  worktreePath: string,
  from: string,
  to: string,
): Promise<string[]> {
  const dir = await ensureSnapshotStore(runId, worktreePath);
  const out = await git(dir, 'diff', '--name-status', from, to).catch(() => '');
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * git tracks files, not directories, so deleting the last file in a directory
 * an agent created leaves the directory behind. AX-1556 left an `apps/apps/`
 * that a person removed by hand; a restore that leaves the shell behind has
 * not really undone the turn.
 */
async function pruneEmptyDirs(root: string): Promise<void> {
  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (entry === '.git') { empty = false; continue; }
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!walk(full)) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== root) {
      try {
        // rmdirSync, not rmSync: `rmSync` without `recursive` throws EISDIR on a
        // directory, and `force` only suppresses ENOENT — so the whole prune
        // failed silently and left the shell behind.
        rmdirSync(dir);
      } catch {
        return false;
      }
    }
    return empty;
  };
  walk(root);
}

/** Called when a run reaches a terminal state. */
export async function clearSnapshots(runId: string): Promise<void> {
  await rm(snapshotDir(runId), { recursive: true, force: true });
}

/**
 * Backstop for runs that never reached a terminal state — killed, abandoned,
 * or parked and forgotten. The safety window keeps a live run's snapshots out
 * of reach of a sweep that lands between two of its iterations.
 */
export function pruneSnapshots(
  retentionDays = SNAPSHOT_RETENTION_DAYS,
  root = snapshotRoot(),
  now = Date.now(),
): number {
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  let runDirs: string[];
  try {
    runDirs = readdirSync(root);
  } catch {
    return 0;
  }
  for (const runDir of runDirs) {
    const full = join(root, runDir);
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime >= cutoff || now - mtime < PRUNE_SAFETY_WINDOW_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}
