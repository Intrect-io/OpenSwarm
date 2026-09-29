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
import { collectTestCaseDeltas, deletedTestNotice } from './deletedTestGuard.js';
import { rollBackReviewedPublication } from './prReviewRollback.js';
import {
  getReviewVerdictStore,
  publicationReviewKey,
  lookupStoredPublication,
  recordStoredVerdict,
  type PublicationReviewOutcome,
  type ReviewVerdictStoreLike,
} from './reviewVerdictStore.js';
import type { DefaultRolesConfig, SecurityAuditConfig } from '../core/types.js';
import type { PublishableResult, PublishableTask } from './publishOnPark.js';

/**
 * PR + head sha pairs already reviewed by this process.
 *
 * A parked run resumes on the same branch, and `commitAndCreatePRWithHead`
 * reuses an open PR rather than opening a second one — so a task that parks
 * five times used to pay five full reviews of an unchanged diff and append up
 * to five byte-identical "did not run" notices. The sha the publication
 * already hands us is the key that makes the work once-per-diff.
 */
const reviewedPublications = new Set<string>();

/** Tests need the once-per-sha memory back at its initial state. */
export function resetReviewedPublicationsForTests(): void {
  reviewedPublications.clear();
}

export interface PublicationReviewHookInput {
  task: PublishableTask;
  result: PublishableResult & { success?: boolean; finalStatus?: string; prUrl?: string };
  roles?: DefaultRolesConfig;
  securityAudit?: SecurityAuditConfig;
  /**
   * Durable memory of reviews this deployment already paid for.
   *
   * Optional so the hook is constructible without a database at all; when
   * absent, the lazily-opened store at the automation database is used, and when
   * THAT cannot be opened the hook simply reviews. A cache that cannot be read
   * must never suppress a review — see reviewVerdictStore.ts.
   */
  verdictStore?: ReviewVerdictStoreLike;
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

/** Say on the PR when a change removes test cases. Best-effort, never fatal. */
async function noteDeletedTests(prUrl: string, worktreePath: string | undefined): Promise<void> {
  if (!worktreePath) return;
  const pr = parsePublishedPullRequest(prUrl);
  if (!pr) return;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const run = async (args: string[]) => (await exec('git', ['-C', worktreePath, ...args])).stdout;
    // Resolved, not hardcoded (INT-2545): `origin/HEAD` is unset on a repo
    // added without a clone and stale after a default-branch rename, and this
    // check failing quietly is this change's own thesis failure.
    const { resolveBaseRef } = await import('../support/worktreeManager.js');
    const base = await resolveBaseRef(worktreePath);
    const finding = await collectTestCaseDeltas(base.ref, run);
    if (finding.removed > 0) await commentOnPR(pr.repo, pr.number, deletedTestNotice(finding));
  } catch (err) {
    console.warn('[Runner] Could not check the change for deleted tests:', err);
  }
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
): (ctx: {
  prUrl: string;
  headSha: string;
  worktreeInfo: { originalPath: string; worktreePath?: string };
}) => Promise<void> {
  const { task, result, roles, securityAudit, rollbackOnRejection, verdictStore } = input;
  return async ({ prUrl, headSha, worktreeInfo }) => {
    // Only the park path may skip on the in-process key. The approved path's
    // whole job is to ACT on the verdict, and this cache remembers "seen", not
    // what was decided — so skipping there disarms the rollback exactly where a
    // reviewer already objected. A rolled-back run resumes the preserved
    // worktree, commits nothing new (the implementation is already there and
    // looks finished), and republishes the same PR at the same sha; a cache hit
    // would then finish it `approved` with the objection unaddressed. That is
    // AGT-4270's failure — a verdict nobody acts on — reintroduced.
    // The durable store below is NOT bound by this restriction, and the reason
    // is the difference between the two caches: it stores the outcome, not
    // "seen", so a hit there re-applies the verdict — rollback and all — instead
    // of skipping past it.
    // Before the review, and outside its try, because it depends on nothing the
    // reviewer produces and must survive a reviewer that times out OR throws.
    // A timeout is exactly the state PR #580 shipped in. Deterministic: "the
    // diff removes tests" is a property of the text.
    await noteDeletedTests(prUrl, worktreeInfo.worktreePath);

    const dedupKey = rollbackOnRejection ? null : `${prUrl}@${headSha}`;
    if (dedupKey) {
      if (reviewedPublications.has(dedupKey)) return;
      reviewedPublications.add(dedupKey);
    }

    // Restart-surviving reuse of an already-computed verdict. The in-process Set
    // above is empty after every daemon restart (the failure census records 141
    // `owner_process_exited` + 157 `shutdown_cancelled`), so a re-park after a
    // redeploy paid again for a diff whose verdict this deployment already had.
    const store = verdictStore ?? getReviewVerdictStore();
    const storeKey = publicationReviewKey({ prUrl, headSha });
    const stored = lookupStoredPublication(store, storeKey);
    let review: PublicationReviewOutcome;
    if (stored) {
      review = stored;
    } else {
      // Loaded on demand: the review pulls in the whole PR processor.
      try {
        const { reviewPublishedPullRequest } = await import('./prPublicationReview.js');
        review = await reviewPublishedPullRequest({
          prUrl, projectPath: worktreeInfo.originalPath, roles, securityAudit,
        });
      } catch (err) {
        // The key goes in before the review so concurrent callers collapse; a
        // review that never produced a verdict must not leave the sha marked
        // done, or the draft is never reviewed and nothing says why.
        if (dedupKey) reviewedPublications.delete(dedupKey);
        throw err;
      }
      // Recorded only once the review produced an outcome, and recorded whole:
      // replaying a partial one would let a rejecting verdict replay as an
      // approve, which is the single direction this must never be wrong in.
      recordStoredVerdict(store, storeKey, review);
    }
    const status = review.success ? 'approved' : review.gateRan ? 'changes requested' : 'did not run';
    broadcastEvent({
      type: 'log',
      data: {
        taskId: task.issueId || task.id,
        stage: 'pr-review',
        line: stored
          // Named as a reuse so the saving is visible on the dashboard instead of
          // being invisible: an operator reading "the review ran" for a review
          // that never ran cannot tell this cache from a broken gate.
          ? `PR-time fresh review ${status} — durable reuse of the recorded verdict for this commit${review.error ? `: ${review.error}` : ''}`
          : `PR-time fresh review ${status}${review.error ? `: ${review.error}` : ''}`,
      },
    });

    // A verdict that was reached but could not be POSTED (`commentOnPROrThrow`
    // refusing after the decision) also leaves the PR without it, and on a
    // draft nothing else records it. Not handled here: `error` carries the
    // reviewer's feedback on a clean rejection too (prProcessor.ts:555), so
    // this layer cannot tell the two apart. Distinguishing them needs a
    // `verdictPosted` flag from the processor — filed rather than guessed.
    if (!review.gateRan) {
      const pr = parsePublishedPullRequest(prUrl);
      // Best-effort, and defensively so. `commentOnPR` swallows today, but a
      // caller whose whole job is a courtesy note must not be the reason a run
      // fails if that ever changes to `commentOnPROrThrow`.
      if (pr) {
        try {
          await commentOnPR(pr.repo, pr.number, couldNotRunNotice(review.error));
        } catch (err) {
          // Mirror of the throw case: a sha left marked done over a PR nobody
          // told anything means the next park says nothing either. On a reuse
          // there is nothing to unmark — the recorded verdict stays valid and
          // the next park reaches this same notice again — so only the
          // in-process key is dropped.
          if (dedupKey) reviewedPublications.delete(dedupKey);
          console.warn('[Runner] Could not post the "review did not run" notice:', err);
        }
      }
      return;
    }
    if (!review.changesRequested || !rollbackOnRejection) return;
    await rollBackReviewedPublication({ prUrl, task, result, error: review.error });
  };
}
