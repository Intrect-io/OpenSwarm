// ============================================
// OpenSwarm — what a vanished worktree means for a ledger row
// ============================================

import type { MissingWorktreeDisposition } from './runLedgerMissingWorktree.js';

/**
 * Decide how to reconcile a READY / RETRY_AT / NEEDS_HUMAN row whose recorded
 * worktree no longer exists.
 *
 * - No PR for the branch: nothing was published. A READY row needs a person
 *   (its work vanished before it could run); anything else just drops the
 *   stale pointer.
 * - A PR exists: normally that is a publication the ledger never recorded, so
 *   the row goes to NEEDS_RECONCILE and the artifact reconciler judges it.
 * - EXCEPT a draft PR on a RETRY_AT row (AGT-4664). The runner now publishes a
 *   draft for every run that ends unfinished and then removes its clean tree,
 *   so "PR exists, worktree gone, retry scheduled" is the expected leftover of
 *   the attempt that just ended — not an unrecorded publication. Sending it to
 *   NEEDS_RECONCILE parked the run for a human ("a draft PR of no recorded
 *   cause") and the retry it was owed waited on a free slot to be resumed
 *   (cgf-portal AX-1847, 2026-10-03). The pointer is cleared and the retry
 *   proceeds; the next attempt resumes from the pushed branch and a reviewed
 *   publication promotes the draft.
 *
 *   A sibling PR that already closes the issue keeps the old path: that draft
 *   is deliberate, no retry can make it ready, and the reconciler records it as
 *   delivered instead of burning attempts.
 */
export function missingWorktreeDisposition(input: {
  state: string;
  hasPullRequest: boolean;
  pullRequestIsDraft: boolean;
  siblingPullRequestCount: number;
}): MissingWorktreeDisposition {
  if (!input.hasPullRequest) return input.state === 'READY' ? 'needs_human' : 'clear';
  if (input.pullRequestIsDraft && input.state === 'RETRY_AT' && input.siblingPullRequestCount === 0) return 'clear';
  return 'published';
}
