// Extracted from runnerExecution.ts to stay under its 1500-line pre-commit cap
// (AGT-2908 follow-up). Takes its task source as an explicit parameter, so it
// had no dependency on that file's module-private `taskSource` variable.

import { reviewerFollowupId } from './decompositionIds.js';
import type { ITaskSource } from './taskSource.js';
import type { ReviewResult } from '../agents/agentPair.js';

/**
 * File the reviewer's recommendedActions as follow-ups when it approves
 * (INT-1611 restore / INT-1704). With a `parentIssueId` they become sub-issues;
 * without one (INT-1968) they are created as top-level issues so review can still
 * "just file them" off a non-issue branch. Gated by `autoFile` (default OFF);
 * caps at 10; each create is best-effort (failures logged, never throw).
 * Returns the count filed.
 */
export async function fileReviewerFollowups(
  source: ITaskSource | null,
  parentIssueId: string | null | undefined,
  review: ReviewResult,
  opts: { autoFile?: boolean; projectId?: string; requireApprove?: boolean } = {},
): Promise<number> {
  // Autonomous pipeline files only on approve; the manual `review` command files
  // regardless of decision (requireApprove: false). (INT-1704 / INT-1969)
  const requireApprove = opts.requireApprove ?? true;
  if (!opts.autoFile || !source) return 0;
  if (requireApprove && review.decision !== 'approve') return 0;
  const actions = (review.recommendedActions ?? []).slice(0, 10);
  let filed = 0;
  for (const [index, a] of actions.entries()) {
    const title = `[${a.type}] ${a.title}`;
    const body = a.location
      ? `Follow-up from reviewer.\n\nLocation: ${a.location}`
      : 'Follow-up recommended by the reviewer.';
    try {
      let created: Awaited<ReturnType<ITaskSource['createSubIssue']>>;
      if (parentIssueId) {
        created = await source.createSubIssue(parentIssueId, title, body, {
          priority: 3,
          projectId: opts.projectId,
          idempotencyId: reviewerFollowupId(parentIssueId, index, a),
        });
      } else {
        created = await source.createTask(title, body, opts.projectId);
      }
      if ('error' in created) throw new Error(created.error);
      filed += 1;
    } catch (err) {
      console.error(`[Runner] follow-up issue create failed (${a.title}):`, err);
    }
  }
  return filed;
}
