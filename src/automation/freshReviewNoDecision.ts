/**
 * Post a no-verdict reviewer's partial notes on the PR. (AGT-4413)
 *
 * Kept out of prProcessor.ts, which is over the repository's line ceiling.
 */
import { commentOnPROrThrow, type PRInfo } from '../github/index.js';
import { ReviewerNoVerdictError, noDecisionComment } from '../agents/reviewerNoVerdict.js';
import { safeConsole as console } from '../support/safeLog.js';

/**
 * Best-effort: true when the comment was posted. Only a `ReviewerNoVerdictError`
 * with text qualifies — a crash, timeout or empty answer has nothing to show,
 * and a failed comment must not change the gate-not-run outcome.
 */
export async function postNoDecisionNotes(
  pr: Pick<PRInfo, 'repo' | 'number'>,
  reviewedSha: string | null,
  err: unknown,
  reason: string,
): Promise<boolean> {
  if (!(err instanceof ReviewerNoVerdictError) || !err.partialText || !reviewedSha) return false;
  try {
    await commentOnPROrThrow(pr.repo, pr.number, noDecisionComment({ reviewedSha, reason, partialText: err.partialText }));
    return true;
  } catch (commentErr) {
    console.error(`[PRProcessor] ${pr.repo}#${pr.number} could not post partial review notes:`, commentErr);
    return false;
  }
}
