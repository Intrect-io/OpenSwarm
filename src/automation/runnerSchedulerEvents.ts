// Created: 2026-11-22
// Purpose: the runner's scheduler event handlers (started, completed, superseded, deferred, cancelled,
//          decomposed, waiting_on_operator, failed, error, slotFreed) and the pipeline-history record they
//          write, moved out of autonomousRunner.ts as host-taking functions (AGT-4867 slice D)
// Dependencies: runnerState (retry/rejection/failure bookkeeping, pipeline history), runnerParking,
//               runnerExecution (tracker sync, Discord report), durableRunCoordinator, hostHealth (disk gate),
//               rateLimitBackoff, coordinatorResolution, operatorAnswers, repoKnowledge, projectUpdater
// Test Status: autonomousRunner.coverage/infraError/cancel/operatorPark/operatorQuestionPark/durable tests,
//              runnerSchedulerEvents.test.ts (host contract and late binding)

import {
  appendPipelineHistory,
  classifyFailureCause,
  incrementRejection,
  clearRejection,
  getRejectionCount,
  isRejectionLimitReached,
  setRetryTime,
  clearRetryTime,
  formatRetryTime,
  recordProjectCompletion,
  recordLastFailureDetail,
  pickFailureDetail,
  pickPipelineFailureDetail,
  type LastFailureEntry,
  type TaskState,
} from './runnerState.js';
import { taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import type { RunningTask, TaskScheduler } from '../orchestration/taskScheduler.js';
import {
  normalizeOperatorQuestionCorrelations,
  OPERATOR_QUESTION_PARK_REASON,
} from '../coordination/operatorAnswers.js';
import { shouldEarlyStuckForInfeasibility } from '../support/feasibilityDetector.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { type PipelineResult, formatPipelineResultEmbed } from '../agents/pairPipeline.js';
import { pipelineExecutionBoundary } from '../agents/stageExecutionBoundary.js';
import * as execution from './runnerExecution.js';
import { reportToDiscord, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { isHostResourceError, type HostDiskGate } from '../support/hostHealth.js';
import { broadcastEvent } from '../core/eventHub.js';
import {
  parkRunForHuman,
  publishAndCleanupStuckWorktree,
  setOperatorPark,
  setSandboxOutcomePark,
  stuckPullRequestSection,
} from './runnerParking.js';
import { isTimeoutError } from '../adapters/errorClassification.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import { completionStats } from './trackerEffects.js';
import { coordinatorResolutionComment } from './coordinatorResolution.js';
import { globalRateLimit } from './rateLimitBackoff.js';
import type { AutonomousConfig } from './runnerTypes.js';

type SchedulerOutcome = { task: TaskItem; result: PipelineResult };
type SchedulerError = { task: TaskItem; error: Error; startedAt: number; projectPath: string };

/**
 * What the scheduler event handlers need from the runner. The runner builds it so
 * every member is read at call time: state through getters (rateLimitUntil through
 * a get/set pair, since the failed handler assigns it), and every method through
 * the runner itself, so a test (or a later reassignment) of a runner member —
 * `saveTaskState`, `scheduleNextHeartbeat`, `runAvailableTasks`, `durableRuns`,
 * ... — is honoured exactly as when these handlers lived on the class.
 */
export interface SchedulerEventsHost {
  readonly scheduler: TaskScheduler;
  readonly durableRuns: DurableRunCoordinator;
  readonly config: AutonomousConfig;
  readonly completedTaskIds: Set<string>;
  readonly failedTaskCounts: Map<string, number>;
  readonly failedTaskRetryTimes: Map<string, number>;
  readonly consecutiveInfraErrorCounts: Map<string, number>;
  readonly lastFailureDetails: Map<string, LastFailureEntry>;
  readonly taskStateRef: TaskState;
  readonly diskGate: HostDiskGate;
  readonly maxRetryCount: number;
  rateLimitUntil: number;
  formatTaskContext(task: TaskItem): string;
  trackSchedulerHandler(label: string, operation: Promise<void>): void;
  saveTaskState(): void;
  scheduleNextHeartbeat(): void;
  drainDurableOutbox(): Promise<void>;
  runAvailableTasks(): Promise<void>;
}

export function onTaskStarted(host: SchedulerEventsHost, running: RunningTask): void {
  const taskCtx = host.formatTaskContext(running.task);
  console.log(`[Scheduler] Task started: ${taskCtx} ${running.task.title}`);
  broadcastEvent({ type: 'task:started', data: { taskId: taskEventKey(running.task), title: running.task.title, issueIdentifier: running.task.issueIdentifier } });
}

export function onTaskCompleted(host: SchedulerEventsHost, { task, result }: SchedulerOutcome): void {
  host.trackSchedulerHandler('completed', (async () => {
  const taskCtx = host.formatTaskContext(task);
  console.log(`[Scheduler] Task completed: ${taskCtx} ${task.title}`);
  broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: result.success, duration: result.totalDuration } });
  recordPipelineHistory(task, result);
  if (result.coordinatorResolution?.action === 'complete' && task.issueId) {
    const marker = `coordinator-complete:${task.issueId}:${result.sessionId}`;
    const source = getTaskSource();
    if (source) {
      source.addComment(task.issueId, coordinatorResolutionComment({
        action: 'complete',
        reason: result.coordinatorResolution.reason,
      }), marker).catch((error) => console.warn('[Coordinator] Completion note failed:', error));
    }
  }
  await reportToDiscord(formatPipelineResultEmbed(result));

  // Track as completed ONLY on success to prevent re-selection (persist to disk)
  if (task.issueId && result.success && !host.durableRuns.isPrimary) {
    host.completedTaskIds.add(task.issueId);
    clearRejection(task.issueId); // Clear rejection count on success
    clearRetryTime(task.issueId, host.failedTaskRetryTimes); // Clear retry backoff time
    host.consecutiveInfraErrorCounts.delete(task.issueId);
    host.lastFailureDetails.delete(task.issueId); // Stale feedback must not haunt future work
    host.saveTaskState();
    // Track project-level pace (5h rolling window)
    const projectName = task.linearProject?.name ?? 'unknown';
    await recordProjectCompletion(projectName, result.totalCost?.costUsd);
  }

  // Skip completion handling when another open PR already owns the planned
  // files. Both cases have a different coordination surface for completion.
  if (result.finalStatus === 'decomposed') {
    console.log(`[Scheduler] Task ${result.finalStatus}; skipping Done state`);
    host.scheduleNextHeartbeat();
    return;
  }

  if (result.success && task.issueId && host.durableRuns.isPrimary) {
    host.consecutiveInfraErrorCounts.delete(task.issueId);
    await host.drainDurableOutbox().catch((error) =>
      console.error('[Outbox] Completion delivery pass failed:', error));
    const durableState = host.durableRuns.getRun(task.issueId)?.state;
    if (durableState === 'DONE') {
      await recordProjectCompletion(task.linearProject?.name ?? 'unknown', result.totalCost?.costUsd);
      console.log(`[Scheduler] Durable completion committed for ${task.issueId}`);
    } else {
      console.warn(`[Scheduler] ${task.issueId} remains ${durableState ?? 'unknown'}; not counted complete`);
    }
    host.scheduleNextHeartbeat();
    return;
  }

  // On success, update Linear issue to Done
  if (result.success && task.issueId) {
    try {
      await execution.syncSuccessState(task);
      await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, completionStats(result));
      await execution.reconcileCompletionState(task);
      console.log(`[Scheduler] Issue ${task.issueId} marked as Done`);
    } catch (err) {
      console.error(`[Scheduler] Failed to update issue state:`, err);
    }

    // Accumulate repo-scoped knowledge — recalled and injected into the worker prompt of the next similar task
    const projectPath = result.taskContext?.projectPath;
    if (projectPath) {
      await recordTaskOutcome(projectPath, {
        taskTitle: task.title,
        derivedFrom: task.issueIdentifier ?? task.issueId,
        workerResult: result.workerResult,
        iterations: result.iterations,
      });
    }
  }

  // Linear project Status Update + Overview refresh (non-blocking)
  if (task.linearProject) {
    updateProjectAfterTask(task.linearProject.id, task.linearProject.name, {
      title: task.title,
      success: result.success,
      duration: result.totalDuration,
      issueIdentifier: task.issueIdentifier,
      cost: result.totalCost?.costUsd,
      projectPath: result.taskContext?.projectPath,
    }).catch(e => console.warn('[Scheduler] Project update failed:', e));
  }

  host.scheduleNextHeartbeat();
  })());
}

