/**
 * Post a no-verdict reviewer's partial notes on the PR. (AGT-4413)
 *
 * Kept out of prProcessor.ts, which is over the repository's line ceiling.
 */
import { commentOnPROrThrow, getPRComments, type PRInfo } from '../github/index.js';
import { ReviewerNoVerdictError, noDecisionComment } from '../agents/reviewerNoVerdict.js';
import { FEEDBACK_ADDRESSED_MARKERS } from './prReviewComments.js';
import { redactSecrets } from '../support/secretRedaction.js';
import { safeConsole as console } from '../support/safeLog.js';

/** Hidden per-head fence: one "no decision" comment per reviewed head. */
export const NO_DECISION_MARKER_PREFIX = 'openswarm:no-decision:';

export function noDecisionMarker(headSha: string): string {
  return `<!-- ${NO_DECISION_MARKER_PREFIX}${headSha} -->`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Make model-written text safe to post as a PR comment.
 *
 * - Secrets the reviewer may have quoted from files or tool output are redacted.
 * - A FEEDBACK_ADDRESSED_MARKERS string would make getActiveCriticalComments
 *   treat every earlier critical comment as addressed, so a reviewer's notes
 *   (or text it quoted from the diff) could hide them; each is defused.
 * - HTML comments are escaped so the notes cannot carry a forged dedupe fence
 *   or any other hidden marker.
 */
export function sanitizeNoDecisionText(text: string): string {
  let out = redactSecrets(text);
  for (const marker of FEEDBACK_ADDRESSED_MARKERS) {
    out = out.replace(new RegExp(escapeRegExp(marker), 'gi'), (found) => `[status phrase removed: "${found.toLowerCase().replace(/\s+/g, '-')}"]`);
  }
  return out.replace(/<!--/g, '&lt;!--');
}

/**
 * Best-effort: true when the notes are on the PR — posted now, or already
 * posted for this head by an earlier run. Only a `ReviewerNoVerdictError` with
 * text qualifies — a crash, timeout or empty answer has nothing to show, and a
 * failed comment must not change the gate-not-run outcome.
 */
export async function postNoDecisionNotes(
  pr: Pick<PRInfo, 'repo' | 'number'>,
  reviewedSha: string | null,
  err: unknown,
  reason: string,
): Promise<boolean> {
  if (!(err instanceof ReviewerNoVerdictError) || !err.partialText || !reviewedSha) return false;
  const marker = noDecisionMarker(reviewedSha);
  try {
    // A retry of the same head (a re-run of `pr review --fresh`, a daemon
    // retry) must not stack identical "no decision" comments.
    const existing: Array<{ body: string }> = await getPRComments(pr.repo, pr.number).catch(() => []);
    if (existing.some((comment) => comment.body.includes(marker))) return true;
    const body = noDecisionComment({
      reviewedSha,
      reason: sanitizeNoDecisionText(reason),
      partialText: sanitizeNoDecisionText(err.partialText),
    });
    await commentOnPROrThrow(pr.repo, pr.number, `${body}\n\n${marker}`);
    return true;
  } catch (commentErr) {
    console.error(`[PRProcessor] ${pr.repo}#${pr.number} could not post partial review notes:`, commentErr);
    return false;
  }
}
