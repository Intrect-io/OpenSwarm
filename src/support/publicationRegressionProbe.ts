// ============================================
// OpenSwarm — merged-result revalidation before publish (AGT-4465)
// ============================================
//
// Split out of worktreeManager.ts, which sits on the 1500-line pre-commit cap.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDeterministicTester } from '../agents/deterministicTester.js';
import type { VerifyConfig } from '../core/types.js';

const execFileAsync = promisify(execFile);

/** Wall-clock ceiling for a single git invocation, matching worktreeManager's own. */
const GIT_TIMEOUT_MS = 5 * 60_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Restore the worktree's tracked state after a throwaway probe merge. `merge
 * --abort` first (a no-op error when no merge is in progress), then a hard
 * reset as a safety net — this never runs on the branch actually pushed
 * (that already happened before this is called), only on the local checkout.
 */
async function restoreWorktreeHead(worktreePath: string, originalHeadSha: string): Promise<void> {
  await git(worktreePath, 'merge', '--abort').catch(() => {});
  await git(worktreePath, 'reset', '--hard', originalHeadSha).catch(() => {});
}

/**
 * `probeBaseFreshness` only checks for a textual merge conflict — a base that
 * moved WITHOUT one still looked "safe" and shipped ready, but GitHub's own
 * `pull_request` CI trigger tests `refs/pull/N/merge` (this branch merged into
 * the CURRENT base), not the head commit alone. A sibling PR that changes a
 * function signature this branch's own tests mock — without ever touching a
 * file this branch touched — passes the conflict check and fails only in CI
 * (AGT-4465, cgf-portal AX-1584/PR#586: a sibling merged a `prior=` kwarg onto
 * `build_sales_growth_datasets` while this branch's stale-base tester run kept
 * validating a mock with the old signature).
 *
 * Actually merges the fresh base into a scratch copy of HEAD and re-runs the
 * deterministic verifier against it — the same machinery the tester stage
 * already uses (`runDeterministicTester`), so this costs a pytest/npm-test
 * re-run, never an LLM call. Fails OPEN (returns false = "not regressed") on
 * any probe failure or when the project has no deterministic verify commands
 * to run: this is a new safety net layered onto an existing publish path, and
 * its own unavailability must never make that path less reliable than before.
 */
export async function regressedAgainstFreshBase(
  worktreePath: string,
  baseRef: string,
  originalHeadSha: string,
  verify: VerifyConfig,
): Promise<boolean> {
  // One try/finally around BOTH the merge attempt and the test run: a failed
  // `git merge --no-commit` is not side-effect-free like a bad ref would be —
  // on a genuine conflict it still writes conflict-marked content into
  // tracked files, stages a partial merge, and sets MERGE_HEAD. That can
  // happen even though `probeBaseFreshness` just confirmed a clean
  // `merge-tree`, if a concurrent task's fetch/push against this same shared
  // repo moved `baseRef` again in between. An earlier version of this
  // function returned straight out of a separate try/catch around the merge,
  // skipping `restoreWorktreeHead` entirely in exactly that case (caught in
  // review before this shipped) — merging both steps under one finally
  // means every exit path restores the worktree, not just the common one.
  try {
    await git(worktreePath, 'merge', '--no-commit', '--no-ff', baseRef);
    const result = await runDeterministicTester(worktreePath, verify);
    return result !== null && !result.success;
  } catch {
    return false;
  } finally {
    await restoreWorktreeHead(worktreePath, originalHeadSha);
  }
}
