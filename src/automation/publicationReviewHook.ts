// ============================================
// OpenSwarm — PR-time review coverage for every publication, not just some
// ============================================
//
// Measured on vela 2026-09-10 (AGT-4278): of nine published pull requests, two
// carried a reviewer verdict. The gate was not weak, it was narrow — draft
// publications never reached it at all, and the ones that did failed open when
// the reviewer timed out, leaving an unreviewed PR indistinguishable from a
// reviewed one.

import { broadcastEvent } from '../core/eventHub.js';
import { commentOnPR } from '../github/github.js';
import { parsePublishedPullRequest } from './publishedPullRequest.js';
import { rollBackReviewedPublication } from './prReviewRollback.js';
import type { DefaultRolesConfig, SecurityAuditConfig } from '../core/types.js';
import type { PublishableResult, PublishableTask } from './publishOnPark.js';

export interface PublicationReviewHookInput {
  task: PublishableTask;
  result: PublishableResult & { success?: boolean; finalStatus?: string; prUrl?: string };
  roles?: DefaultRolesConfig;
  securityAudit?: SecurityAuditConfig;
  /**
   * Whether a "changes requested" verdict may undo the publication.
   *
   * False for a draft: it is already a draft, the run already parked, and
   * there is nothing to roll back. The verdict is still worth having — it is
   * the starting point for whoever picks the draft up.
   */
  rollbackOnRejection: boolean;
}

/** Why the reviewer produced no verdict, said on the PR instead of only in a log nobody keeps. */
function couldNotRunNotice(error: string | undefined): string {
  return '## 🔍 Fresh review did not run\n\n'
    + 'This pull request was published **without a reviewer verdict**. The review '
    + 'was attempted and failed to produce one, so nothing here has been checked '
    + 'beyond CI.\n\n'
    + `**Reason:** ${error || 'the reviewer produced no parseable verdict'}\n\n`
    + '_An unreviewed publication used to look exactly like a reviewed one; this '
    + 'note exists so it does not._';
}

/**
 * Build the hook that reviews a freshly published pull request.
 *
 * The reviewer's own objection is the only thing that rolls a publication back.
 * `success` is also false when the review merely broke — no diff, a crashed
 * processor, a failure posting the comment after an approval — and none of
 * those say anything about the code. But "it broke" must not be silent either,
 * so a run that produced no verdict says so on the PR.
 */
export function buildPublicationReviewHook(
  input: PublicationReviewHookInput,
): (ctx: { prUrl: string; headSha: string; worktreeInfo: { originalPath: string } }) => Promise<void> {
  const { task, result, roles, securityAudit, rollbackOnRejection } = input;
  return async ({ prUrl, worktreeInfo }) => {
    // Loaded on demand: the review pulls in the whole PR processor.
    const { reviewPublishedPullRequest } = await import('./prPublicationReview.js');
    const review = await reviewPublishedPullRequest({
      prUrl, projectPath: worktreeInfo.originalPath, roles, securityAudit,
    });
    const status = review.success ? 'approved' : review.gateRan ? 'changes requested' : 'did not run';
    broadcastEvent({
      type: 'log',
      data: {
        taskId: task.issueId || task.id,
        stage: 'pr-review',
        line: `PR-time fresh review ${status}${review.error ? `: ${review.error}` : ''}`,
      },
    });

    if (!review.gateRan) {
      const pr = parsePublishedPullRequest(prUrl);
      // Best-effort, and defensively so. `commentOnPR` swallows today, but a
      // caller whose whole job is a courtesy note must not be the reason a run
      // fails if that ever changes to `commentOnPROrThrow`.
      if (pr) {
        try {
          await commentOnPR(pr.repo, pr.number, couldNotRunNotice(review.error));
        } catch (err) {
          console.warn('[Runner] Could not post the "review did not run" notice:', err);
        }
      }
      return;
    }
    if (!review.changesRequested || !rollbackOnRejection) return;
    await rollBackReviewedPublication({ prUrl, task, result, error: review.error });
  };
}
