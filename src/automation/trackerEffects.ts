// ============================================
// OpenSwarm - Tracker outbox effect contract (INT-3387)
// ============================================
//
// The durable run ledger stores tracker side effects (Done transition,
// completion comment, cancellation comment) as outbox rows that ANY primary
// process may deliver later — the daemon after a restart, or the standalone
// `openswarm work` CLI. The marker/payload wire shape below IS that contract:
// an effect another process cannot parse becomes a dead-letter. These helpers
// were extracted verbatim from AutonomousRunner's private methods so the daemon
// and the CLI share one implementation and cannot drift.

import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { EffectClaim, EffectInput } from './runLedger.js';
import type { ITaskSource, PairCompleteStats } from './taskSource.js';
import {
  projectCancellationState,
  projectSuccessState,
  reconcileCompletionState,
  syncCancellationState,
} from './runnerExecution.js';
import { buildTaskStateSyncComment } from '../taskState/store.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';

export interface CompletionEffectPayload {
  version: 1;
  marker: string;
  task: TaskItem;
  stats: PairCompleteStats;
  projectPath?: string;
  costUsd?: number;
}

export interface CancellationEffectPayload {
  version: 1;
  marker: string;
  task: TaskItem;
  /** Frozen at effect creation so retries reuse the same idempotent comment. */
  comment: string;
}

export interface IntegrationRequeueEffectPayload {
  version: 1;
  marker: string;
  issueId: string;
  comment: string;
}

export function isCompletionEffectPayload(value: unknown): value is CompletionEffectPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<CompletionEffectPayload>;
  return payload.version === 1
    && typeof payload.marker === 'string'
    && !!payload.task
    && typeof payload.task === 'object'
    && !!payload.stats
    && typeof payload.stats === 'object';
}

export function isCancellationEffectPayload(value: unknown): value is CancellationEffectPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<CancellationEffectPayload>;
  return payload.version === 1
    && typeof payload.marker === 'string'
    && !!payload.task
    && typeof payload.task === 'object'
    && typeof payload.comment === 'string';
}

export function isIntegrationRequeueEffectPayload(value: unknown): value is IntegrationRequeueEffectPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<IntegrationRequeueEffectPayload>;
  return payload.version === 1
    && typeof payload.marker === 'string'
    && typeof payload.issueId === 'string'
    && typeof payload.comment === 'string';
}

export function completionStats(result: PipelineResult): PairCompleteStats {
  return {
    attempts: result.iterations,
    duration: Math.floor(result.totalDuration / 1000),
    filesChanged: result.workerResult?.filesChanged || [],
    workerSummary: result.workerResult?.summary,
    workerName: result.workerResult?.codename,
    workerUsage: result.workerResult?.costInfo,
    workerCommands: result.workerResult?.commands,
    reviewerFeedback: result.reviewResult?.feedback,
    reviewerDecision: result.reviewResult?.decision,
    reviewerName: result.reviewResult?.codename,
    reviewerUsage: result.reviewResult?.costInfo,
    testResults: result.testerResult ? {
      passed: result.testerResult.testsPassed,
      failed: result.testerResult.testsFailed,
      coverage: result.testerResult.coverage,
      failedTests: result.testerResult.failedTests,
    } : undefined,
  };
}

export function buildCompletionEffect(task: TaskItem, result: PipelineResult, attemptNo: number): EffectInput {
  const marker = `complete:${task.issueId || task.id}:attempt:${attemptNo}`;
  const payload: CompletionEffectPayload = {
    version: 1,
    marker,
    task,
    stats: { ...completionStats(result), idempotencyMarker: marker },
    projectPath: result.taskContext?.projectPath,
    costUsd: result.totalCost?.costUsd,
  };
  return { kind: 'tracker.complete', dedupeKey: marker, payload };
}

export function buildCancellationEffect(task: TaskItem, attemptNo: number): EffectInput {
  const marker = `cancel:${task.issueId || task.id}:attempt:${attemptNo}`;
  const state = projectCancellationState(task);
  const payload: CancellationEffectPayload = {
    version: 1,
    marker,
    task,
    comment: state
      ? `${buildTaskStateSyncComment(state, 'Task cancelled')}\n\n<!-- openswarm-effect:${marker} -->`
      : `Task cancelled\n\n<!-- openswarm-effect:${marker} -->`,
  };
  return { kind: 'tracker.cancel', dedupeKey: marker, payload };
}

export function buildIntegrationRequeueEffect(
  issueId: string,
  marker: string,
  comment: string,
): EffectInput {
  const payload: IntegrationRequeueEffectPayload = {
    version: 1,
    marker,
    issueId,
    comment: `${comment}\n\n<!-- openswarm-effect:${marker} -->`,
  };
  return { kind: 'tracker.integration_requeue', dedupeKey: marker, payload };
}

