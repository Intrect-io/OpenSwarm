// ============================================
// OpenSwarm — restore the operator's tree after a review (AGT-4291)
// ============================================
//
// `openswarm review` without `--read-only` gives the reviewer bash + edit so it
// can *prove* a defect. That is intentional. What was not intentional is
// leaving those proof edits in the operator's working tree — measured on
// 2026-09-10, a REVISE review rewrote calc.js and walked away, so a later
// commit would have attributed the reviewer's guess to the operator.
//
// Snapshot the full worktree (tracked + untracked) into a git tree object
// before the review, then `read-tree -u --reset` it back afterwards. The
// operator's pre-review dirty state returns; the reviewer's edits do not.
// `git stash` is the wrong tool here: it drops staged hunks and fights with
// an already-dirty tree.

import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

/**
 * Capture the current index + worktree (including untracked files) as a tree
 * OID. Leaves the operator's dirty state in place — only the index is briefly
 * staged and then mixed-reset back.
 */
export function snapshotWorkingTree(cwd: string): string {
  git(cwd, ['add', '-A']);
  const tree = git(cwd, ['write-tree']);
  // Mixed reset: put the index back to HEAD without touching the worktree.
  git(cwd, ['reset', '--mixed', 'HEAD']);
  return tree;
}

/** Put index + worktree back exactly as `snapshotWorkingTree` recorded them. */
export function restoreWorkingTree(cwd: string, treeOid: string): void {
  git(cwd, ['read-tree', '-u', '--reset', treeOid]);
  // Drop reviewer-created untracked files while the snapshot still owns the
  // index (so the operator's previously-untracked files, which are in the
  // tree, are kept). Then mixed-reset so those files become untracked again
  // instead of staying staged.
  git(cwd, ['clean', '-fd']);
  git(cwd, ['reset', '--mixed', 'HEAD']);
}

/**
 * Run `fn` and always restore the pre-call worktree snapshot afterwards.
 * Restoration failures are reported via `onRestoreError` but do not mask the
 * original result or error from `fn`.
 */
export async function withRestoredWorkingTree<T>(
  cwd: string,
  fn: () => Promise<T>,
  onRestoreError?: (err: unknown) => void,
): Promise<T> {
  const tree = snapshotWorkingTree(cwd);
  try {
    return await fn();
  } finally {
    try {
      restoreWorkingTree(cwd, tree);
    } catch (err) {
      onRestoreError?.(err);
    }
  }
}
