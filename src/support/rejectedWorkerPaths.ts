/**
 * What the worker-scope fence rejected, remembered until the preserve commit.
 *
 * The fence rejects an out-of-scope edit and the iteration is discarded, but
 * the file it wrote stays on disk — and the next WIP preserve commit stages it
 * onto the branch. Measured twice on cgf-portal AX-1556 (2026-09-18): first a
 * fixture at a doubled `apps/apps/…` path, then an edit to the very contract
 * test whose failure had blocked the two previous attempts, teaching it to
 * `continue` past the dicts it objected to. The first costs an attempt. The
 * second is a silently weakened gate reaching a branch, which is the failure
 * mode the whole guard layer exists to prevent (AGT-4440).
 *
 * Nothing downstream can recognise that file. `isAgentScratchFile` and
 * `isEphemeralWorktreeArtifact` judge by name, extension and mode, and this is
 * a plausible path under a plausible directory. The one thing that knows it is
 * junk is the fence verdict, and that verdict lived only in an error string.
 *
 * ## Why an in-process registry keyed by worktree path
 *
 * `stagePreservableWorktreeChanges(worktreePath)` is the chokepoint all four
 * commit paths share, and it takes only a path — none of its four call sites
 * holds pipeline context to pass down, so carrying the set as an argument
 * would mean changing four signatures and their callers. The set is per-run
 * state, not a process-wide bound, and its failure mode if the process
 * restarts between the worker and the preserve commit is that the entry is
 * lost: back to today's behaviour, never worse.
 *
 * ## Why paths are also un-rejected
 *
 * A path rejected on one iteration may be written legitimately inside scope on
 * a later one — the drafted scope itself drifts (measured 7 → 13 → 9 files for
 * one issue, AGT-4441). A run-wide denylist would silently drop that real
 * work, so `acceptWorkerPaths` removes a path the moment an iteration writes
 * it inside scope. The judgement is per path and per iteration, never run-wide.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

/**
 * Per worktree. Far above the largest scope drift seen (13 files) and far
 * below anything that costs memory; a worker looping on a broken path cannot
 * grow the set without bound.
 */
const MAX_PATHS_PER_WORKTREE = 200;
/**
 * Live worktrees are bounded by the slot count (16). This is the backstop for
 * entries whose release never ran — a crash between the worker and cleanup —
 * so the map cannot grow for the lifetime of the daemon.
 */
const MAX_TRACKED_WORKTREES = 64;

/** Insertion-ordered, so evicting the oldest key is `keys().next()`. */
const rejectedByWorktree = new Map<string, Set<string>>();

/**
 * One canonical spelling for both sides of the comparison.
 *
 * The worker keys on `expandPath(options.projectPath)` and the staging helper
 * on the manager's `worktreePath`; on macOS those differ by the `/var` →
 * `/private/var` symlink alone, and a lookup that misses is a silent no-op
 * rather than an error.
 *
 * Resolved through the deepest ancestor that still exists, not through the
 * path itself: release runs *after* `git worktree remove`, so a plain
 * `realpathSync` would succeed while the directory was there and fall back to
 * an unresolved `resolve` once it was gone — two different keys for the same
 * worktree, and a release that deletes nothing. Anchoring on the ancestor
 * gives the same answer either way.
 */
function key(worktreePath: string): string {
  const absolute = resolve(worktreePath);
  const suffix: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return [realpathSync(probe), ...suffix].join(sep);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute; // Reached the root; nothing resolves.
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
}

/** Record the paths the worker-scope fence just rejected for this worktree. */
export function noteRejectedWorkerPaths(worktreePath: string, paths: string[]): void {
  if (paths.length === 0) return;
  const mapKey = key(worktreePath);
  let set = rejectedByWorktree.get(mapKey);
  if (!set) {
    if (rejectedByWorktree.size >= MAX_TRACKED_WORKTREES) {
      const oldest = rejectedByWorktree.keys().next().value;
      if (oldest !== undefined) rejectedByWorktree.delete(oldest);
    }
    set = new Set<string>();
    rejectedByWorktree.set(mapKey, set);
  }
  for (const path of paths) {
    if (set.size >= MAX_PATHS_PER_WORKTREE) break;
    set.add(path);
  }
}

/**
 * Forget paths this iteration wrote legitimately, inside scope.
 *
 * Without this the fix would drop real work: the scope a task drafts is not
 * stable across iterations, so yesterday's out-of-scope path is today's
 * deliverable.
 */
export function acceptWorkerPaths(worktreePath: string, paths: string[]): void {
  if (paths.length === 0) return;
  const set = rejectedByWorktree.get(key(worktreePath));
  if (!set) return;
  for (const path of paths) set.delete(path);
  if (set.size === 0) rejectedByWorktree.delete(key(worktreePath));
}

/** Paths still standing as rejected for this worktree. */
export function rejectedWorkerPaths(worktreePath: string): string[] {
  return [...(rejectedByWorktree.get(key(worktreePath)) ?? [])];
}

/**
 * Drop the whole entry when the worktree is released, so a recycled path
 * cannot inherit a stale denylist and refuse a later run's real file.
 */
export function releaseRejectedWorkerPaths(worktreePath: string): void {
  rejectedByWorktree.delete(key(worktreePath));
}

/** Test seam only. */
export function resetRejectedWorkerPathsForTests(): void {
  rejectedByWorktree.clear();
}