export function onTaskSuperseded(host: SchedulerEventsHost, { task, result }: SchedulerOutcome): void {
  const taskCtx = host.formatTaskContext(task);
  console.log(`[Scheduler] Task superseded: ${taskCtx} ${task.title}`);
  recordPipelineHistory(task, result);
  if (task.issueId) setRetryTime(task.issueId, 3, host.failedTaskRetryTimes);
  host.saveTaskState();
  broadcastEvent({ type: 'log', data: { taskId: taskEventKey(task), stage: 'preflight', line: 'Existing open PR owns planned files; deferred for re-check' } });
  // Terminal for this run: the other scheduler outcomes all emit it, and
  // consumers keyed on task:completed (transcript retention) would otherwise
  // hold this task's state forever. (INT-3402 review)
  broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
  host.scheduleNextHeartbeat();
}

export function onTaskDeferred(host: SchedulerEventsHost, { task, result, projectPath, retryAt }: {
  task: TaskItem; result: PipelineResult; projectPath: string; retryAt: number;
}): void {
  const taskCtx = host.formatTaskContext(task);
  const retryLabel = new Date(retryAt).toISOString();
  console.log(`[Scheduler] Task deferred: ${taskCtx} ${task.title} — retry at ${retryLabel}`);
  recordPipelineHistory(task, result);
  if (result.coordinatorResolution?.action === 'retry' && task.issueId) {
    const marker = `coordinator-retry:${task.issueId}:${result.sessionId}`;
    const source = getTaskSource();
    if (source) {
      source.addComment(task.issueId, coordinatorResolutionComment({
        action: 'retry',
        reason: result.coordinatorResolution.reason,
        retryAt,
      }), marker).catch((error) => console.warn('[Coordinator] Retry note failed:', error));
    }
  }
  broadcastEvent({
    type: 'log',
    data: {
      taskId: taskEventKey(task),
      stage: 'admission',
      line: `Transient admission conflict; kept queued until ${retryLabel}`,
    },
  });
  // A started attempt ended, but the task itself is still scheduler-owned.
  // Return the dashboard session to queued instead of reporting terminal
  // completion; the scheduler wake timer works even when heartbeat is off.
  broadcastEvent({
    type: 'task:queued',
    data: { taskId: taskEventKey(task), title: task.title, projectPath, issueIdentifier: task.issueIdentifier },
  });
}

