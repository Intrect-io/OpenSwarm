// ============================================
// OpenSwarm — undo a publication the PR-time review rejected (AGT-4270)
// ============================================

import { convertPRToDraft } from '../github/index.js';
import { broadcastEvent } from '../core/eventHub.js';
import { parsePublishedPullRequest } from './publishedPullRequest.js';

/** Marker on `failureDetail` so the ledger and the retry can recognise this cause. */
export const PR_REVIEW_ROLLBACK_PREFIX = 'pr-review: changes requested';

export interface ReviewedPublicationRollback {
  prUrl: string;
  task: { issueId?: string; id: string; issueIdentifier?: string };
  result: { success?: boolean; finalStatus?: string; failureDetail?: string };
  /** The reviewer's own words, when it gave any. */
  error?: string;
}

/**
 * Undo a publication the PR-time review rejected.
 *
 * The PR and its durable record stay — deleting them would strand the commits
 * and invite a duplicate PR on the next attempt (AGT-4076). What changes is
 * that the run stops counting as delivered: the PR goes back to draft so no
 * one merges it and the swarm's own draft-peer gating sees it, and the result
 * is marked failed so the caller preserves the worktree and the task returns
 * to the queue to be fixed rather than redone from nothing.
 */
export async function rollBackReviewedPublication(input: ReviewedPublicationRollback): Promise<void> {
  const { prUrl, task, result } = input;
  const reason = input.error?.trim() || 'the reviewer asked for changes';
  result.success = false;
  result.finalStatus = 'failed';
  result.failureDetail = `${PR_REVIEW_ROLLBACK_PREFIX}: ${reason}`;

  const pr = parsePublishedPullRequest(prUrl);
  let draftNote = '';
  if (pr) {
    try {
      await convertPRToDraft(pr.repo, pr.number);
      draftNote = ' — PR moved back to draft';
    } catch (err) {
      // Report it: a PR still marked ready after a rejected review is exactly
      // the state this rollback exists to prevent someone merging.
      const detail = err instanceof Error ? err.message : String(err);
      draftNote = ` — could NOT move the PR to draft: ${detail}`;
      console.error(`[Runner] Draft rollback failed for ${task.issueIdentifier ?? task.id}:`, err);
    }
  }
  console.warn(`[Runner] PR-time review rejected ${task.issueIdentifier ?? task.id}: ${reason}${draftNote}`);
  broadcastEvent({
    type: 'log',
    data: { taskId: task.issueId || task.id, stage: 'pr-review', line: `Publication rolled back${draftNote}` },
  });
}