/**
 * Deliver one claimed tracker effect. Shared by the daemon's outbox drain and
 * the `openswarm work` CLI so both apply the exact same idempotent transition:
 * marker-comment dedupe first, then either the full completion log or a bare
 * Done reconciliation, then local state/dependency reconciliation.
 */
export async function deliverTrackerEffect(effect: EffectClaim, source: ITaskSource | null): Promise<void> {
  if (effect.kind === 'tracker.integration_requeue') {
    if (!isIntegrationRequeueEffectPayload(effect.payload)) {
      throw new Error(`Invalid automation effect payload: ${effect.kind}`);
    }
    if (!source) throw new Error('Task source unavailable for outbox delivery');
    const payload = effect.payload;
    const comments = source.getExecutionComments
      ? await source.getExecutionComments(payload.issueId)
      : [];
    const markerComment = `<!-- openswarm-effect:${payload.marker} -->`;
    if (!comments.some((comment) => comment.body.includes(markerComment))) {
      await source.addComment(payload.issueId, payload.comment, payload.marker);
    }

    // Evidence is the idempotency fence for the following state transition.
    // Write it first, then inspect the live tracker state: if this process
    // crashes after Todo succeeds but before the outbox ack, a retry observes
    // Todo and must not overwrite a worker/human claim made in the meantime.
    const lookup = await source.lookupIssueState(payload.issueId);
    if (!lookup.ok) throw new Error(`Could not refresh tracker state for ${payload.issueId}: ${lookup.error}`);
    if (!lookup.issue) throw new Error(`Tracker issue disappeared during Todo reconciliation: ${payload.issueId}`);
    const normalizedState = lookup.issue.state.trim().toLowerCase().replaceAll('_', ' ');
    if (normalizedState === 'todo') return;
    if (lookup.issue.stateType === 'started'
      || lookup.issue.stateType === 'canceled'
      || normalizedState === 'in progress'
      || normalizedState === 'in review'
      || normalizedState === 'cancelled'
      || normalizedState === 'canceled') {
      throw new Error(
        `Refusing Todo reconciliation for ${payload.issueId}; tracker moved to ${lookup.issue.state}`,
      );
    }
    const accepted = await source.updateState(payload.issueId, 'Todo');
    if (!accepted) throw new Error(`Tracker refused Todo reconciliation for ${payload.issueId}`);
    return;
  }
  if (effect.kind === 'tracker.cancel') {
    if (!isCancellationEffectPayload(effect.payload)) {
      throw new Error(`Invalid automation effect payload: ${effect.kind}`);
    }
    await syncCancellationState(
      effect.payload.task,
      effect.dedupeKey,
      effect.payload.comment,
    );
    return;
  }
  if (effect.kind !== 'tracker.complete' || !isCompletionEffectPayload(effect.payload)) {
    throw new Error(`Unsupported automation effect: ${effect.kind}`);
  }
  const payload = effect.payload;
  if (!source) throw new Error('Task source unavailable for outbox delivery');
  const issueId = payload.task.issueId || payload.task.id;
  const markerComment = `<!-- openswarm-effect:${payload.marker} -->`;

  const comments = source.getExecutionComments
    ? await source.getExecutionComments(issueId)
    : [];
  const alreadyCommented = comments.some((comment) => comment.body.includes(markerComment));
  if (alreadyCommented) {
    // The remote comment may have succeeded immediately before a process crash,
    // while the following state mutation/local ack did not. Reapply the
    // idempotent state transition but never duplicate the completion comment.
    const accepted = await source.updateState(issueId, 'Done');
    if (!accepted) throw new Error(`Tracker refused Done reconciliation for ${issueId}`);
  } else {
    await source.logPairComplete(issueId, effect.dedupeKey, payload.stats);
  }

  projectSuccessState(payload.task);
  await reconcileCompletionState(payload.task);

  if (payload.projectPath) {
    await recordTaskOutcome(payload.projectPath, {
      taskTitle: payload.task.title,
      derivedFrom: payload.task.issueIdentifier ?? issueId,
      iterations: payload.stats.attempts,
    });
  }
  if (payload.task.linearProject) {
    await updateProjectAfterTask(payload.task.linearProject.id, payload.task.linearProject.name, {
      title: payload.task.title,
      success: true,
      duration: payload.stats.duration * 1000,
      issueIdentifier: payload.task.issueIdentifier,
      cost: payload.costUsd,
      projectPath: payload.projectPath,
    });
  }
}