export function onTaskCancelled(host: SchedulerEventsHost, { task, result }: SchedulerOutcome): void {
  host.trackSchedulerHandler('cancelled', (async () => {
    const taskCtx = host.formatTaskContext(task);
    console.log(`[Scheduler] Task cancelled: ${taskCtx} ${task.title}`);
    broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
    recordPipelineHistory(task, result);
    try {
      // In primary mode cancellation is already atomically parked in
      // SYNC_PENDING with a tracker.cancel effect. Direct delivery here
      // would recreate the remote-success/local-crash race that the outbox
      // exists to close.
      if (host.durableRuns.isPrimary) await host.drainDurableOutbox();
      else await execution.syncCancellationState(task);
    } finally {
      // Keep parity with completed/failed handlers: discovery resumes even
      // if tracker delivery is pending. Durable SYNC_PENDING still fences
      // this issue from re-execution.
      host.scheduleNextHeartbeat();
    }
  })());
}

export function onTaskDecomposed(host: SchedulerEventsHost, { task, result }: SchedulerOutcome): void {
  const taskCtx = host.formatTaskContext(task);
  console.log(`[Scheduler] Task decomposed: ${taskCtx} ${task.title}`);
  recordPipelineHistory(task, result);
  broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
  // Child issues, rather than the parent execution, now own completion.
  // Re-run discovery without incrementing completed/failed counters.
  host.scheduleNextHeartbeat();
}

