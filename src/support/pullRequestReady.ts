// ============================================
// OpenSwarm — taking a reused PR out of draft (AGT-4076)
// ============================================
//
// Split out of worktreeManager.ts, which sits on the 1500-line pre-commit cap.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;

/** `gh` always runs with an explicit cwd — see the note on worktreeManager's own
 * helper: a `gh` call without one dies with "fatal: not a git repository" and
 * strands finished work on a pushed branch with no PR. (INT-2321) */
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GH_TIMEOUT_MS });
  return stdout;
}

/**
 * Take a PR out of draft.
 *
 * A run that parks for the operator opens its PR as a draft, because nothing
 * has reviewed it. When that same branch later passes review,
 * `commitAndCreatePR` finds the existing PR and returns it instead of opening a
 * second one — so without this the approved work would ship still marked draft,
 * and nobody would be asked to review it.
 *
 * Throws on failure rather than warning: the approved caller treats a
 * publication failure as retryable `infra_error`, which is the right outcome
 * for "the PR exists but is not actually open for review".
 */
async function markPullRequestReady(worktreePath: string, prUrl: string): Promise<void> {
  const raw = await gh(worktreePath, 'pr', 'view', prUrl, '--json', 'isDraft', '--jq', '.isDraft');
  // `gh pr ready` fails on a PR that is already open for review, and that
  // failure would mark a run that actually succeeded as broken.
  if (raw.trim() !== 'true') return;
  await gh(worktreePath, 'pr', 'ready', prUrl);
  console.log(`[Worktree] Promoted draft PR to ready for review: ${prUrl}`);
}

/**
 * Take a reused PR out of draft when nothing else justifies the draft.
 *
 * Two paths reuse an existing PR instead of creating one — the early return
 * when `pr list` already finds it, and the create-race fallback — and both must
 * apply the same rule, or reviewed work stays hidden as a draft on whichever
 * one was missed.
 *
 * `draft` is not the only reason a PR is one: a PR is also opened draft when
 * another branch already closes the same issue (INT-2544), deliberately, so a
 * duplicate implementation cannot masquerade as the sole one. The caller passes
 * that count so the safeguard survives.
 */
export async function readyReusedPullRequest(
  worktreePath: string,
  prUrl: string,
  issueIdentifier: string,
  duplicateCount: number,
): Promise<void> {
  if (duplicateCount > 0) {
    console.log(`[Worktree] Leaving ${prUrl} as a draft: ${duplicateCount} other PR(s) also close ${issueIdentifier}`);
    return;
  }
  await markPullRequestReady(worktreePath, prUrl);
}
