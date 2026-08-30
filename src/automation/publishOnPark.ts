// ============================================
// OpenSwarm — publishing a finished run's branch (AGT-4076)
// ============================================
//
// Both publication paths a worktree-mode run can take, kept together because
// they share `commitAndCreatePR` and differ only in what the run earned:
//
// - `publishApprovedWork` — the reviewed path. A publication failure is fatal:
//   a run is not deliverable until its branch is reviewable.
// - `publishParkedWork` — a run that stopped for an operator decision. Draft,
//   committed work only, and a failure never changes the park.
//
// Split out of runnerExecution.ts, which sits on the 1500-line pre-commit cap.

import { broadcastEvent } from '../core/eventHub.js';
import { commitAndCreatePRWithHead, type WorktreeInfo } from '../support/worktreeManager.js';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';

/** The fields these paths read; narrower than the full pipeline result. */
interface PublishableResult {
  success?: boolean;
  finalStatus?: string;
  prUrl?: string;
}

/** The fields these paths read off the task. */
interface PublishableTask {
  /** Required: the broadcast events key on `issueId || id`. */
  id: string;
  issueId?: string;
  title: string;
  description?: string;
  issueIdentifier?: string;
}

/**
 * Should a finished run publish the work it already committed?
 *
 * True only when it parked for the operator with a worktree and nothing
 * published yet. Pure so the decision is testable without the runner's
 * singletons and timers.
 */
export function shouldPublishParkedWork(
  hasWorktree: boolean,
  result: PublishableResult,
): boolean {
  return hasWorktree && result.finalStatus === 'waiting_on_operator' && !result.prUrl;
}

/**
 * Publish the branch of a run that stopped for an operator decision.
 *
 * Otherwise the commits sit on a branch that was never pushed: measured on the
 * deployed daemon, 23 commits across six branches with no PR, while the
 * operator was being asked 70 questions about work they could not see. (The
 * operator's own framing: "supersded할거면 PR은 올리고 가라".)
 *
 * Called from the runner rather than from a later sweep. Three commit-gate
 * rounds rejected a sweep for the same reason: a parked run can be resumed and
 * claimed while an out-of-band publish is in flight, and if that publish opened
 * a PR first, the eventual reviewed publication would silently reuse it and
 * ship approved work as a draft. Here the executor still owns the claim, the
 * lease and the worktree, so there is nothing to race.
 */
export async function publishParkedWork(
  worktreeInfo: WorktreeInfo,
  task: PublishableTask,
  durability: ExecutionDurabilityHooks | undefined,
): Promise<void> {
  // The same lease fence the approved path uses. Without it an executor that
  // already lost its claim — expired lease, a newer generation now owning the
  // run — could still push the branch and open a PR for work it no longer
  // speaks for. A refused fence is not an error: the run parks either way.
  const publishAllowed = await durability?.beforePublish() ?? true;
  if (!publishAllowed) {
    console.warn(`[Runner] Parked publication fenced for ${task.issueIdentifier}; leaving the branch unpublished`);
    return;
  }
  try {
    const publication = await commitAndCreatePRWithHead(
      worktreeInfo,
      task.title,
      task.issueIdentifier || '',
      'Published because this run parked for an operator decision, so the work is'
        + ' visible instead of sitting on an unpushed branch. It has not been'
        + ' reviewed — this PR is a draft on purpose.',
      // Draft, and committed work only: nothing reviewed this, and the tree
      // must stay exactly as the worker left it so the resume continues.
      { draft: true, committedOnly: true },
    );
    // The ledger records the PR; the pipeline result deliberately does NOT.
    //
    // `durableRunCoordinator.execute()` classifies any result carrying a prUrl
    // that is not an approved success as `publication_reconcile` and parks it
    // in NEEDS_RECONCILE. Setting it here would convert an operator park —
    // which frees the repository admission slot and resumes on the answer —
    // into a reconcile row that holds a slot until a sweep releases it. That is
    // the phantom-row shape that idled the whole loop on 2026-08-29.
    const { prUrl, headSha } = publication;
    const attached = await durability?.onPublication(prUrl, headSha) ?? true;
    if (attached) {
      console.log(`[Runner] Parked run published as draft for ${task.issueIdentifier}: ${prUrl}`);
    } else {
      console.warn(`[Runner] Parked publication for ${task.issueIdentifier} was not durably attached (lease fence); the PR exists at ${prUrl} and will be reused by branch name`);
    }
  } catch (err) {
    // "No commits to create PR from" is the common, correct outcome — the run
    // parked before committing anything. Nothing here may change the park: the
    // operator still has to answer either way.
    const detail = err instanceof Error ? err.message : String(err);
    if (!/No commits to create PR from/.test(detail)) {
      console.warn(`[Runner] Could not publish parked work for ${task.issueIdentifier}: ${detail}`);
    }
  }
}

/**
 * Publish the branch of a run that passed review.
 *
 * A publication failure is fatal here, unlike the parked path: a worktree-mode
 * run is not deliverable until its branch is remotely reviewable, so the result
 * is turned back into a retryable `infra_error` with the worktree preserved.
 */
export async function publishApprovedWork(
  worktreeInfo: WorktreeInfo | null | undefined,
  task: PublishableTask,
  result: PublishableResult & { success?: boolean; finalStatus?: string; prUrl?: string },
  durability: ExecutionDurabilityHooks | undefined,
): Promise<void> {
  // Create PR (worktree mode + pipeline success = finalStatus 'approved')
  if (worktreeInfo && result.success && result.finalStatus === 'approved') {
    const publishAllowed = await durability?.beforePublish() ?? true;
    if (!publishAllowed) {
      result.success = false;
      result.finalStatus = 'infra_error';
      console.warn(`[Worktree] Publication fenced for ${task.issueIdentifier}; preserving worktree`);
    } else {
      try {
        const publication = await commitAndCreatePRWithHead(
          worktreeInfo,
          task.title,
          task.issueIdentifier || '',
          task.description || '',
        );
        const { prUrl, headSha } = publication;
        result.prUrl = prUrl;
        const publicationRecorded = await durability?.onPublication(prUrl, headSha) ?? true;
        if (!publicationRecorded) {
          throw new Error('Durable lease fence rejected publication attachment');
        }
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR created: ${prUrl}`,
          },
        });
        console.log(`[Runner] PR created for ${task.issueIdentifier}: ${prUrl}`);
      } catch (err) {
        console.error('[Worktree] PR creation failed:', err);
        // A worktree-mode run is not deliverable until the branch is published.
        // Keep it retryable and preserved instead of marking the issue Done with
        // no remotely reviewable artifact.
        result.success = false;
        result.finalStatus = 'infra_error';
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }
  } else if (worktreeInfo) {
    // Log why PR was not created
    const reason = !result.success
      ? `Pipeline failed (${result.finalStatus})`
      : `Unexpected state (success=${result.success}, finalStatus=${result.finalStatus})`;
    console.log(`[Runner] PR not created for ${task.issueIdentifier}: ${reason}`);
  }
}