export function onTaskWaitingOnOperator(host: SchedulerEventsHost, { task, result }: {
  task: TaskItem; result: PipelineResult;
}): void {
  const taskCtx = host.formatTaskContext(task);
  const boundary = pipelineExecutionBoundary(result);
  const question = boundary?.reason ?? result.workerResult?.haltReason ?? 'Blocked on an operator decision';
  console.log(`[Scheduler] Task waiting on operator: ${taskCtx} ${task.title} — ${question}`);
  recordPipelineHistory(task, result);
  broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
  // Park without touching failure/STUCK accounting: the only blocker is a
  // human. The backoff re-admit is also the resume path — on the retried
  // run, ask_human finds the recorded answer on the board and returns it
  // instead of blocking, so the task continues the moment a re-dispatch
  // lands after the operator replies.
  // `issueId || id` is what the heartbeat, the ledger and the coordination
  // context all key on. Parking under a narrower id than the one that later
  // looks it up arms nothing: the task keeps its durable backoff and the
  // operator's answer cannot shorten it.
  const parkedId = task.issueId || task.id;
  if (parkedId) {
    const outcomeUnknown = boundary?.executionOutcomeUnknown === true;
    // Without an authoritative ledger there is no error code to carry the
    // park, so record the stand-in signal the heartbeat reads instead.
    if (!host.durableRuns.isPrimary) {
      if (outcomeUnknown) setSandboxOutcomePark(parkedId, true);
      else setOperatorPark(parkedId, true);
    }

    const correlationIds = normalizeOperatorQuestionCorrelations(
      boundary?.operatorQuestionCorrelationIds ?? [],
    );
    // The primary coordinator normally persisted NEEDS_HUMAN atomically
    // before this event. The RETRY_AT conversion remains as a recovery path
    // for callers that emit the scheduler event around a legacy coordinator.
    // If an old adapter omits the correlation, keep bounded backoff rather
    // than inventing a broad task-level resume condition.
    const existingRun = host.durableRuns.getRun(parkedId);
    const durablyParked = host.durableRuns.isPrimary && (
      outcomeUnknown
        ? existingRun?.state === 'NEEDS_HUMAN'
          && existingRun.lastErrorCode === SANDBOX_OUTCOME_UNKNOWN_PARK_REASON
        : correlationIds.length > 0 && (
          (existingRun?.state === 'NEEDS_HUMAN'
            && existingRun.lastErrorCode === OPERATOR_QUESTION_PARK_REASON)
          || host.durableRuns.markNeedsHumanForQuestions(
            parkedId,
            correlationIds,
            `Waiting for operator answer (${correlationIds.join(', ')})`,
          )
        )
    );
    if (durablyParked) {
      console.log(outcomeUnknown
        ? `[Scheduler] Quarantining ${taskCtx} until explicit operator redispatch`
        : `[Scheduler] Parking ${taskCtx} on exact operator question set: ${correlationIds.join(', ')}`);
    } else if (outcomeUnknown) {
      console.error(`[Scheduler] Sandbox outcome quarantine could not be persisted for ${taskCtx}; refusing automatic retry`);
    } else {
      const nextRetryTime = setRetryTime(parkedId, 4, host.failedTaskRetryTimes);
      host.saveTaskState();
      console.log(`[Scheduler] Exact question park unavailable; re-admitting ${taskCtx} ${formatRetryTime(nextRetryTime)}`);
    }
  }
  host.scheduleNextHeartbeat();
}

