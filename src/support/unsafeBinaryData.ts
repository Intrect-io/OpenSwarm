// ============================================
// OpenSwarm — the unsafe binary-data guard (INT-2430)
// ============================================
//
// When a worker hits a permission error running `git status` on an LFS-tracked
// repo, it can work around it with `-c filter.lfs.clean= -c filter.lfs.smudge=`.
// That makes every already-smudged LFS binary (real content on disk) look
// "modified" against its pointer, and the worker mistakes them for its own
// changes — the subsequent `git add -A` (worker's or ours, right before commit)
// stages them for real. An automated code-change commit has no legitimate reason
// to touch a data dump, so these extensions are excluded outright regardless of
// *why* they ended up staged. Real incident: PR #213/STONKS committed
// nas_data/fnguide/*.duckdb and models/validated_features/*.parquet this way —
// reverted by hand.
//
// Split out of worktreeManager.ts, which sits on the 1500-line pre-commit cap.
// It owns its own git invocation rather than importing one, so that this module
// stays a leaf and worktreeManager can depend on it without a cycle.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60_000;

export const UNSAFE_BINARY_DATA_RE = /\.(duckdb|parquet|pkl|pt)$/i;

/** Sentinel returned when a branch could not be judged, so a caller gating a
 *  push on the result fails closed instead of publishing something unchecked. */
export const UNRESOLVED_BASE = '<unresolved base>';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

function toLines(out: string): string[] {
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Unstage any staged file matching an unsafe binary-data extension so it can
 *  never reach the commit. Best-effort — a failed unstage is logged, not thrown,
 *  since letting the binary through would be strictly worse. */
export async function guardUnsafeBinaryStaging(worktreePath: string): Promise<void> {
  const staged = toLines(await git(worktreePath, 'diff', '--cached', '--name-only').catch(() => ''));
  const unsafe = staged.filter((f) => UNSAFE_BINARY_DATA_RE.test(f));
  if (unsafe.length === 0) return;

  console.warn(
    `[Worktree] Unstaging ${unsafe.length} binary data file(s) matching .duckdb/.parquet/.pkl/.pt — ` +
    `automated commits never intentionally touch these (INT-2430): ${unsafe.join(', ')}`,
  );
  for (const file of unsafe) {
    await git(worktreePath, 'reset', 'HEAD', '--', file).catch((e) =>
      console.warn(`[Worktree] Failed to unstage ${file}:`, e),
    );
  }
}

/**
 * Unsafe binary data already committed on this branch but absent from its base.
 *
 * The staging guard above only sees a staged tree, so it cannot help a branch
 * whose commits were made elsewhere — notably the pre-cleanup WIP commit, which
 * runs no guard on purpose because unstaging there would strip a file from the
 * only copy that outlives the worktree. Gate the *push* on this instead.
 */
export async function unsafeBinaryDataOnBranch(worktreePath: string, baseRef: string): Promise<string[]> {
  try {
    const files = toLines(await git(worktreePath, 'diff', '--name-only', `${baseRef}...HEAD`));
    return files.filter((f) => UNSAFE_BINARY_DATA_RE.test(f));
  } catch {
    return [UNRESOLVED_BASE];
  }
}
