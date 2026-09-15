import { incrementRejection, clearRejection, getRejectionCount, isRejectionLimitReached, setRetryTime, clearRetryTime, formatRetryTime, recordProjectCompletion, recordLastFailureDetail, pickFailureDetail, pickPipelineFailureDetail } from './runnerState.js';
import { taskEventKey, TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeOperatorQuestionCorrelations, OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
// ExecutorResult used via execution.reportExecutionResult
import { shouldEarlyStuckForInfeasibility } from '../support/feasibilityDetector.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import {
  PipelineResult,
  formatPipelineResultEmbed,
} from '../agents/pairPipeline.js';
import * as execution from './runnerExecution.js';
import { readDraftCache, writeDraftCache } from './draftCache.js';
import { reportToDiscord, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { broadcastEvent } from '../core/eventHub.js';
import {
  describeScopeConflict,
  detectFileConflicts,
  resolveTaskFileScope,
  type ScopeConflictReason,
} from '../orchestration/conflictDetector.js';
import { isTimeoutError } from '../adapters/errorClassification.js';
import { completionStats } from './trackerEffects.js';
import { coordinatorResolutionComment } from './coordinatorResolution.js';
import { AutonomousRunnerCore } from './autonomousRunnerCore.js';
import { taskLabel, describeConflictCause, setOperatorPark, setSandboxOutcomePark, publishAndCleanupStuckWorktree, parkRunForHuman, stuckPullRequestSection, failClosedConflictFallback, RunnableCandidate } from './runnerHelpers.js';
export abstract class AutonomousRunnerScheduling extends AutonomousRunnerCore {
  protected setupSchedulerEvents(): void {
    this.scheduler.on('started', (running) => {
      const taskCtx = this.formatTaskContext(running.task);
      console.log(`[Scheduler] Task started: ${taskCtx} ${running.task.title}`);
      broadcastEvent({ type: 'task:started', data: { taskId: taskEventKey(running.task), title: running.task.title, issueIdentifier: running.task.issueIdentifier } });
    });

    this.scheduler.on('completed', ({ task, result }) => {
      this.trackSchedulerHandler('completed', (async () => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task completed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: result.success, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
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
      if (task.issueId && result.success && !this.durableRuns.isPrimary) {
        this.completedTaskIds.add(task.issueId);
        clearRejection(task.issueId); // Clear rejection count on success
        clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry backoff time
        this.consecutiveInfraErrorCounts.delete(task.issueId);
        this.lastFailureDetails.delete(task.issueId); // Stale feedback must not haunt future work
        this.saveTaskState();
        // Track project-level pace (5h rolling window)
        const projectName = task.linearProject?.name ?? 'unknown';
        await recordProjectCompletion(projectName, result.totalCost?.costUsd);
      }

      // Skip completion handling when another open PR already owns the planned
      // files. Both cases have a different coordination surface for completion.
      if (result.finalStatus === 'decomposed') {
        console.log(`[Scheduler] Task ${result.finalStatus}; skipping Done state`);
        this.scheduleNextHeartbeat();
        return;
      }

      if (result.success && task.issueId && this.durableRuns.isPrimary) {
        this.consecutiveInfraErrorCounts.delete(task.issueId);
        await this.drainDurableOutbox().catch((error) =>
          console.error('[Outbox] Completion delivery pass failed:', error));
        const durableState = this.durableRuns.getRun(task.issueId)?.state;
        if (durableState === 'DONE') {
          await recordProjectCompletion(task.linearProject?.name ?? 'unknown', result.totalCost?.costUsd);
          console.log(`[Scheduler] Durable completion committed for ${task.issueId}`);
        } else {
          console.warn(`[Scheduler] ${task.issueId} remains ${durableState ?? 'unknown'}; not counted complete`);
        }
        this.scheduleNextHeartbeat();
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

      this.scheduleNextHeartbeat();
      })());
    });

    this.scheduler.on('superseded', ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task superseded: ${taskCtx} ${task.title}`);
      this.recordPipelineHistory(task, result);
      if (task.issueId) setRetryTime(task.issueId, 3, this.failedTaskRetryTimes);
      this.saveTaskState();
      broadcastEvent({ type: 'log', data: { taskId: taskEventKey(task), stage: 'preflight', line: 'Existing open PR owns planned files; deferred for re-check' } });
      // Terminal for this run: the other scheduler outcomes all emit it, and
      // consumers keyed on task:completed (transcript retention) would otherwise
      // hold this task's state forever. (INT-3402 review)
      broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('deferred', ({ task, result, projectPath, retryAt }: {
      task: TaskItem; result: PipelineResult; projectPath: string; retryAt: number;
    }) => {
      const taskCtx = this.formatTaskContext(task);
      const retryLabel = new Date(retryAt).toISOString();
      console.log(`[Scheduler] Task deferred: ${taskCtx} ${task.title} — retry at ${retryLabel}`);
      this.recordPipelineHistory(task, result);
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
    });

    this.scheduler.on('cancelled', ({ task, result }) => {
      this.trackSchedulerHandler('cancelled', (async () => {
        const taskCtx = this.formatTaskContext(task);
        console.log(`[Scheduler] Task cancelled: ${taskCtx} ${task.title}`);
        broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
        this.recordPipelineHistory(task, result);
        try {
          // In primary mode cancellation is already atomically parked in
          // SYNC_PENDING with a tracker.cancel effect. Direct delivery here
          // would recreate the remote-success/local-crash race that the outbox
          // exists to close.
          if (this.durableRuns.isPrimary) await this.drainDurableOutbox();
          else await execution.syncCancellationState(task);
        } finally {
          // Keep parity with completed/failed handlers: discovery resumes even
          // if tracker delivery is pending. Durable SYNC_PENDING still fences
          // this issue from re-execution.
          this.scheduleNextHeartbeat();
        }
      })());
    });

    this.scheduler.on('decomposed', ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task decomposed: ${taskCtx} ${task.title}`);
      this.recordPipelineHistory(task, result);
      broadcastEvent({ type: 'task:completed', data: { taskId: taskEventKey(task), success: false, duration: result.totalDuration } });
      // Child issues, rather than the parent execution, now own completion.
      // Re-run discovery without incrementing completed/failed counters.
      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('waiting_on_operator', ({ task, result }: {
      task: TaskItem; result: PipelineResult;
    }) => {
      const taskCtx = this.formatTaskContext(task);
      const question = result.workerResult?.haltReason ?? 'Blocked on an operator decision';
      console.log(`[Scheduler] Task waiting on operator: ${taskCtx} ${task.title} — ${question}`);
      this.recordPipelineHistory(task, result);
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
        const outcomeUnknown = result.workerResult?.executionOutcomeUnknown === true;
        // Without an authoritative ledger there is no error code to carry the
        // park, so record the stand-in signal the heartbeat reads instead.
        if (!this.durableRuns.isPrimary) {
          if (outcomeUnknown) setSandboxOutcomePark(parkedId, true);
          else setOperatorPark(parkedId, true);
        }

        const correlationIds = normalizeOperatorQuestionCorrelations(
          result.workerResult?.operatorQuestionCorrelationIds ?? [],
        );
        // The primary coordinator normally persisted NEEDS_HUMAN atomically
        // before this event. The RETRY_AT conversion remains as a recovery path
        // for callers that emit the scheduler event around a legacy coordinator.
        // If an old adapter omits the correlation, keep bounded backoff rather
        // than inventing a broad task-level resume condition.
        const existingRun = this.durableRuns.getRun(parkedId);
        const durablyParked = this.durableRuns.isPrimary && (
          outcomeUnknown
            ? existingRun?.state === 'NEEDS_HUMAN'
              && existingRun.lastErrorCode === SANDBOX_OUTCOME_UNKNOWN_PARK_REASON
            : correlationIds.length > 0 && (
              (existingRun?.state === 'NEEDS_HUMAN'
                && existingRun.lastErrorCode === OPERATOR_QUESTION_PARK_REASON)
              || this.durableRuns.markNeedsHumanForQuestions(
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
          const nextRetryTime = setRetryTime(parkedId, 4, this.failedTaskRetryTimes);
          this.saveTaskState();
          console.log(`[Scheduler] Exact question park unavailable; re-admitting ${taskCtx} ${formatRetryTime(nextRetryTime)}`);
        }
      }
      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('failed', ({ task, result }) => {
      this.trackSchedulerHandler('failed', (async () => {
      const taskCtx = this.formatTaskContext(task);
      this.recordPipelineHistory(task, result);

      // Rate-limited: pause execution until the quota resets. Do NOT count it as a
      // task failure, run the rejection/block path, or post a Linear comment —
      // that is exactly the retry-spam this issue fixes. (INT-1906)
      if (result.finalStatus === 'rate_limited') {
        const resetsAt = result.rateLimitResetsAt ?? Date.now() + 60_000;
        this.rateLimitUntil = resetsAt;
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
        if (task.issueId) {
          // Fixed mid-range backoff — we intentionally don't bump failure counts,
          // so there's no attempt number to scale by.
          const nextRetryTime = setRetryTime(task.issueId, 3, this.failedTaskRetryTimes);
          const infraStreak = (this.consecutiveInfraErrorCounts.get(task.issueId) ?? 0) + 1;
          this.consecutiveInfraErrorCounts.set(task.issueId, infraStreak);
          this.saveTaskState();
          console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK, consecutive: ${infraStreak}) — backoff retry ${formatRetryTime(nextRetryTime)}: ${detail}`);
        } else {
          console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK): ${detail}`);
        }
        this.scheduleNextHeartbeat();
        return;
      }

      // Pair-level stagnation only proves that the CURRENT session stopped
      // making progress. A fresh outer attempt gets a new model context and can
      // resume the preserved worktree, which is often enough to escape a repeated
      // output/error loop. Let this flow through the normal bounded failure budget
      // below; only MAX_RETRY_COUNT consecutive outer attempts may require a human.
      if (result.failureSignal === 'stuck' && task.issueId) {
        const failureDetail = result.stuckReason
          ?? pickFailureDetail([result.lastReviewFeedback, result.reviewResult?.feedback, result.workerResult?.error])
          ?? 'Pair pipeline detected repeated non-progress.';
        recordLastFailureDetail(this.taskStateRef, task.issueId, failureDetail);
        console.warn(`[Scheduler] Pair session stagnated for ${taskCtx}; retrying with fresh context: ${failureDetail}`);
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
        this.completedTaskIds.add(task.issueId); // no retry changes what the fence saw
        clearRetryTime(task.issueId, this.failedTaskRetryTimes);
        this.consecutiveInfraErrorCounts.delete(task.issueId);
        recordLastFailureDetail(this.taskStateRef, task.issueId, reason);
        this.saveTaskState();
        console.warn(`[Scheduler] ${taskCtx} parked for the operator (${code}): ${reason}`);
        try {
          await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
            `Parked for the operator — \`${code}\`. The daemon will not retry this on its own.\n\n**Reason:**\n${reason}`);
        } catch (err) {
          console.error('[Scheduler] Failed to record the operator park on the tracker:', err);
        }
        this.scheduleNextHeartbeat();
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
        const priorDetail = this.lastFailureDetails.get(task.issueId)?.detail ?? '';
        const infeasible = shouldEarlyStuckForInfeasibility(infeasDetail, priorDetail);
        if (infeasible.earlyStuck) {
          const attempts = getRejectionCount(task.issueId) + (this.failedTaskCounts.get(task.issueId) ?? 0) + 1;
          this.completedTaskIds.add(task.issueId); // no retry can move an environmental wall
          clearRetryTime(task.issueId, this.failedTaskRetryTimes);
          this.consecutiveInfraErrorCounts.delete(task.issueId);
          clearRejection(task.issueId);
          recordLastFailureDetail(this.taskStateRef, task.issueId, infeasDetail);
          const ownsRun = parkRunForHuman(
            this.durableRuns, task.issueId,
            `DoD appears unsatisfiable in the sandbox after ${attempts} attempts: ${infeasible.marker}`,
          );
          this.saveTaskState();
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
        recordLastFailureDetail(this.taskStateRef, task.issueId, feedback);

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
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          this.consecutiveInfraErrorCounts.delete(task.issueId);
          const ownsRun = parkRunForHuman(
            this.durableRuns, task.issueId,
            `Reviewer rejected ${rejectionCount} attempts: ${feedback}`,
          );
          this.saveTaskState();
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
          const nextRetryTime = setRetryTime(task.issueId, rejectionCount, this.failedTaskRetryTimes);
          const retryIn = formatRetryTime(nextRetryTime);
          this.saveTaskState();

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
        const count = (this.failedTaskCounts.get(task.issueId) ?? 0) + 1;
        this.failedTaskCounts.set(task.issueId, count);

        // Surface the underlying failure so the stuck comment is actionable AND
        // persist it for the next attempt's injection (INT-2474). Prefer the last
        // REAL reviewer feedback: reviewResult can hold a synthetic entry
        // (validation nudge / HALT overwrite it), and a junk-but-truthy worker
        // error ("Unknown error" from the text-fallback parser) used to mask the
        // reviewer's actionable feedback entirely (INT-2504).
        const failureDetail = pickPipelineFailureDetail(result)
          ?? 'No error detail captured (worker produced no output).';
        recordLastFailureDetail(this.taskStateRef, task.issueId, failureDetail);

        if (count >= AutonomousRunnerCore.MAX_RETRY_COUNT) {
          // Max retries exceeded - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          this.consecutiveInfraErrorCounts.delete(task.issueId);
          const ownsRun = parkRunForHuman(
            this.durableRuns, task.issueId,
            `Autonomous execution failed ${count} times: ${failureDetail}`,
          );
          this.saveTaskState();
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunnerCore.MAX_RETRY_COUNT} for ${taskCtx} — STUCK`);
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
          const nextRetryTime = setRetryTime(task.issueId, count, this.failedTaskRetryTimes);
          const retryIn = formatRetryTime(nextRetryTime);
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunnerCore.MAX_RETRY_COUNT} for ${taskCtx} — retry ${retryIn}`);
          this.saveTaskState();
          await execution.syncFailureState(task, `Autonomous execution failed ${count}/${AutonomousRunnerCore.MAX_RETRY_COUNT}: ${failureDetail}`, 'Todo');
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

      this.scheduleNextHeartbeat();
      })());
    });

    this.scheduler.on('error', ({ task, error, startedAt, projectPath }) => {
      this.trackSchedulerHandler('error', (async () => {
      const taskCtx = this.formatTaskContext(task);
      console.error(`[Scheduler] Task error: ${taskCtx} ${task.title}`, error);
      const timeout = isTimeoutError(error);
      this.recordPipelineHistory(task, {
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
    });

    this.scheduler.on('slotFreed', () => {
      // Auto-execute next task when slot becomes available
      this.trackSchedulerHandler('slotFreed', this.runAvailableTasks());
    });
  }

  protected trackSchedulerHandler(label: string, operation: Promise<void>): void {
    this.schedulerHandlers.add(operation);
    void operation
      .catch((error) => console.error(`[Scheduler] ${label} handler failed:`, error))
      .finally(() => this.schedulerHandlers.delete(operation));
  }


  /**
   * Trigger the next heartbeat as soon as possible.
   *
   * The cron schedule is the periodic reconciliation fallback. Between cron
   * ticks we re-fire immediately when a task wraps up so the next backlog item
   * starts without artificial dead time.
   */
  protected scheduleNextHeartbeat(): void {
    if (this.stopping) return;
    // Explicit-dispatch mode: completion of a dispatched task must not
    // re-enter the autonomous backlog scan — that is exactly the self-selected
    // work `autonomousHeartbeat: false` promises never happens. A user-driven
    // heartbeat() call (dashboard button) remains allowed; only this automatic
    // re-fire is suppressed. (INT-3388)
    if (this.config.autonomousHeartbeat === false) return;
    if (this._nextHeartbeatTimer) return; // already queued
    // Fire on the next event-loop tick so the current scheduler callback
    // returns first (avoids re-entrant heartbeat() while still in `completed`
    // handlers).
    this._nextHeartbeatTimer = setTimeout(() => {
      this._nextHeartbeatTimer = null;
      if (!this.stopping) void this.heartbeat();
    }, 0);
  }


  protected async resolveRunnableCandidates(decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]> {
    const candidates: { task: TaskItem; projectPath: string }[] = [];
    for (const { task } of decisionTasks) {
      if (this.stopping) return candidates;
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        this.syslog(`  Skip (already queued/running): ${task.issueIdentifier || task.id.slice(0, 8)} ${task.title}`);
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);
      if (!projectPath) {
        this.syslog(`✗ Cannot resolve project path for "${task.linearProject?.name || task.title}" — skipping`);
        // Record so it isn't re-picked every heartbeat (starvation). (INT-1875)
        this.unresolvableIssueIds.add(task.issueId || task.id);
        continue;
      }

      if (task.linearProject?.name) {
        this.projectPathCache.set(task.linearProject.name, projectPath);
      }

      if (this.scheduler.isProjectBusy(projectPath)) {
        this.syslog(`  Project busy: ${projectPath}`);
        continue;
      }

      if (this.shouldFilterByEnabled() && !this.isProjectEnabled(projectPath)) {
        this.syslog(`  Project not enabled: ${projectPath}`);
        continue;
      }

      candidates.push({ task, projectPath });
    }

    return candidates;
  }

  protected async detectSafeCandidateIds(candidates: RunnableCandidate[]): Promise<Set<string>> {
    // Group candidates by canonical repository identity for conflict detection.
    // A symlink/relative-path alias must not split one repository into two groups
    // and bypass same-repository conflict serialization.
    const byProject = new Map<string, { task: TaskItem; projectPath: string }[]>();
    for (const c of candidates) {
      const canonicalPath = normalizeProjectPath(c.projectPath);
      const group = byProject.get(canonicalPath) || [];
      group.push(c);
      byProject.set(canonicalPath, group);
    }

    // Detect file conflicts per project using Knowledge Graph
    const safeTasks = new Set<string>(); // task IDs safe to enqueue
    for (const [projPath, group] of byProject) {
      try {
        await Promise.all(group.map(async c => {
          const cacheKey = `${projPath}\0${c.task.id}`;
          // title + description ONLY. trackerUpdatedAt used to ride along here
          // too, but it bumps on every tracker mutation — including the
          // daemon's own progress comments and state transitions, neither of
          // which changes anything the draft actually reads. One issue
          // (AUD-1070, measured 2026-09-10) transitioned state 7 times in a
          // day with an unchanged description and recomputed its draft on
          // every single scheduling pass — attempt_no reached 40, and the
          // in-memory + durable cache (AGT-4286) both had a correct, unused
          // entry the whole time. Title and description are the only inputs
          // that change the draft's CONTENT (see buildDraftPrompt), and both
          // are already separate elements of this array, so an operator edit
          // to either still invalidates — trackerUpdatedAt added no coverage
          // beyond that, only self-inflicted misses. (AGT-4300)
          const fingerprint = JSON.stringify([c.task.title, c.task.description ?? '']);
          const wanted = (c.task.fileScope?.length ?? 0) === 0;
          const apply = (entry: {
            fileScope: string[]; draft: NonNullable<TaskItem['preAdmissionDraft']>;
            description?: string; executionCommentsLoaded?: boolean;
          }): void => {
            c.task.preAdmissionDraft = { ...entry.draft, relevantFiles: [...entry.fileScope] };
            c.task.description = entry.description;
            c.task.executionCommentsLoaded = entry.executionCommentsLoaded;
            // Only a sufficient draft with real files becomes a reservation.
            // Insufficient drafts are still cached (AGT-4288) so we skip the
            // recompute, but they must not masquerade as a known file scope.
            if (entry.draft.sufficient && entry.fileScope.length > 0) {
              c.task.fileScope = [...entry.fileScope];
              c.task.fileScopeSource = 'drafted';
            }
          };

          const cached = this.preAdmissionScopeCache.get(cacheKey);
          if (wanted && cached?.fingerprint === fingerprint) {
            apply(cached);
            return;
          }
          // The in-memory map is a hot path in front of the durable row, not
          // the record itself. It holds 256 entries against ~275 active runs
          // and does not survive a restart, while RETRY_AT backoff is counted
          // in hours — so on its own it missed on nearly every retry and the
          // draft was recomputed at ~$0.0043 a call. (AGT-4286)
          if (wanted) {
            const durable = readDraftCache<NonNullable<TaskItem['preAdmissionDraft']>>(
              c.task.id, fingerprint,
            );
            if (durable) {
              apply(durable);
              this.preAdmissionScopeCache.set(cacheKey, {
                fingerprint, fileScope: [...durable.fileScope], draft: durable.draft,
                description: durable.description,
                executionCommentsLoaded: durable.executionCommentsLoaded,
              });
              return;
            }
          }
          await resolveTaskFileScope(c.task, projPath, {
            draftTask: () => execution.runPreAdmissionDraft(this.getExecCtx(), c.task, projPath),
          });
          // Cache successes AND insufficient briefs. Gating on fileScopeSource
          // === 'drafted' left every failing draft out of the durable store, so
          // the next heartbeat paid for it again (AGT-4288).
          if (c.task.preAdmissionDraft) {
            const entry = {
              fingerprint, fileScope: [...(c.task.fileScope ?? [])], draft: c.task.preAdmissionDraft,
              description: c.task.description,
              executionCommentsLoaded: c.task.executionCommentsLoaded,
            };
            this.preAdmissionScopeCache.delete(cacheKey);
            this.preAdmissionScopeCache.set(cacheKey, entry);
            if (this.preAdmissionScopeCache.size > 256) {
              this.preAdmissionScopeCache.delete(this.preAdmissionScopeCache.keys().next().value!);
            }
            writeDraftCache(c.task.id, entry);
          }
        }));

        // A later heartbeat must compare new candidates with workers that are
        // already editing another worktree. Candidate-vs-candidate detection
        // alone leaves a race window across heartbeat cycles.
        const active = this.scheduler.getRunningTasks()
          .filter(running => normalizeProjectPath(running.projectPath) === projPath);
        // Read the SAME policy the durable admission gate reads
        // (admitsConflictScope, runLedgerScope.ts). While this gate ignored it,
        // `unknownScopeAdmission: admit` was live on vela yet one running task
        // still deferred every other candidate — 11 of 12 slots idle with 126
        // executable tasks waiting (AGT-4233).
        const admission = this.config.unknownScopeAdmission ?? 'admit';
        const runnable = group.filter(candidate => {
          let blockedBy: { label: string; reason: ScopeConflictReason } | undefined;
          for (const running of active) {
            const reason = describeScopeConflict(
              candidate.task.fileScope,
              running.task.fileScope,
              admission,
            );
            if (reason) {
              blockedBy = { label: taskLabel(running.task), reason };
              break;
            }
          }
          if (blockedBy) {
            this.syslog(
              `Conflict with active worktree (${describeConflictCause(blockedBy.reason, blockedBy.label)})`
              + ` — deferring: ${taskLabel(candidate.task)} ${candidate.task.title}`,
            );
          }
          return !blockedBy;
        });
        if (runnable.length === 0) continue;

        const debtKey = (task: TaskItem) => `${projPath}\0${task.id}`;
        for (const candidate of runnable) {
          if ((candidate.task.fileScope?.length ?? 0) > 0) this.unknownScopeDebt.delete(debtKey(candidate.task));
        }
        const debtTask = active.length === 0
          ? runnable.find(candidate =>
            (candidate.task.fileScope?.length ?? 0) === 0
            && this.unknownScopeDebt.has(debtKey(candidate.task)))
          : undefined;
        const runnableTasks = runnable.map(c => c.task);
        const result = debtTask
          ? await detectFileConflicts(runnableTasks, projPath, {
            preferUnknownExclusive: true,
            preferredUnknownTaskId: debtTask.task.id,
            unknownScopeAdmission: admission,
          })
          : await detectFileConflicts(runnableTasks, projPath, {
            unknownScopeAdmission: admission,
          });

        for (const t of result.safe) {
          safeTasks.add(t.id);
          if ((t.fileScope?.length ?? 0) === 0) this.unknownScopeDebt.delete(debtKey(t));
        }
        for (const candidate of runnable) {
          if ((candidate.task.fileScope?.length ?? 0) === 0 && !safeTasks.has(candidate.task.id)) {
            this.unknownScopeDebt.add(debtKey(candidate.task));
          }
        }

        for (const cg of result.conflictGroups) {
          const ids = cg.tasks.map(t => t.issueIdentifier || t.id.slice(0, 8)).join(', ');
          this.syslog(`Conflict group: [${ids}] shared: ${cg.sharedModules.join(', ')}`);
          // 충돌 그룹의 연기된 태스크 로그
          for (const t of cg.tasks) {
            if (!safeTasks.has(t.id)) {
              this.syslog(`Conflict detected — deferring: ${t.issueIdentifier || t.id.slice(0, 8)} ${t.title}`);
            }
          }
        }
      } catch (err) {
        // 분석 실패는 동시 편집 안전성을 증명하지 못한 상태다. 저장소마다
        // 하나만 통과시켜 직렬화하고, 나머지는 다음 heartbeat로 미룬다.
        console.warn(`[AutonomousRunner] Conflict detection failed for ${projPath}:`, err);
        for (const id of failClosedConflictFallback(group)) safeTasks.add(id);
        for (const deferred of group.slice(1)) {
          this.syslog(`Conflict analysis unavailable — serializing: ${deferred.task.issueIdentifier || deferred.task.id.slice(0, 8)} ${deferred.task.title}`);
        }
      }
    }

    return safeTasks;
  }

  /**
   * Re-attempt of a previously failed/rejected issue: carry the last failure
   * feedback into the run so the worker's first iteration addresses it instead
   * of repeating the same mistake blind (INT-2474). Called on BOTH execution
   * paths — parallel enqueue and the serial (maxConcurrentTasks=1) heartbeat.
   */
}