export function onTaskFailed(host: SchedulerEventsHost, { task, result }: SchedulerOutcome): void {
  host.trackSchedulerHandler('failed', (async () => {
  const taskCtx = host.formatTaskContext(task);
  recordPipelineHistory(task, result);

  // Rate-limited: pause (ramping, rateLimitBackoff.ts) — not a task failure, no rejection
  // path, no Linear comment; that is the retry-spam INT-1906 fixed.
  if (result.finalStatus === 'rate_limited') {
    const resetsAt = globalRateLimit.hit(result.rateLimitResetsAt);
    host.rateLimitUntil = resetsAt;
    const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
    const resetsLabel = new Date(resetsAt).toISOString();
    console.warn(`[Scheduler] Rate limit hit for ${taskCtx} — pausing until ${resetsLabel} (~${waitSec}s)`);
    broadcastEvent({
      type: 'log',
      data: { taskId: taskEventKey(task), stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` },
    });
    return;
  }

  // Infra/CLI failure: the worker/reviewer never actually ran (non-zero exit,
  // auth expiry, spawn, timeout). This is NOT a task failure — do NOT increment
  // the rejection/failure counters that mark an issue durably STUCK. Backoff-
  // retry instead; the operator fixes the root cause (e.g. re-auth) and the task
  // resumes on its own. This is what kept completable tasks (worker had already
  // edited files) STUCK in production. (INT-2010)
  if (result.finalStatus === 'infra_error') {
    const detail = pickPipelineFailureDetail(result) || 'infra/CLI execution error';
    // Host resource failures (ENOSPC) pause all dispatch through the disk gate with one
    // notice instead of a per-task backoff that fails the same way next time (AGT-4785).
    const resource = isHostResourceError(detail) ? host.diskGate.resourceFailure(detail) : undefined;
    if (resource?.pause) { // a measured low alerts via the heartbeat's auto:disk pause; an unconfirmed report is a timed hold (#849 review)
      console.error(`[Scheduler] ${taskCtx} stopped dispatch after a host resource failure: ${detail}`); if (resource.hold && resource.notice) await reportToDiscord(`⚠️ ${resource.notice}`);
    } else if (task.issueId) { // includes an ENOSPC report the measurement did not confirm: ordinary infra backoff
      // Fixed mid-range backoff — we intentionally don't bump failure counts,
      // so there's no attempt number to scale by.
      const nextRetryTime = setRetryTime(task.issueId, 3, host.failedTaskRetryTimes);
      const infraStreak = (host.consecutiveInfraErrorCounts.get(task.issueId) ?? 0) + 1;
      host.consecutiveInfraErrorCounts.set(task.issueId, infraStreak);
      host.saveTaskState();
      console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK, consecutive: ${infraStreak}) — backoff retry ${formatRetryTime(nextRetryTime)}: ${detail}`);
    } else {
      console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK): ${detail}`);
    }
    host.scheduleNextHeartbeat();
    return;
  }

  // Pair-level stagnation only proves that the CURRENT session stopped
  // making progress. A new outer attempt gets a new model context and can
  // resume the preserved worktree, which is often enough to escape a repeated
  // output/error loop. Let this flow through the normal bounded failure budget
  // below; only MAX_RETRY_COUNT consecutive outer attempts may require a human.
  if (result.failureSignal === 'stuck' && task.issueId) {
    const failureDetail = result.stuckReason
      ?? pickFailureDetail([result.lastReviewFeedback, result.reviewResult?.feedback, result.workerResult?.error])
      ?? 'Pair pipeline detected repeated non-progress.';
    recordLastFailureDetail(host.taskStateRef, task.issueId, failureDetail);
    console.warn(`[Scheduler] Pair session stagnated for ${taskCtx}; scheduling a new outer attempt: ${failureDetail}`);
  }

  console.log(`[Scheduler] Task failed: ${taskCtx} ${task.title}`);
  broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
  await reportToDiscord(formatPipelineResultEmbed(result));

  // A deterministic, operator-owned failure (the publication-scope fence).
  // The coordinator has already parked the durable row under
  // `operatorPark.code`; the failure budget below must NOT run: its retry
  // branch returns the card to Todo, and the heartbeat reads Todo as an
  // operator reopen — so the park resumed on the next tick and re-parked
  // four minutes later, every cycle waking the orchestrator sweep (vela
  // 13:09–13:31, 2026-09-02). Park the card the way STUCK does: comment
  // the cause, move it to Backlog, and wait for a human to move it back.
  if (result.operatorPark && task.issueId) {
    const { code, reason } = result.operatorPark;
    host.completedTaskIds.add(task.issueId); // no retry changes what the fence saw
    clearRetryTime(task.issueId, host.failedTaskRetryTimes);
    host.consecutiveInfraErrorCounts.delete(task.issueId);
    recordLastFailureDetail(host.taskStateRef, task.issueId, reason);
    host.saveTaskState();
    console.warn(`[Scheduler] ${taskCtx} parked for the operator (${code}): ${reason}`);
    try {
      await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
        `Parked for the operator — \`${code}\`. The daemon will not retry this on its own.\n\n**Reason:**\n${reason}`);
    } catch (err) {
      console.error('[Scheduler] Failed to record the operator park on the tracker:', err);
    }
    host.scheduleNextHeartbeat();
    return;
  }

  // Structural infeasibility (⑦, INT-2521): the failure text says the DoD can't
  // be met in this sandbox — it needs a human, a manual step, or an absent
  // environment resource (real DB / live network / production access). The
  // pipeline ran fine and the reviewer *correctly* rejected, so this IS a real
  // task_failure; but re-running against an environmental wall only burns the
  // remaining rejection/failure budget (3–4 full attempts) before the same STUCK.
  // When the task has hit an infeasibility wall on two consecutive attempts, mark
  // it STUCK now — labelled needs-human, blocker surfaced — instead of exhausting
  // the budget. The guard (current AND the previously-recorded failure both carry a
  // high-precision infeasibility marker; the two markers need not be identical) is
  // what keeps a merely-hard task — which keeps making progress and won't stably
  // emit the marker — or a one-off false-positive after an UNRELATED prior failure
  // from being cut early. No new
  // external state: this is the existing STUCK, reached sooner. NOTE: this path
  // intentionally SKIPS the rejection-count / repo-pitfall accounting below — it is
  // a terminal needs-human transition, not a retry, so a rejection tally is moot;
  // it still persists the deciding failure detail. (INT-2521 ⑦)
  if (task.issueId) {
    const infeasDetail = pickFailureDetail([
      result.lastReviewFeedback,
      result.reviewResult?.feedback,
      result.workerResult?.error,
    ]) ?? '';
    const priorDetail = host.lastFailureDetails.get(task.issueId)?.detail ?? '';
    const infeasible = shouldEarlyStuckForInfeasibility(infeasDetail, priorDetail);
    if (infeasible.earlyStuck) {
      const attempts = getRejectionCount(task.issueId) + (host.failedTaskCounts.get(task.issueId) ?? 0) + 1;
      host.completedTaskIds.add(task.issueId); // no retry can move an environmental wall
      clearRetryTime(task.issueId, host.failedTaskRetryTimes);
      host.consecutiveInfraErrorCounts.delete(task.issueId);
      clearRejection(task.issueId);
      recordLastFailureDetail(host.taskStateRef, task.issueId, infeasDetail);
      const ownsRun = parkRunForHuman(
        host.durableRuns, task.issueId,
        `DoD appears unsatisfiable in the sandbox after ${attempts} attempts: ${infeasible.marker}`,
      );
      host.saveTaskState();
      let stuckPrUrl: string | undefined;
      if (result.taskContext?.projectPath) {
        stuckPrUrl = await publishAndCleanupStuckWorktree(
          task, result.taskContext.projectPath,
          `the DoD appears unsatisfiable in the sandbox after ${attempts} attempts (marker: "${infeasible.marker}")`,
          ownsRun,
        );
      }
      try {
        await execution.syncFailureState(task,
          `Needs human — DoD appears unsatisfiable in the sandbox (marker: "${infeasible.marker}") after ${attempts} attempts`);
        await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
          `**Needs human — the DoD appears unsatisfiable in this sandbox.**\n\n` +
          `Detected blocker phrase: "${infeasible.marker}". Re-running can't fix an environmental ` +
          `impossibility (missing DB / network / credentials, or a manual/human step), so automatic ` +
          `retries were stopped early after ${attempts} attempts.\n\n**Latest failure:**\n${infeasDetail}` +
          stuckPullRequestSection(stuckPrUrl));
        console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (needs-human: infeasible in sandbox) — ${attempts} attempts`);
      } catch (err) {
        console.error(`[Scheduler] Failed to update issue state:`, err);
      }
      return;
    }
  }

  // If rejected, track rejection count and block after max attempts
  if (task.issueId && result.finalStatus === 'rejected') {
    const feedback = pickFailureDetail([result.lastReviewFeedback, result.reviewResult?.feedback])
      ?? 'No feedback provided';
    const rejectionCount = incrementRejection(task.issueId, feedback);
    // Persist for prompt injection on the retry (same mechanism as failures).
    recordLastFailureDetail(host.taskStateRef, task.issueId, feedback);

    // Store the rejection reason as a repo pitfall (constraint) — blocks repeating the same mistake
    if (result.taskContext?.projectPath) {
      await recordTaskOutcome(result.taskContext.projectPath, {
        taskTitle: task.title,
        derivedFrom: task.issueIdentifier ?? task.issueId,
        rejectionFeedback: feedback,
      });
    }

    console.log(`[Scheduler] Task rejected (${rejectionCount}/3): ${taskCtx} ${task.title}`);
    console.log(`[Scheduler] Rejection reason: ${feedback}`);

    if (isRejectionLimitReached(task.issueId)) {
      // Max rejections reached - permanently block
      host.completedTaskIds.add(task.issueId); // Prevent re-selection
      clearRetryTime(task.issueId, host.failedTaskRetryTimes); // Clear retry time
      host.consecutiveInfraErrorCounts.delete(task.issueId);
      const ownsRun = parkRunForHuman(
        host.durableRuns, task.issueId,
        `Reviewer rejected ${rejectionCount} attempts: ${feedback}`,
      );
      host.saveTaskState();
      // Terminally stuck → no retry will resume the preserved tree; publish
      // the partial work as a draft PR and free the disk (INT-2506).
      let stuckPrUrl: string | undefined;
      if (result.taskContext?.projectPath) {
        stuckPrUrl = await publishAndCleanupStuckWorktree(
          task, result.taskContext.projectPath,
          `the reviewer rejected ${rejectionCount} attempts`,
          ownsRun,
        );
      }

      try {
        await execution.syncFailureState(task, `Max rejection limit reached (${rejectionCount} attempts): ${feedback}`);
        await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
          `Rejected ${rejectionCount} times by the reviewer — automatic retries exhausted.\n\n` +
          `**Latest rejection reason:**\n${feedback}` +
          stuckPullRequestSection(stuckPrUrl)
        );
        console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (max rejections reached)`);
      } catch (err) {
        console.error(`[Scheduler] Failed to update issue state:`, err);
      }
      return;
    } else {
      // Not max yet - schedule retry with exponential backoff
      const nextRetryTime = setRetryTime(task.issueId, rejectionCount, host.failedTaskRetryTimes);
      const retryIn = formatRetryTime(nextRetryTime);
      host.saveTaskState();

      try {
        await execution.syncFailureState(task, `Review rejected (${rejectionCount}/3): ${feedback}`, 'Todo');
        await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
          t('runner.reviewRejected', { feedback }) +
          `\n\n**Rejection count:** ${rejectionCount}/3 - Will retry automatically ${retryIn}.`
        );
        console.log(`[Scheduler] Issue ${task.issueId} marked as Todo (blocked) (rejected ${rejectionCount}/3) — retry ${retryIn}`);
      } catch (err) {
        console.error(`[Scheduler] Failed to update issue state:`, err);
      }
      return;
    }
  }

  // Track failure count — block after MAX_RETRY_COUNT failures
  if (task.issueId) {
    const count = (host.failedTaskCounts.get(task.issueId) ?? 0) + 1;
    host.failedTaskCounts.set(task.issueId, count);

    // Surface the underlying failure so the stuck comment is actionable AND
    // persist it for the next attempt's injection (INT-2474). Prefer the last
    // REAL reviewer feedback: reviewResult can hold a synthetic entry
    // (validation nudge / HALT overwrite it), and a junk-but-truthy worker
    // error ("Unknown error" from the text-fallback parser) used to mask the
    // reviewer's actionable feedback entirely (INT-2504).
    const failureDetail = pickPipelineFailureDetail(result)
      ?? 'No error detail captured (worker produced no output).';
    recordLastFailureDetail(host.taskStateRef, task.issueId, failureDetail);

    if (count >= host.maxRetryCount) {
      // Max retries exceeded - permanently block
      host.completedTaskIds.add(task.issueId); // Prevent re-selection
      clearRetryTime(task.issueId, host.failedTaskRetryTimes); // Clear retry time
      host.consecutiveInfraErrorCounts.delete(task.issueId);
      const ownsRun = parkRunForHuman(
        host.durableRuns, task.issueId,
        `Autonomous execution failed ${count} times: ${failureDetail}`,
      );
      host.saveTaskState();
      console.log(`[Scheduler] Task failure count: ${count}/${host.maxRetryCount} for ${taskCtx} — STUCK`);
      // Terminally stuck → publish partial work as a draft PR, free the disk (INT-2506).
      let stuckPrUrl: string | undefined;
      if (result.taskContext?.projectPath) {
        stuckPrUrl = await publishAndCleanupStuckWorktree(
          task, result.taskContext.projectPath,
          `autonomous execution failed ${count} times`,
          ownsRun,
        );
      }
      try {
        await execution.syncFailureState(task, `Autonomous execution failed ${count} times: ${failureDetail}`);
        await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
          `Autonomous execution failed ${count} times in a row — automatic retries exhausted.\n\n` +
          `**Last failure:**\n${failureDetail}` +
          stuckPullRequestSection(stuckPrUrl)
        );
        console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (max retries exceeded)`);
      } catch (err) {
        console.error(`[Scheduler] Failed to update issue state:`, err);
      }
    } else {
      // Schedule retry with exponential backoff
      const nextRetryTime = setRetryTime(task.issueId, count, host.failedTaskRetryTimes);
      const retryIn = formatRetryTime(nextRetryTime);
      console.log(`[Scheduler] Task failure count: ${count}/${host.maxRetryCount} for ${taskCtx} — retry ${retryIn}`);
      host.saveTaskState();
      await execution.syncFailureState(task, `Autonomous execution failed ${count}/${host.maxRetryCount}: ${failureDetail}`, 'Todo');
    }
  }

  // Linear project Status Update + Overview refresh (non-blocking)
  if (task.linearProject) {
    updateProjectAfterTask(task.linearProject.id, task.linearProject.name, {
      title: task.title,
      success: result.success,
      duration: result.totalDuration,
      issueIdentifier: task.issueIdentifier,
      cost: result.totalCost?.costUsd,
      projectPath: result.taskContext?.projectPath,
    }).catch(e => console.warn('[Scheduler] Project update failed:', e));
  }

  host.scheduleNextHeartbeat();
  })());
}

export function onTaskError(host: SchedulerEventsHost, { task, error, startedAt, projectPath }: SchedulerError): void {
  host.trackSchedulerHandler('error', (async () => {
  const taskCtx = host.formatTaskContext(task);
  console.error(`[Scheduler] Task error: ${taskCtx} ${task.title}`, error);
  const timeout = isTimeoutError(error);
  const watchdogBudget = /^Task timed out after (\d+)ms \(scheduler hard watchdog\)$/.exec(error.message);
  if (watchdogBudget) {
    host.durableRuns.recordWatchdogTimeout(
      task.issueId || task.id,
      Number(watchdogBudget[1]),
      Math.max(0, Date.now() - startedAt),
    );
  }
  // A thrown executor is an infra_error to the ledger (durableRunCoordinator
  // records it so and parks the row 15 min). Keep the same in-memory streak
  // the 'failed' handler keeps, or a task whose failures arrive as
  // exceptions never reaches the idle-fill gate that AGT-4305 added for
  // returned results (AGT-4307).
  if (task.issueId) {
    const infraStreak = (host.consecutiveInfraErrorCounts.get(task.issueId) ?? 0) + 1;
    host.consecutiveInfraErrorCounts.set(task.issueId, infraStreak);
    setRetryTime(task.issueId, 3, host.failedTaskRetryTimes);
    host.saveTaskState();
  }
  recordPipelineHistory(task, {
    success: false, sessionId: `scheduler-error-${task.id}-${Date.now()}`, stages: [],
    finalStatus: timeout ? 'infra_error' : 'failed', failureSignal: timeout ? 'timeout' : undefined,
    failureDetail: `scheduler execution: ${error instanceof Error ? error.message : String(error)}`,
    totalDuration: Math.max(0, Date.now() - startedAt), iterations: 0,
    taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectName: task.linearProject?.name, projectPath, taskTitle: task.title },
  });
  // Terminal for this run — see the superseded handler. (INT-3402 review)
  broadcastEvent({
    type: 'task:completed',
    data: { taskId: taskEventKey(task), success: false, duration: Math.max(0, Date.now() - startedAt) },
  });
  await reportToDiscord(t('runner.pipelineError', { title: `${taskCtx} ${task.title}`, error: error.message }));
  })());
}

export function onSlotFreed(host: SchedulerEventsHost): void {
  // Auto-execute next task when slot becomes available
  host.trackSchedulerHandler('slotFreed', host.runAvailableTasks());
}

/**
 * Register every scheduler event handler on `host.scheduler`, in the order the
 * runner always registered them (the 'error' listener's presence also tells the
 * scheduler to emit it at all).
 */
export function attachSchedulerEvents(host: SchedulerEventsHost): void {
  const scheduler = host.scheduler;
  scheduler.on('started', (running) => onTaskStarted(host, running));
  scheduler.on('completed', (payload) => onTaskCompleted(host, payload));
  scheduler.on('superseded', (payload) => onTaskSuperseded(host, payload));
  scheduler.on('deferred', (payload) => onTaskDeferred(host, payload));
  scheduler.on('cancelled', (payload) => onTaskCancelled(host, payload));
  scheduler.on('decomposed', (payload) => onTaskDecomposed(host, payload));
  scheduler.on('waiting_on_operator', (payload) => onTaskWaitingOnOperator(host, payload));
  scheduler.on('failed', (payload) => onTaskFailed(host, payload));
  scheduler.on('error', (payload) => onTaskError(host, payload));
  scheduler.on('slotFreed', () => onSlotFreed(host));
}

export function recordPipelineHistory(task: TaskItem, result: PipelineResult): void {
  const failureCause = classifyFailureCause({
    success: result.success, finalStatus: result.finalStatus, failureSignal: result.failureSignal,
    workerFilesChanged: result.workerResult?.filesChanged?.length,
    reviewerDecision: result.reviewResult?.decision,
  });
  appendPipelineHistory({
    sessionId: result.sessionId, issueIdentifier: task.issueIdentifier || task.issueId,
    issueId: task.issueId, taskTitle: task.title, projectName: task.linearProject?.name,
    projectPath: result.taskContext?.projectPath, success: result.success,
    finalStatus: result.finalStatus, iterations: result.iterations,
    totalDuration: result.totalDuration,
    stages: result.stages.map(s => ({ stage: s.stage, success: s.success, duration: s.duration })),
    cost: result.totalCost ? { costUsd: result.totalCost.costUsd,
      inputTokens: result.totalCost.inputTokens, outputTokens: result.totalCost.outputTokens } : undefined,
    prUrl: result.prUrl, reviewerFeedback: result.reviewResult?.feedback,
    failureCause,
    completedAt: new Date().toISOString(),
  });
}
