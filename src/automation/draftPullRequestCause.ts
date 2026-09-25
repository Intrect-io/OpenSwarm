// ============================================
// OpenSwarm — why a published PR is a draft, for the reconciler (AGT-4272)
// ============================================

/** Marker on `failureDetail` so the ledger and the retry can recognise a PR-time review rejection. */
export const PR_REVIEW_ROLLBACK_PREFIX = 'pr-review: changes requested';

/**
 * `lastErrorCode` a run carries into NEEDS_RECONCILE when its publication was
 * rolled back by the PR-time review. The coordinator writes it in place of the
 * generic `publication_reconcile` so the reconciler can tell this draft from
 * the other kinds without asking GitHub.
 */
export const PR_REVIEW_ROLLBACK_CODE = 'pr_review_rollback';

/**
 * The three reasons a run's PR is a draft when the reconciler finds it, and
 * what each one means for the run:
 *
 * - `review_rollback`: the PR-time review asked for changes and moved the PR
 *   back to draft (AGT-4270). Fix and retry — the run goes back to the queue.
 * - `duplicate_implementation`: another branch already closes the same issue,
 *   so the publication opened as a draft on purpose (INT-2544) and stays one
 *   even when reused. The work is delivered; re-running it only burns attempts
 *   against a PR that can never become ready.
 * - `parked_publication`: neither of the above — a run that parked for a human
 *   and published for visibility, or a PR held as a draft for a base conflict.
 *   Nobody accepted it and nobody rejected it; a human is the one to look.
 */
export type DraftPullRequestCause = 'review_rollback' | 'duplicate_implementation' | 'parked_publication';

/** Whether a pipeline result's `failureDetail` is the review rollback's marker. */
export function isReviewRollbackDetail(failureDetail: string | undefined): boolean {
  return failureDetail?.startsWith(PR_REVIEW_ROLLBACK_PREFIX) ?? false;
}

/**
 * Classify a draft PR from what the ledger and GitHub say about it. The
 * ledger's own word comes first: a rollback code is the run saying why, while
 * the sibling count is only an inference from a PR-body search.
 */
export function draftPullRequestCause(
  lastErrorCode: string | undefined,
  siblingPullRequests: number,
): DraftPullRequestCause {
  if (lastErrorCode === PR_REVIEW_ROLLBACK_CODE) return 'review_rollback';
  if (siblingPullRequests > 0) return 'duplicate_implementation';
  return 'parked_publication';
}
