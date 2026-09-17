// ============================================
// OpenSwarm — the pair reviewer's verdict, said on the pull request too (AGT-4044)
// ============================================
//
// The pair reviewer's approval used to live only in the Linear issue comment.
// Someone reading the pull request saw no review at all and concluded it was
// merged unreviewed — the audit that filed AGT-4044 did exactly that for two
// of six PRs that had all been reviewed. The PR-time fresh review (AGT-4278)
// now posts its own verdict on every publication; this adds the in-loop
// reviewer's, with who decided and the issue it belongs to, so a PR reader
// never has to open the tracker to know the work was reviewed.

import { commentOnPROrThrow, getPRComments } from '../github/github.js';
import { parsePublishedPullRequest } from './publishedPullRequest.js';
import type { PairCompleteStats } from './taskSource.js';

/** Idempotency marker: one verdict per completion effect, across retries. */
export const PAIR_VERDICT_MARKER_PREFIX = 'openswarm-pair-verdict:';

/** Enough of the reviewer's words to justify the verdict; the issue has the rest. */
const FEEDBACK_EXCERPT_CHARS = 1_500;

export interface PairVerdictTask {
  issueIdentifier?: string;
  issueUrl?: string;
}

export type PairVerdictOutcome = 'posted' | 'duplicate' | 'skipped' | 'failed';

export interface PairVerdictDeps {
  getPRComments: typeof getPRComments;
  commentOnPR: typeof commentOnPROrThrow;
}

function excerpt(feedback: string | undefined): string {
  const text = (feedback ?? '').trim();
  if (!text) return '';
  return text.length > FEEDBACK_EXCERPT_CHARS ? `${text.slice(0, FEEDBACK_EXCERPT_CHARS)}…` : text;
}

/**
 * Render the verdict comment, or null when the completion carries no reviewer
 * decision — a recovered publication (the reconciler's `publication_recovered`)
 * or a run with the reviewer stage off has nothing to say here; the PR-time
 * fresh review speaks for those.
 */
export function pairVerdictComment(stats: PairCompleteStats, task: PairVerdictTask, marker: string): string | null {
  if (!stats.reviewerDecision) return null;
  const issue = task.issueIdentifier
    ? (task.issueUrl ? `[${task.issueIdentifier}](${task.issueUrl})` : task.issueIdentifier)
    : 'the tracker issue';
  const reviewer = stats.reviewerName ? `**Reviewer:** ${stats.reviewerName}` : '**Reviewer:** pair reviewer';
  const body = excerpt(stats.reviewerFeedback);
  return [
    `## 🤝 Pair review — ${stats.reviewerDecision}`,
    '',
    `${reviewer} · **Issue:** ${issue} · **Attempts:** ${stats.attempts}`,
    ...(body ? ['', body] : []),
    '',
    `_In-loop reviewer verdict before publication; the full exchange is on ${issue}._`,
    `<!-- ${PAIR_VERDICT_MARKER_PREFIX}${marker} -->`,
  ].join('\n');
}

/**
 * Post the verdict on the PR the completion names. Best-effort: completion
 * delivery must not fail because GitHub would not take a courtesy comment, and
 * a retry after a crash must not post twice — the marker on the PR is checked
 * before writing, because the tracker-side idempotency fence says nothing
 * about whether THIS side succeeded.
 */
export async function postPairVerdictOnPullRequest(
  stats: PairCompleteStats,
  task: PairVerdictTask,
  marker: string,
  deps: PairVerdictDeps = { getPRComments, commentOnPR: commentOnPROrThrow },
): Promise<PairVerdictOutcome> {
  const body = pairVerdictComment(stats, task, marker);
  const pr = stats.prUrl ? parsePublishedPullRequest(stats.prUrl) : null;
  if (!body || !pr) return 'skipped';
  try {
    const existing = await deps.getPRComments(pr.repo, pr.number);
    const fence = `${PAIR_VERDICT_MARKER_PREFIX}${marker}`;
    if (existing.some((comment) => comment.body.includes(fence))) return 'duplicate';
    await deps.commentOnPR(pr.repo, pr.number, body);
    return 'posted';
  } catch (err) {
    console.warn(`[Runner] Could not post the pair verdict on ${stats.prUrl}:`, err);
    return 'failed';
  }
}
