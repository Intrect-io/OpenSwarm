// OpenSwarm - Runner parking helpers
// Record operator/sandbox parks, park a run durably for a human, and publish
// the stuck worktree before cleanup. Extracted from autonomousRunner.ts
// (AGT-4867 slice 2); behaviour is unchanged.
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { OPERATOR_PARK_REASON } from '../coordination/operatorAnswers.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { upsertTaskState } from '../taskState/store.js';
import { removePreservedWorktreeAt } from '../support/worktreeManager.js';
import { publishStuckWork } from './publishOnPark.js';

/**
 * Record, or retire, the stand-in park signal for a task whose park cannot be
 * carried by the run ledger.
 *
 * Best effort in both directions, and deliberately so. Failing to record leaves
 * the task on its backoff, which is only a delay. Failing to retire costs at
 * most one early retry, still capped by MAX_RETRY_COUNT — whereas refusing to
 * admit the task until the write succeeds could stall it for good.
 */
export function setOperatorPark(issueId: string, parked: boolean): void {
  try {
    upsertTaskState(issueId, {
      execution: { blockedReason: parked ? OPERATOR_PARK_REASON : undefined },
    } as Parameters<typeof upsertTaskState>[1]);
  } catch (error) { // cxt-ignore: error_swallow — the backoff is the fallback
    console.warn(`[AutonomousRunner] Could not record the operator park for ${issueId}:`, error);
  }
}

export function setSandboxOutcomePark(issueId: string, parked: boolean): void {
  try {
    upsertTaskState(issueId, {
      execution: { blockedReason: parked ? SANDBOX_OUTCOME_UNKNOWN_PARK_REASON : undefined },
    } as Parameters<typeof upsertTaskState>[1]);
  } catch (error) {
    console.warn(`[AutonomousRunner] Could not record sandbox outcome quarantine for ${issueId}:`, error);
  }
}

/**
 * Terminal park: publish the work before freeing the disk.
 *
 * All three terminal parks (sandbox infeasibility, the rejection limit, retry
 * exhaustion) used to commit the partial work to a local branch and delete the
 * worktree, leaving the commits unpushed and invisible. Reaching one of them is
 * the run having built as far as it can and hit the point where the operator
 * has to look, which is exactly when the work should be reviewable.
 *
 * Publication is a hook of the cleanup rather than a call before it so it runs
 * under the same worktree lifecycle lock, after the ownership re-check has
 * proven no resumed worker is still editing the tree, and after the pre-cleanup
 * WIP commit that captures the last of the work.
 *
 * That lock is NOT the durable publication fence, though: it proves no worker
 * is still editing this tree, not that this executor still owns the run. Those
 * are different guarantees, and pushing needs the second one. `ownsRun` carries
 * it — see the call sites, where it is the result of the durable park. Cleanup
 * still runs when it is false; only the push is withheld.
 */
export async function publishAndCleanupStuckWorktree(
  task: TaskItem,
  projectPath: string,
  parkReason: string,
  ownsRun: boolean,
): Promise<string | undefined> {
  let prUrl: string | undefined;
  await removePreservedWorktreeAt(
    projectPath,
    ownsRun
      ? async (ctx) => { prUrl = await publishStuckWork(ctx, task, parkReason); }
      : undefined,
  ).catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
  return prUrl;
}

/**
 * Park the run durably and report whether this executor was the one entitled to.
 *
 * `markNeedsHuman` refuses a row that is in a non-parkable state or still
 * carries an owner or lease, so a `true` here is exactly the proof the
 * publication fence gives the reviewed path: this run is ours, durably parked,
 * and unowned. A stale executor whose claim already ended gets `false` and must
 * not push. With no ledger authority (`mode` off or shadow) there is no durable
 * claim to speak of, and behaviour is what it was before publication existed.
 */
export function parkRunForHuman(
  durableRuns: { isPrimary: boolean; markNeedsHuman(issueId: string, reason: string): boolean },
  issueId: string,
  reason: string,
): boolean {
  if (!durableRuns.isPrimary) return true;
  const parked = durableRuns.markNeedsHuman(issueId, reason);
  if (!parked) {
    console.warn(`[Runner] ${issueId}: durable park refused — not publishing work this executor no longer owns`);
  }
  return parked;
}

/** Tracker-comment section pointing the operator at the published draft. */
export function stuckPullRequestSection(prUrl: string | undefined): string {
  return prUrl
    ? `\n\n**Draft PR with the work so far:** ${prUrl}`
    : '';
}
