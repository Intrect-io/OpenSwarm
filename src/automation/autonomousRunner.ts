// OpenSwarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
import { Cron } from 'croner';
import {
  loadTaskState,
  saveTaskState,
  buildProjectsInfo,
  appendPipelineHistory,
  getPipelineHistory,
  aggregateFailureCauses,
  classifyFailureCause,
  incrementRejection,
  clearRejection,
  getRejectionCount,
  isRejectionLimitReached,
  canRetryNow,
  setRetryTime,
  clearRetryTime,
  formatRetryTime,
  getDailyPaceInfo,
  recordProjectCompletion,
  loadProjectSelection,
  saveProjectSelection,
  recordLastFailureDetail,
  pickFailureDetail,
  pickPipelineFailureDetail,
  type LastFailureEntry,
  type TaskState,
  type ProjectInfo,
} from './runnerState.js';
import { taskEventKey, DecisionEngine, DecisionResult, TaskItem, getDecisionEngine, classifyStuck, effectiveProjectScope } from '../orchestration/decisionEngine.js';
import { getCoordinationStore } from '../coordination/coordinationStore.js';
import { OPERATOR_PARK_REASON, shouldReadmitEarly } from '../coordination/operatorAnswers.js';
// ExecutorResult used via execution.reportExecutionResult
import { checkWorkAllowed } from '../support/timeWindow.js';
import { shouldEarlyStuckForInfeasibility } from '../support/feasibilityDetector.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { TaskScheduler, initScheduler, normalizeProjectPath } from '../orchestration/taskScheduler.js';
import {
  PipelineResult,
  formatPipelineResultEmbed,
} from '../agents/pairPipeline.js';
import type { DefaultRolesConfig } from '../core/types.js';
import * as execution from './runnerExecution.js';
import { reportToDiscord, fetchLinearTasks, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { broadcastEvent, type SwarmStats } from '../core/eventHub.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import { getTaskState, upsertTaskState } from '../taskState/store.js';
import { setAutomationDbPath } from './automationDbPath.js';
import {
  findPullRequestForBranch,
  inspectWorktreeRecovery,
  pruneWorktrees,
  removePreservedWorktreeAt,
} from '../support/worktreeManager.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { startEventLoopMonitor } from '../support/eventLoopMonitor.js';
import { STUCK_LABEL } from '../linear/index.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';
import {
  detectFileConflicts,
  fileScopesConflict,
  resolveTaskFileScope,
} from '../orchestration/conflictDetector.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export { pickPipelineFailureDetail } from './runnerState.js';
import type { AdapterName } from '../adapters/types.js';
import { mapModelForProvider as mapModelForAdapter } from '../adapters/modelCompat.js';
import { isTimeoutError } from '../adapters/errorClassification.js';
import {
  applyBacklogGrooming,
  filterGroomableTasks,
  runBacklogGroomingPlanner,
  summarizeGroomingDecision,
} from './backlogGrooming.js';
import {
  DurableRunCoordinator,
  runRecordToTask,
  type ExecutionDurabilityHooks,
  type RepositoryAdmissionPolicy,
} from './durableRunCoordinator.js';
import type { EffectClaim, ImportRunInput, RunLedgerMode } from './runLedger.js';
import { buildCancellationEffect, buildCompletionEffect, completionStats, deliverTrackerEffect } from './trackerEffects.js';

// Re-export types and integration setters (used by service.ts)
export { setNotifier, setTaskSource } from './runnerExecution.js';
export type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export type { ProjectInfo } from './runnerState.js';

let runnerInstance: AutonomousRunner | null = null;
const DECISION_SELECTION_OVERSAMPLE = 3;

/** One source of truth for scheduler, heartbeat, and durable admission. */
export function effectiveProjectConcurrency(config: Pick<AutonomousConfig,
  'allowSameProjectConcurrent' | 'worktreeMode' | 'maxConcurrentPerProject' | 'maxConcurrentTasks'
>): number {
  const globalCap = Math.max(1, Math.floor(config.maxConcurrentTasks ?? 1));
  const parallel = worktreeFanoutEnabled(config);
  if (!parallel) return 1;
  // Match `openswarm review`: fill the available global pool. File-scope
  // conflict analysis and durable admission remain the safety boundary; an
  // omitted per-project setting must not impose a hidden throughput cap.
  const requested = Math.floor(config.maxConcurrentPerProject ?? globalCap);
  return Math.max(1, Math.min(requested, globalCap));
}

/** Worktrees isolate issue execution; integration conflicts are handled later. */
export function worktreeFanoutEnabled(config: Pick<AutonomousConfig,
  'allowSameProjectConcurrent' | 'worktreeMode'
>): boolean {
  return (config.allowSameProjectConcurrent ?? true) && (config.worktreeMode ?? false);
}

export type RunnableCandidate = { task: TaskItem; projectPath: string };

// The completion/cancellation effect payload contract (and its delivery) lives
// in trackerEffects.ts, shared with the `openswarm work` CLI so the marker
// format cannot drift between the two outbox writers. (INT-3387)

/**
 * Conflict analysis is an admission safety check. If it is unavailable, allow
 * only one candidate from that repository so uncertainty cannot turn into
 * concurrent overlapping edits. Input order already reflects decision priority.
 */
export function failClosedConflictFallback(candidates: readonly RunnableCandidate[]): Set<string> {
  return new Set(candidates.length > 0 ? [candidates[0].task.id] : []);
}

export function decisionSelectionBudget(availableSlots: number, candidateCount: number): number {
  const slots = Math.max(0, Math.floor(availableSlots));
  const candidates = Math.max(0, Math.floor(candidateCount));
  if (slots === 0 || candidates === 0) return 0;
  return Math.min(candidates, Math.max(slots, slots * DECISION_SELECTION_OVERSAMPLE));
}

/**
 * Prefix stamped on a NEEDS_HUMAN run's `lastErrorMessage` when this file
 * parked it for a repeated, unanswered `ask_human` question (AGT-4042).
 *
 * `markNeedsHuman` is shared with unrelated parks (a rejection limit, a PR
 * closed without merge — see the other call sites in this file), each with its
 * own resume condition. This is how the filter below tells "this one resumes
 * when the operator answers" from "this one resumes when Linear state changes"
 * without adding a second column or state for what is still one ledger state.
 */
const OPERATOR_QUESTION_PARK_MARKER = '[operator-question]';

/**
 * Record, or retire, the stand-in park signal for a task whose park cannot be
 * carried by the run ledger.
 *
 * Best effort in both directions, and deliberately so. Failing to record leaves
 * the task on its backoff, which is only a delay. Failing to retire costs at
 * most one early retry, still capped by MAX_RETRY_COUNT — whereas refusing to
 * admit the task until the write succeeds could stall it for good.
 */
function setOperatorPark(issueId: string, parked: boolean): void {
  try {
    upsertTaskState(issueId, {
      execution: { blockedReason: parked ? OPERATOR_PARK_REASON : undefined },
    } as Parameters<typeof upsertTaskState>[1]);
  } catch (error) { // cxt-ignore: error_swallow — the backoff is the fallback
    console.warn(`[AutonomousRunner] Could not record the operator park for ${issueId}:`, error);
  }
}

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
  private scheduler: TaskScheduler;
  private readonly durableRuns: DurableRunCoordinator;
  private outboxDrain: Promise<void> | null = null;
  private readonly schedulerHandlers = new Set<Promise<void>>();
  /** Adapter default-model cache for the dashboard PAIR bar (INT-2393). */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();
  private cronJob: Cron | null = null;
  private periodicReviewJobs: Cron[] = [];
  private orchestratorJob: Cron | null = null;
  private startupHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private state: RunnerState = {
    isRunning: false,
    lastHeartbeat: 0,
    consecutiveErrors: 0,
  };

  // Heartbeat concurrency guard
  private _heartbeatRunning = false;
  private heartbeatCompletion: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopEventLoopMonitor: (() => void) | null = null;
  private deferredShutdownCleanup: Promise<void> | null = null;
  private durableRunsClosed = false;

  // Explicitly enabled project paths (allow-list; empty = nothing runs ONLY once
  // the selection has been touched — see projectSelectionTouched).
  private enabledProjects = new Set<string>();

  // Whether the user has explicitly enabled/disabled any project (dashboard/CLI).
  // Before this, an empty enabledProjects means "no selection yet → all allowed
  // projects run" (legacy fallback). After, an empty set means "nothing runs" —
  // so disabling every project actually stops the daemon. (INT-2207)
  private projectSelectionTouched = false;

  /**
   * macOS (APFS default) and Windows have case-insensitive filesystems by
   * default, so `/Users/x/dev/AnalogModeling` and `/Users/x/dev/analogModeling`
   * refer to the same directory. Do the enabled-set comparison in a case-
   * insensitive way on those platforms so UI-captured casing doesn't
   * mismatch Linear's project-name casing.
   */
  private get pathsCaseInsensitive(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  private normalizePath(p: string): string {
    const canonical = normalizeProjectPath(p);
    return this.pathsCaseInsensitive ? canonical.toLowerCase() : canonical;
  }

  /** Check if a resolved path is under any enabled project */
  private isProjectEnabled(resolvedPath: string): boolean {
    if (this.enabledProjects.size === 0) return false;
    const needle = this.normalizePath(resolvedPath);
    for (const enabled of this.enabledProjects) {
      const hay = this.normalizePath(enabled);
      if (hay === needle) return true;
      if (needle.startsWith(hay + '/')) return true;
    }
    return false;
  }

  /**
   * Whether to apply the enabledProjects allow-list. True once the user has made
   * an explicit selection (touched), OR while any project is enabled. Empty +
   * untouched stays the legacy "run all allowed projects" fallback. (INT-2207)
   */
  private shouldFilterByEnabled(): boolean {
    return this.projectSelectionTouched || this.enabledProjects.size > 0;
  }

  private sameProjectCandidateCap(): number | null {
    const sameProjectParallel = (this.config.allowSameProjectConcurrent ?? true) && (this.config.worktreeMode ?? false);
    return sameProjectParallel ? effectiveProjectConcurrency(this.config) : null;
  }

  private currentProjectLoad(projectPath: string): number {
    const target = normalizeProjectPath(projectPath);
    const queued = this.scheduler.getQueuedTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    const running = this.scheduler.getRunningTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    return queued + running;
  }

  private canQueueProjectCandidate(projectPath: string): boolean {
    const cap = this.sameProjectCandidateCap();
    if (cap == null) return true;
    return this.currentProjectLoad(projectPath) < cap;
  }

  /** Persist the project selection so it survives a restart. No-op under dryRun
   * (tests) to avoid touching the real ~/.openswarm. (INT-2208) */
  private persistSelection(): void {
    if (this.config.dryRun) return;
    saveProjectSelection({ enabled: [...this.enabledProjects], touched: this.projectSelectionTouched });
  }

  // Last fetched Linear tasks (for dashboard display)
  private lastFetchedTasks: TaskItem[] = [];

  // Cache: linearProjectName → resolvedLocalPath (populated during task execution)
  private projectPathCache = new Map<string, string>();

  // Max pace: the daemon always runs at full throughput (concurrency +
  // heartbeat come from config). This flag is now ON by default and never
  // expires — it used to default false and auto-expire after 4h, so every
  // restart silently dropped the dashboard back to "TURBO off" even though real
  // throughput (maxConcurrentTasks + heartbeat) was unchanged. Kept as a manual
  // escape hatch (Discord/dashboard can still toggle it off).
  private turboMode = true;
  private turboExpiresAt: number | null = null;

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private failedTaskRetryTimes = new Map<string, number>(); // issueId → next retry timestamp (ms)

  /**
   * Bring a durably backed-off run forward because its answer landed.
   *
   * Both halves are required: the ledger refuses to claim a `RETRY_AT` row whose
   * time has not come, so letting the task past the heartbeat filter without
   * promoting it would select it and then fail to claim it, every cycle.
   *
   * The promotion re-checks the park itself, so what `answerArrivedFor` reads is
   * only a filter — a second daemon can end the parked attempt in between, and
   * the failure that replaces it must keep its own backoff.
   */
  private readmitAnsweredRun(issueId: string): boolean {
    if (!this.answerArrivedFor(issueId)) return false;
    if (!this.durableRuns.readmitParkedRun(issueId, OPERATOR_PARK_REASON)) return false;
    clearRetryTime(issueId, this.failedTaskRetryTimes);
    return true;
  }

  /**
   * Whether a task parked on the operator now has its answer.
   *
   * Scoped by task id — the Linear issue id, unique per task — so an answer meant
   * for one agent can never spring another that happens to share a display name
   * (the guard added in AGT-4030 is upheld, not bypassed).
   *
   * The park is read off the run's own ledger row rather than a flag kept beside
   * it, so it expires with the attempt that caused it: a task that waited out its
   * backoff and then failed for its own reasons carries that failure's code here,
   * and an answer from a park it has left cannot pull it forward.
   */
  /**
   * Whether the task is stopped waiting on the operator, read from whichever
   * store is authoritative for it — the same split the selection filter makes.
   *
   * With the ledger in charge the park is the run's own error code, so it expires
   * with the attempt that caused it. Elsewhere no such code is written (`shadow`
   * noops its transitions, `off` has no ledger at all), so a task-state signal
   * stands in — retired by the filter when the task is admitted, to give it the
   * same lifetime rather than one nobody maintains.
   */
  private parkedOnOperator(issueId: string): boolean {
    const durableRun = this.durableRuns.getRun(issueId);
    if (this.durableRuns.isPrimary && durableRun) {
      return durableRun.lastErrorCode === OPERATOR_PARK_REASON;
    }
    return getTaskState(issueId)?.execution?.blockedReason === OPERATOR_PARK_REASON;
  }

  private answerArrivedFor(issueId: string): boolean {
    try {
      return shouldReadmitEarly({
        parkedOnOperator: this.parkedOnOperator(issueId),
        allQuestionsAnswered: getCoordinationStore().allQuestionsAnswered(issueId),
      });
    } catch { // cxt-ignore: error_swallow — an unreadable board must not stall the heartbeat
      return false;
    }
  }
  // Last failure feedback per issue — re-injected into the next attempt's worker
  // prompt so re-picked tasks don't restart blind and repeat the same mistake
  // the reviewer already called out (INT-2474). Persisted; cleared on success.
  private lastFailureDetails = new Map<string, LastFailureEntry>();
  private static readonly MAX_RETRY_COUNT = 4; // Increased from 2 to allow more retries with backoff

  // Rate-limit hold: epoch ms until which all task execution is paused.
  // Set when any adapter returns a 429 / usage_limit_reached response (INT-1906).
  private rateLimitUntil = 0;

  // Issues whose Linear project can't be mapped to a local repo path. Recorded on
  // the first resolve failure so they aren't re-picked every heartbeat (which
  // starved other actionable tasks — they were top-priority but never runnable). (INT-1875)
  private unresolvableIssueIds = new Set<string>();
  private lastBacklogGroomingAt = 0;

  private get taskStateRef(): TaskState {
    return {
      completedTaskIds: this.completedTaskIds,
      failedTaskCounts: this.failedTaskCounts,
      failedTaskRetryTimes: this.failedTaskRetryTimes,
      lastFailureDetails: this.lastFailureDetails,
    };
  }

  private loadTaskState(): void {
    loadTaskState(this.taskStateRef);
  }

  private saveTaskState(): void {
    saveTaskState(this.taskStateRef);
  }

  private formatTaskContext(task: TaskItem): string {
    const parts: string[] = [];
    if (task.linearProject?.name) parts.push(`[${task.linearProject.name}]`);
    if (task.issueIdentifier) parts.push(task.issueIdentifier);
    else if (task.issueId) parts.push(task.issueId.slice(0, 8));
    return parts.length > 0 ? parts.join(' ') : '';
  }

  constructor(config: AutonomousConfig) {
    this.config = config;
    // Config files may retain model pins from a previous provider. Normalize
    // them before the first heartbeat; switchProvider() used to do this only
    // after a live dashboard toggle, so a restart leaked OpenRouter model ids
    // into codex-responses and failed every fresh worker call.
    this.applyProviderConfig(config.defaultAdapter ?? 'codex', false);
    this.loadTaskState();  // Restore completed/failed task IDs from disk
    // Restore the persisted project selection so "disable all" survives a daemon
    // restart. Skipped under dryRun (tests) so the real ~/.openswarm isn't touched. (INT-2208)
    if (!config.dryRun) {
      const sel = loadProjectSelection();
      this.enabledProjects = new Set(sel.enabled.map((projectPath) => normalizeProjectPath(projectPath)));
      this.projectSelectionTouched = sel.touched;
    }
    this.engine = getDecisionEngine({
      allowedProjects: config.allowedProjects,
      linearTeamId: config.linearTeamId,
      autoExecute: config.autoExecute,
      maxConsecutiveTasks: config.maxConsecutiveTasks,
      cooldownSeconds: config.cooldownSeconds,
      dryRun: config.dryRun,
      includeBacklog: config.includeBacklog,
      // Same-project parallel selection only makes sense when the scheduler can
      // actually run those tasks concurrently (worktree isolation). (INT-2318)
      sameProjectParallel: (config.allowSameProjectConcurrent ?? true) && (config.worktreeMode ?? false),
    });

    // Initialize TaskScheduler
    // Same-repo parallelism is opt-in via config (default true) but the scheduler
    // force-disables it unless worktreeMode is on — see TaskScheduler guard. (INT-1975)
    this.scheduler = initScheduler({
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: config.allowSameProjectConcurrent ?? true,
      maxConcurrentPerProject: effectiveProjectConcurrency(config),
      worktreeMode: config.worktreeMode ?? false,
    });

    const ledgerMode: RunLedgerMode = config.automationLedgerMode
      ?? (config.dryRun ? 'off' : 'primary');
    this.durableRuns = new DurableRunCoordinator({
      mode: ledgerMode,
      dbPath: config.automationDbPath,
      leaseMs: config.automationLeaseMs,
      maxActiveForProject: effectiveProjectConcurrency(config),
    });

    // Set up scheduler event handling
    this.setupSchedulerEvents();
  }

  private setupSchedulerEvents(): void {
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
      await reportToDiscord(formatPipelineResultEmbed(result));

      // Track as completed ONLY on success to prevent re-selection (persist to disk)
      if (task.issueId && result.success && !this.durableRuns.isPrimary) {
        this.completedTaskIds.add(task.issueId);
        clearRejection(task.issueId); // Clear rejection count on success
        clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry backoff time
        this.lastFailureDetails.delete(task.issueId); // Stale feedback must not haunt future work
        this.saveTaskState();
        // Track project-level pace (5h rolling window)
        const projectName = task.linearProject?.name ?? 'unknown';
        recordProjectCompletion(projectName, result.totalCost?.costUsd);
      }

      // Skip completion handling when another open PR already owns the planned
      // files. Both cases have a different coordination surface for completion.
      if (result.finalStatus === 'decomposed') {
        console.log(`[Scheduler] Task ${result.finalStatus}; skipping Done state`);
        this.scheduleNextHeartbeat();
        return;
      }

      if (result.success && task.issueId && this.durableRuns.isPrimary) {
        await this.drainDurableOutbox().catch((error) =>
          console.error('[Outbox] Completion delivery pass failed:', error));
        const durableState = this.durableRuns.getRun(task.issueId)?.state;
        if (durableState === 'DONE') {
          recordProjectCompletion(task.linearProject?.name ?? 'unknown', result.totalCost?.costUsd);
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
        // Without an authoritative ledger there is no error code to carry the
        // park, so record the stand-in signal the heartbeat reads instead.
        if (!this.durableRuns.isPrimary) setOperatorPark(parkedId, true);

        // A re-dispatch is a fresh worker session, and asking again is not
        // free — a worker+reviewer cycle burned on a question the operator
        // has already been paged for once and not answered. Past the first
        // unanswered ask, stop the automatic retry loop entirely instead of
        // paying for another one on a fixed clock: NEEDS_HUMAN drops the
        // task out of heartbeat selection until the resume check finds it
        // answered, or an operator otherwise reopens it (AGT-4042). Durable
        // mode only — legacy mode has no ledger error code to gate the stop
        // on, so it keeps the fixed-backoff ladder above.
        //
        // Counted as consecutive ATTEMPTS, not distinct board correlation
        // IDs: a worker that asks with identical wording every time never
        // mints a second correlation ID (the paging gate above collapses it
        // to one), so a count keyed on wording would never see more than 1 no
        // matter how many times it was actually re-dispatched and asked.
        // Bounded by the task's last operator answer, so a resumed run's
        // first ask on a brand-new question does not share a streak with the
        // answered attempt before it.
        const lastAnsweredAt = getCoordinationStore().lastAnsweredAt(parkedId);
        const consecutiveAsks = this.durableRuns.consecutiveAttemptsWithErrorCode(
          parkedId, OPERATOR_PARK_REASON, lastAnsweredAt,
        );
        if (this.durableRuns.isPrimary && consecutiveAsks >= 2) {
          this.durableRuns.markNeedsHuman(
            parkedId,
            `${OPERATOR_QUESTION_PARK_MARKER} asked ${consecutiveAsks} times with no answer — stopped retrying automatically`,
          );
          console.log(`[Scheduler] Parking ${taskCtx} — asked ${consecutiveAsks}x with no answer, stopped auto-retry until the operator answers or reopens it`);
        } else {
          const nextRetryTime = setRetryTime(parkedId, 4, this.failedTaskRetryTimes);
          this.saveTaskState();
          console.log(`[Scheduler] Re-admitting ${taskCtx} ${formatRetryTime(nextRetryTime)}, or sooner if the operator answers`);
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
        const detail = result.workerResult?.error || result.reviewResult?.feedback || 'infra/CLI execution error';
        if (task.issueId) {
          // Fixed mid-range backoff — we intentionally don't bump failure counts,
          // so there's no attempt number to scale by.
          const nextRetryTime = setRetryTime(task.issueId, 3, this.failedTaskRetryTimes);
          this.saveTaskState();
          console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK) — backoff retry ${formatRetryTime(nextRetryTime)}: ${detail}`);
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
          clearRejection(task.issueId);
          recordLastFailureDetail(this.taskStateRef, task.issueId, infeasDetail);
          if (this.durableRuns.isPrimary) {
            this.durableRuns.markNeedsHuman(
              task.issueId,
              `DoD appears unsatisfiable in the sandbox after ${attempts} attempts: ${infeasible.marker}`,
            );
          }
          this.saveTaskState();
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }
          try {
            await execution.syncFailureState(task,
              `Needs human — DoD appears unsatisfiable in the sandbox (marker: "${infeasible.marker}") after ${attempts} attempts`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `**Needs human — the DoD appears unsatisfiable in this sandbox.**\n\n` +
              `Detected blocker phrase: "${infeasible.marker}". Re-running can't fix an environmental ` +
              `impossibility (missing DB / network / credentials, or a manual/human step), so automatic ` +
              `retries were stopped early after ${attempts} attempts.\n\n**Latest failure:**\n${infeasDetail}`);
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
          if (this.durableRuns.isPrimary) {
            this.durableRuns.markNeedsHuman(task.issueId, `Reviewer rejected ${rejectionCount} attempts: ${feedback}`);
          }
          this.saveTaskState();
          // Terminally stuck → no retry will resume the preserved tree; commit
          // the partial work to the branch and free the disk (INT-2506).
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }

          try {
            await execution.syncFailureState(task, `Max rejection limit reached (${rejectionCount} attempts): ${feedback}`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `Rejected ${rejectionCount} times by the reviewer — automatic retries exhausted.\n\n` +
              `**Latest rejection reason:**\n${feedback}`
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

        if (count >= AutonomousRunner.MAX_RETRY_COUNT) {
          // Max retries exceeded - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          if (this.durableRuns.isPrimary) {
            this.durableRuns.markNeedsHuman(
              task.issueId,
              `Autonomous execution failed ${count} times: ${failureDetail}`,
            );
          }
          this.saveTaskState();
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx} — STUCK`);
          // Terminally stuck → commit partial work to the branch, free the disk (INT-2506).
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }
          try {
            await execution.syncFailureState(task, `Autonomous execution failed ${count} times: ${failureDetail}`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `Autonomous execution failed ${count} times in a row — automatic retries exhausted.\n\n` +
              `**Last failure:**\n${failureDetail}`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (max retries exceeded)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
        } else {
          // Schedule retry with exponential backoff
          const nextRetryTime = setRetryTime(task.issueId, count, this.failedTaskRetryTimes);
          const retryIn = formatRetryTime(nextRetryTime);
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx} — retry ${retryIn}`);
          this.saveTaskState();
          await execution.syncFailureState(task, `Autonomous execution failed ${count}/${AutonomousRunner.MAX_RETRY_COUNT}: ${failureDetail}`, 'Todo');
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

  private trackSchedulerHandler(label: string, operation: Promise<void>): void {
    this.schedulerHandlers.add(operation);
    void operation
      .catch((error) => console.error(`[Scheduler] ${label} handler failed:`, error))
      .finally(() => this.schedulerHandlers.delete(operation));
  }

  private filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] {
    let recovered = 0;
    let stuckSkipped = 0;
    let backoffSkipped = 0;
    let answered = 0;
    let noProject = 0;
    let unresolvable = 0;
    const toUnstick: string[] = [];
    const filtered = tasks.filter(task => {
      const id = task.issueId || task.id;
      const isStuck = task.labels?.includes(STUCK_LABEL) ?? false;
      let durableRun = this.durableRuns.getRun(id);

      if (
        this.durableRuns.isPrimary
        && durableRun
        && (
          durableRun.state === 'DONE'
          || durableRun.state === 'DECOMPOSED'
          || durableRun.state === 'CANCELLED'
        )
        && task.linearState === 'Todo'
        && this.durableRuns.markReady(id)
      ) {
        durableRun = this.durableRuns.getRun(id);
      }

      if (this.durableRuns.isPrimary && durableRun?.state === 'NEEDS_HUMAN') {
        // The two resume conditions are mutually exclusive by why the run was
        // parked, not layered as "either one fires it." An ask_human park
        // (marker prefix) leaves the Linear card exactly where it already was
        // — the pipeline never touches it — which for an active task is
        // routinely 'Todo' or 'In Progress' already; the pre-existing
        // linearState check would then resume it on the very next heartbeat
        // regardless of an answer, undoing the park before it did anything.
        // So it resumes ONLY on its own condition — the question got
        // answered — and the rejection-limit / PR-closed-without-merge parks
        // elsewhere in this file, which share NEEDS_HUMAN but DO move the
        // card (a STUCK label / Backlog), keep resuming only on that Linear
        // change.
        const isOperatorQuestionPark = durableRun.lastErrorMessage?.startsWith(OPERATOR_QUESTION_PARK_MARKER) ?? false;
        const linearReopened = !isOperatorQuestionPark
          && ['Todo', 'In Progress', 'In Review'].includes(task.linearState ?? '');
        // Read from the durable trace, not the live board: a busy task's own
        // traffic can push its unanswered question out of a board window, and
        // `openQuestionCount` would then read that as "no questions open" —
        // resuming a run that is still genuinely waiting.
        const questionAnswered = isOperatorQuestionPark && getCoordinationStore().allQuestionsAnswered(id);
        if (linearReopened || questionAnswered) {
          const resumed = this.durableRuns.resumeNeedsHuman(id);
          if (resumed) {
            durableRun = this.durableRuns.getRun(id);
            if (resumed === 'SYNC_PENDING') this.scheduleNextHeartbeat();
          }
        }
      }

      if (this.durableRuns.isPrimary && durableRun) {
        if (['DONE', 'DECOMPOSED', 'CANCELLED', 'NEEDS_HUMAN'].includes(durableRun.state)) return false;
        if (['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING', 'SYNC_PENDING', 'NEEDS_RECONCILE'].includes(durableRun.state)) return false;
        if (durableRun.state === 'RETRY_AT' && (durableRun.retryAt ?? 0) > Date.now()) {
          // Unless the only thing it was waiting for has arrived. A task parked
          // on `ask_human` sits here, and this backoff is also its resume path,
          // so left alone it makes the operator's reply land up to two hours
          // after they sent it. `markReady` is what actually unblocks it: the
          // ledger refuses to claim a RETRY_AT row whose time has not come, so
          // passing this filter alone would change nothing.
          if (!this.readmitAnsweredRun(id)) {
            backoffSkipped++;
            return false;
          }
          durableRun = this.durableRuns.getRun(id);
          answered++;
        }
      }

      // No Linear project → can't be routed to a repo. Drop here (quietly, once per
      // heartbeat) instead of letting a whole batch of project-less Todos reach the
      // per-task selector and spam "No repo mapped to ... undefined" every cycle.
      if (!task.linearProject?.id) {
        noProject++;
        return false;
      }

      // Project resolved to no local repo on a previous heartbeat → don't re-pick
      // it (it would starve runnable tasks behind it). (INT-1875)
      if (this.unresolvableIssueIds.has(id)) {
        unresolvable++;
        return false;
      }

      const legacyIsAuthority = !this.durableRuns.isPrimary || !durableRun;

      // Check rejection limit first. Once an issue has a durable row, the
      // imported ledger state replaces legacy JSON counters as authority.
      if (legacyIsAuthority && isRejectionLimitReached(id)) {
        return false; // Skip tasks that hit max rejection limit
      }

      // Stuck handling (INT-1908): a permanently-blocked issue is parked in Backlog
      // with the `swarm:stuck` label and must NOT be retried automatically. The
      // recovery branch only fires when the user pulls the issue back to an active
      // state — the previous code re-selected it every heartbeat because blocking
      // left it in Todo (a recoverable state), which the recovery branch then
      // mistook for deliberate user intervention.
      const hasFailureHistory = legacyIsAuthority
        && (this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT);
      const stuckDecision = classifyStuck({ isStuck, linearState: task.linearState, hasFailureHistory });
      if (stuckDecision === 'recover') {
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id); // Clear rejection count on recovery
        clearRetryTime(id, this.failedTaskRetryTimes); // Clear retry backoff time
        if (isStuck) toUnstick.push(id); // strip the stuck label so it is not re-skipped
        recovered++;
        return true;
      }
      if (stuckDecision === 'skip-stuck') {
        // Durable across restarts: the label lives on the Linear issue, not in the
        // in-memory counters that a restart would lose.
        stuckSkipped++;
        return false;
      }

      if (legacyIsAuthority && this.completedTaskIds.has(id)) return false;
      if (legacyIsAuthority && (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT) return false;

      // External-claim guard (INT-1979 dup): an issue set to 'In Progress' that THIS
      // daemon never claimed is owned by a human or another agent — picking it up
      // would re-decompose work someone is already doing (that spawned duplicate
      // INT-1980 sub-issues + a redundant PR). markTaskInProgress writes
      // execution.status='in_progress' when WE claim, so our own in-flight work
      // (incl. resumption after a restart) still passes; a bare Linear 'In Progress'
      // with no local claim record is skipped.
      if (task.linearState === 'In Progress') {
        if (this.durableRuns.isPrimary) {
          // Comments/local JSON are context, not ownership authority. Only a
          // durable crashed-run record may resume an externally In Progress card.
          if (!durableRun || !['NEEDS_RECONCILE', 'READY', 'RETRY_AT'].includes(durableRun.state)) return false;
        } else if (getTaskState(id)?.execution?.status !== 'in_progress') {
          return false;
        }
      }

      if (legacyIsAuthority) {
        // Check if task is in exponential backoff period — unless the only thing
        // it was waiting for has arrived. The backoff is also the resume path for
        // an `ask_human` park, so left alone it makes the operator's reply land
        // up to two hours after they sent it.
        if (!canRetryNow(id, this.failedTaskRetryTimes)) {
          if (!this.answerArrivedFor(id)) {
            backoffSkipped++;
            return false; // Skip tasks still in backoff period
          }
          clearRetryTime(id, this.failedTaskRetryTimes);
          answered++;
        }
        // Admitted, so the park is spent — retire it here and it expires with the
        // attempt that caused it, the way the ledger's error code does. Left set,
        // an answer from a park the task has long since left would pull it
        // forward past every later backoff.
        if (getTaskState(id)?.execution?.blockedReason === OPERATOR_PARK_REASON) {
          setOperatorPark(id, false);
        }
      }

      return true;
    });
    // Strip the stuck label from issues the user pulled back (fire-and-forget — a
    // failed unstick just means the next heartbeat tries again).
    for (const id of toUnstick) {
      getTaskSource()?.unstick(id).catch(err =>
        console.warn(`[AutonomousRunner] Failed to clear stuck label for ${id}:`, err));
    }
    if (stuckSkipped > 0) {
      this.syslog(`🛑 Skipped ${stuckSkipped} stuck issue(s) (retries exhausted — remove the \`${STUCK_LABEL}\` label or move to Todo / In Progress to retry)`);
    }
    if (recovered > 0) {
      this.saveTaskState();
      this.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
    }
    if (backoffSkipped > 0) {
      this.syslog(`⏰ Skipped ${backoffSkipped} tasks in exponential backoff period`);
    }
    if (answered > 0) {
      this.syslog(`🙋 Re-admitted ${answered} task(s) early — the operator answered`);
    }
    if (noProject > 0) {
      this.syslog(`— Skipped ${noProject} issue(s) with no Linear project (assign a project in Linear to enable)`);
    }
    if (unresolvable > 0) {
      this.syslog(`— Skipped ${unresolvable} issue(s) whose Linear project maps to no local repo (fix the project or add the repo)`);
    }
    return filtered;
  }

  /**
   * Trigger the next heartbeat as soon as possible.
   *
   * Historically this used a "pace-aware cooldown" that grew quadratically
   * with daily completion count (ratio² × 3 multiplier) on top of a 30-minute
   * baseline — the swarm would slow itself down dramatically after a few
   * tasks. That was removed by user request: the cron schedule
   * (`config.heartbeatSchedule`) is now the only knob, and between cron
   * ticks we re-fire immediately when a task wraps up so the next backlog
   * item starts without artificial dead time.
   */
  private _nextHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleNextHeartbeat(): void {
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

  private async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // Parallel processing disabled
    }

    await this.scheduler.runAvailable(async (task, projectPath, signal) => {
      return this.executeDurably(task, projectPath, signal);
    });
  }

  private async executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult> {
    const cancelled = (): PipelineResult => ({
      success: false,
      sessionId: `runner-stopping-${Date.now()}`,
      stages: [],
      finalStatus: 'cancelled',
      totalDuration: 0,
      iterations: 0,
      taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
    });
    if (this.stopping || signal?.aborted) return cancelled();

    let admission: RepositoryAdmissionPolicy;
    try {
      const metadata = await loadRepoMetadata(projectPath);
      if (metadata?.automation?.enabled === false) {
        return {
          success: false,
          sessionId: `repo-admission-disabled-${Date.now()}`,
          stages: [],
          finalStatus: 'superseded',
          totalDuration: 0,
          iterations: 0,
          taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
        };
      }
      const sameRepoParallelAllowed = worktreeFanoutEnabled(this.config);
      admission = {
        maxConcurrent: sameRepoParallelAllowed
          ? (metadata?.automation?.maxConcurrent ?? effectiveProjectConcurrency(this.config))
          : 1,
        // Each issue gets its own worktree in fan-out mode. Overlapping files
        // may conflict when branches integrate, but must not serialize workers.
        conflictScope: sameRepoParallelAllowed ? undefined : task.fileScope,
        // A fixed default attempt budget of 12 made a 32-slot daemon trip its
        // repository circuit before the first pool could even fill. Treat this
        // as an explicit repository policy; failure and cost circuits remain
        // independent safety boundaries.
        maxAttemptsPerHour: metadata?.automation?.maxAttemptsPerHour,
        maxFailuresPerHour: metadata?.automation?.maxFailuresPerHour ?? 6,
        maxCostUsdPerDay: metadata?.automation?.maxCostUsdPerDay,
        circuitCooldownMs: (metadata?.automation?.circuitCooldownMinutes ?? 60) * 60_000,
      };
    } catch (error) {
      console.error(`[Admission] Invalid/unreadable repository policy for ${projectPath}:`, error);
      return {
        success: false,
        sessionId: `repo-admission-error-${Date.now()}`,
        stages: [],
        finalStatus: 'infra_error',
        totalDuration: 0,
        iterations: 0,
        taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
      };
    }

    if (this.stopping || signal?.aborted) return cancelled();

    return this.durableRuns.execute(
      task,
      projectPath,
      (durability, leaseSignal) => this.executePipeline(
        task,
        projectPath,
        signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal,
        durability,
      ),
      {
        admission,
        successEffect: (result, claim) => buildCompletionEffect(task, result, claim.attemptNo),
        cancelEffect: (_result, claim) => buildCancellationEffect(task, claim.attemptNo),
        retryCancellation: () => this.stopping,
      },
    );
  }

  private async reconcileDurableArtifacts(tasks: TaskItem[]): Promise<void> {
    if (!this.durableRuns.isPrimary || this.stopping) return;
    const taskById = new Map(tasks.map((task) => [task.issueId || task.id, task]));

    for (const run of this.durableRuns.listRuns(['NEEDS_RECONCILE'])) {
      if (this.stopping) return;
      // A task may legitimately be absent: the fetch asks only for Todo /
      // In Progress / In Review / Backlog, so an issue that reached Done is
      // structurally invisible here. That makes absence ambiguous for the
      // worktree path below — which re-runs work — but not for the branch
      // path, where GitHub is the authority. So the guard moved down to the
      // one place it actually protects something. (AGT-4094)
      const task = taskById.get(run.issueId);
      if (run.ownerInstanceId || run.leaseToken) {
        // Not "until its executor exits": a container restart replaces the
        // process holding the claim, so that exit is never observed and the
        // line reads as a permanent wedge. What actually frees the row is the
        // age sweep in durableRunCoordinator, so report its deadline. (AGT-4126)
        console.warn(this.durableRuns.fenceWaitMessage(run));
        continue;
      }

      if (run.branchName) {
        let pr;
        try {
          pr = await findPullRequestForBranch(run.projectPath, run.branchName);
        } catch (error) {
          console.warn(`[Reconciler] GitHub lookup failed for ${run.identifier ?? run.issueId}; keeping NEEDS_RECONCILE:`, error);
          continue;
        }

        if (pr) {
          if (pr.state === 'CLOSED') {
            this.durableRuns.markNeedsHuman(run.issueId, `Published PR was closed without merge: ${pr.url}`);
            continue;
          }
          const publishedTask = task ?? runRecordToTask(run);
          const recoveredResult: PipelineResult = {
            success: true,
            sessionId: `recovered-publication-${run.attemptNo}`,
            stages: [],
            finalStatus: 'approved',
            totalDuration: 0,
            iterations: Math.max(1, run.attemptNo),
            prUrl: pr.url,
            taskContext: {
              issueIdentifier: publishedTask.issueIdentifier || run.identifier,
              projectName: publishedTask.linearProject?.name,
              projectPath: run.projectPath,
              taskTitle: publishedTask.title,
            },
          };
          if (this.durableRuns.recoverPublishedRun(
            run.issueId,
            { prUrl: pr.url, headSha: pr.headSha },
            buildCompletionEffect(publishedTask, recoveredResult, run.attemptNo),
          )) {
            console.log(`[Reconciler] Recovered published run ${run.identifier ?? run.issueId}: ${pr.url}`);
          }
          continue;
        }
      }

      // No PR exists, so nothing was published and the only way out of this
      // state is to run the work again — which needs a live tracker card.
      // Log it: this branch used to be the loop's one silent exit, which is
      // exactly why a row stuck here was invisible to log-reading. (AGT-4094)
      if (!task) {
        console.warn(`[Reconciler] Keeping ${run.identifier ?? run.issueId} in NEEDS_RECONCILE (no published PR and no actionable task)`);
        continue;
      }

      // Never overlap a replacement with an executor that lost its lease but
      // still owns the filesystem. Missing/ambiguous markers stay parked;
      // preserved work or a dead owner is safe for createWorktree to resume.
      const recovery = await inspectWorktreeRecovery(run.projectPath, run.issueId, run.worktreePath)
        .catch((error) => {
          console.warn(`[Reconciler] Worktree evidence unreadable for ${run.identifier ?? run.issueId}:`, error);
          return null;
        });
      if (!recovery || recovery.state === 'active_owner' || recovery.state === 'ambiguous') {
        console.warn(`[Reconciler] Keeping ${run.identifier ?? run.issueId} in NEEDS_RECONCILE (${recovery?.state ?? 'inspection_failed'})`);
        continue;
      }
      if (this.durableRuns.markReady(run.issueId)) {
        console.log(`[Reconciler] ${recovery.state === 'missing' ? 'Reopening branch' : 'Resuming worktree'} for ${run.identifier ?? run.issueId}`);
      }
    }
    await this.drainDurableOutbox();
  }

  private async migrateLegacyRunState(tasks: TaskItem[]): Promise<void> {
    if (!this.durableRuns.isPrimary || this.stopping) return;
    let imported = 0;
    for (const task of tasks) {
      if (this.stopping) return;
      const issueId = task.issueId || task.id;
      if (this.durableRuns.getRun(issueId)) continue;

      const canonical = getTaskState(issueId);
      const failedCount = this.failedTaskCounts.get(issueId) ?? 0;
      const retryAt = this.failedTaskRetryTimes.get(issueId);
      const legacyCompleted = this.completedTaskIds.has(issueId);
      const canonicalStatus = canonical?.execution.status;
      const hasLegacySignal = legacyCompleted
        || failedCount > 0
        || retryAt != null
        || ['in_progress', 'in_review', 'failed', 'halted', 'done', 'decomposed'].includes(canonicalStatus ?? '');
      if (!hasLegacySignal) continue;

      const projectPath = task.projectPath ?? await this.resolveProjectPath(task);
      if (!projectPath || this.stopping) continue;

      let state: ImportRunInput['state'];
      let reason: string;
      if (
        task.labels?.includes(STUCK_LABEL)
        || failedCount >= AutonomousRunner.MAX_RETRY_COUNT
        || isRejectionLimitReached(issueId)
        || canonicalStatus === 'failed'
        || canonicalStatus === 'halted'
      ) {
        state = 'NEEDS_HUMAN';
        reason = 'Legacy state indicates exhausted or human-blocked execution';
      } else if (canonicalStatus === 'done' || task.linearState === 'Done') {
        state = 'DONE';
        reason = 'Legacy and tracker state agree that the issue is complete';
      } else if (canonicalStatus === 'decomposed') {
        state = 'DECOMPOSED';
        reason = 'Legacy task state records successful decomposition';
      } else if (
        legacyCompleted
        || canonicalStatus === 'in_progress'
        || canonicalStatus === 'in_review'
        || canonical?.worktree.branchName
        || canonical?.worktree.worktreePath
      ) {
        state = 'NEEDS_RECONCILE';
        reason = 'Legacy state may have in-flight or published work; artifact reconciliation required';
      } else if (retryAt != null && retryAt > Date.now()) {
        state = 'RETRY_AT';
        reason = 'Legacy retry backoff imported';
      } else {
        state = 'READY';
        reason = 'Legacy nonterminal state imported as claimable work';
      }

      const result = this.durableRuns.importLegacyRun({
        issueId,
        source: task.source ?? 'unknown',
        identifier: task.issueIdentifier,
        title: task.title,
        projectPath,
        state,
        retryAt,
        branchName: canonical?.worktree.branchName,
        worktreePath: canonical?.worktree.worktreePath,
        errorCode: 'legacy_import',
        errorMessage: reason,
        metadata: {
          legacyCompleted,
          failedCount,
          canonicalStatus,
          importedAt: new Date().toISOString(),
        },
      });
      if (result?.imported) imported++;
    }
    if (imported > 0) this.syslog(`✓ Imported ${imported} legacy run state(s) into automation.db`);
  }

  private async deliverOutboxEffect(effect: EffectClaim): Promise<void> {
    return deliverTrackerEffect(effect, getTaskSource());
  }

  private async drainDurableOutbox(): Promise<void> {
    if (!this.durableRuns.isPrimary) return;
    if (this.outboxDrain) return this.outboxDrain;
    const finalized = new Set<string>();
    this.outboxDrain = (async () => {
      const outcome = await this.durableRuns.drainOutbox(async (effect) => {
        await this.deliverOutboxEffect(effect);
        finalized.add(effect.issueId);
      });
      for (const issueId of finalized) {
        if (this.durableRuns.getRun(issueId)?.state !== 'DONE') continue;
        this.completedTaskIds.add(issueId);
        clearRejection(issueId);
        clearRetryTime(issueId, this.failedTaskRetryTimes);
        this.lastFailureDetails.delete(issueId);
      }
      if (finalized.size > 0) this.saveTaskState();
      if (outcome.retried > 0 || outcome.dead > 0) {
        console.warn(`[Outbox] applied=${outcome.applied} retried=${outcome.retried} dead=${outcome.dead}`);
      }
    })().finally(() => { this.outboxDrain = null; });
    return this.outboxDrain;
  }

  private getRolesForProject(projectPath: string): DefaultRolesConfig | undefined {
    // Find per-project configuration
    const projectConfig = this.config.projectAgents?.find(
      pa => projectPath.includes(pa.projectPath.replace('~', ''))
    );

    if (!projectConfig?.roles && !this.config.defaultRoles) {
      // Convert from legacy configuration
      return {
        worker: {
          enabled: true,
          model: this.config.workerModel,  // unset → role adapter's getDefaultModel()
          timeoutMs: this.config.workerTimeoutMs ?? 0,
        },
        reviewer: {
          enabled: true,
          model: this.config.reviewerModel,  // unset → role adapter's getDefaultModel()
          timeoutMs: this.config.reviewerTimeoutMs ?? 0,
        },
      };
    }

    // Apply per-project overrides
    const base = this.config.defaultRoles || {
      // No model → each role's adapter resolves its own default (getDefaultModel).
      worker: { enabled: true, timeoutMs: 0 },
      reviewer: { enabled: true, timeoutMs: 0 },
    };

    if (!projectConfig?.roles) {
      return base;
    }

    // Merge overrides
    return {
      worker: { ...base.worker, ...projectConfig.roles.worker },
      reviewer: { ...base.reviewer, ...projectConfig.roles.reviewer },
      tester: projectConfig.roles.tester
        ? { ...base.tester, ...projectConfig.roles.tester }
        : base.tester,
      documenter: projectConfig.roles.documenter
        ? { ...base.documenter, ...projectConfig.roles.documenter }
        : base.documenter,
    } as DefaultRolesConfig;
  }

  async start(): Promise<void> {
    if (this.stopPromise || this.durableRunsClosed) {
      throw new Error('AutonomousRunner cannot be restarted after stop; create a new runner instance');
    }
    if (this.state.isRunning) {
      console.log('[AutonomousRunner] Already running');
      return;
    }

    this.stopping = false;

    // Always-on, because the stalls this exists to catch only appear under
    // dispatch load: an external probe of `/api/health` saw zero in its first
    // 65 samples at 2 running tasks and then caught 28.58s and >=30s once the
    // scheduler was busy, with the daemon logging nothing throughout (AGT-4079).
    // Started before `engine.init()` so a stall during startup is caught too —
    // loading the embedding model alone blocks ~780ms.
    //
    // Replace rather than add, so a retry after a failed start arms one monitor
    // against this loop rather than two reporting the same stall twice.
    this.stopEventLoopMonitor?.();
    this.stopEventLoopMonitor = startEventLoopMonitor();
    try {
      await this.startAfterMonitor();
    } catch (error) {
      // `performStop()` never runs for a start that rejected, and `unref()`
      // only frees the process to exit — the interval itself keeps firing for
      // the rest of the process's life. Release it on the way out.
      this.stopEventLoopMonitor?.();
      this.stopEventLoopMonitor = null;
      throw error;
    }
  }

  /**
   * Everything `start()` does once the event-loop monitor is armed. Split out
   * only so the monitor has exactly one failure path to unwind; the body is
   * unchanged.
   */
  private async startAfterMonitor(): Promise<void> {
    await this.engine.init();

    // Recover durable intent before looking at filesystem leftovers. A restart
    // never treats an unknown worktree as disposable.
    const expired = this.durableRuns.reconcile();
    if (expired.length > 0) {
      console.warn(`[AutonomousRunner] Reconciled ${expired.length} expired execution lease(s)`);
    }
    await this.drainDurableOutbox();

    // worktree mode: remove only terminal/proven-orphan trees after reconciliation
    if (this.config.worktreeMode) {
      for (const projectPath of this.config.allowedProjects) {
        const resolvedPath = normalizeProjectPath(projectPath);
        const protectedPaths = this.durableRuns.getProtectedWorktreePaths(resolvedPath);
        const provenOrphans = new Set(
          this.durableRuns.listRuns(['DONE', 'DECOMPOSED', 'CANCELLED'])
            .filter((run) => run.projectPath === resolvedPath && run.worktreePath)
            .map((run) => run.worktreePath!),
        );
        await pruneWorktrees(resolvedPath, protectedPaths, provenOrphans)
          .catch((e) => console.error(`[AutonomousRunner] Worktree prune failed for ${resolvedPath}:`, e));
      }
    }

    const heartbeatEnabled = this.config.autonomousHeartbeat !== false;
    if (heartbeatEnabled) {
      // Set up cron job
      this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
        await this.heartbeat();
      });
    } else {
      // Explicit-dispatch mode has no heartbeat to run the artifact
      // reconciliation that unparks NEEDS_RECONCILE runs — without this,
      // explicit work interrupted by a crash stays In Progress forever.
      // Recovery-only: fetch feeds the reconciler; nothing is selected.
      await this.recoverParkedRunsOnly().catch((error) =>
        console.error('[AutonomousRunner] Explicit-mode recovery failed:', error));
    }

    this.state.isRunning = true;
    this.startPeriodicReviews();
    this.startOrchestrator();
    this.state.startedAt = Date.now();
    console.log(
      heartbeatEnabled
        ? `[AutonomousRunner] Started with schedule: ${this.config.heartbeatSchedule}`
        : '[AutonomousRunner] Started in explicit-dispatch mode (no heartbeat cron)'
    );

    if (heartbeatEnabled) {
      await reportToDiscord(`🤖 ${t('runner.modeStarted')}\n` +
        `Schedule: \`${this.config.heartbeatSchedule}\`\n` +
        `Auto-execute: ${this.config.autoExecute ? '✅' : '❌'}\n` +
        `Projects: ${this.config.allowedProjects.join(', ')}`
      );
    }

    // Immediate execution option
    if (heartbeatEnabled && this.config.triggerNow) {
      console.log('[AutonomousRunner] Triggering immediate heartbeat in 10s...');
      this.startupHeartbeatTimer = setTimeout(() => {
        this.startupHeartbeatTimer = null;
        if (!this.stopping) void this.heartbeat();
      }, 10000); // Run after 10s (wait for Discord/Linear connection)
    }
  }

  /**
   * Recovery-only startup path for explicit-dispatch mode: run the same
   * artifact reconciliation a heartbeat would, without any task selection.
   * The Linear fetch only feeds the reconciler's issueId→task lookup. (INT-3388)
   */
  private async rollbackDiscardedDispatchClaims(
    discarded: Array<{ task: TaskItem }>,
  ): Promise<void> {
    const dispatched = discarded.filter(({ task }) => task.explicitDispatch === true && task.issueId);
    if (dispatched.length === 0) return;
    const linear = await import('../linear/linear.js');
    if (!linear.isLinearInitialized()) return;
    for (const { task } of dispatched) {
      const prior = (task.linearState ?? '').toLowerCase() === 'backlog' ? 'Backlog' : 'Todo';
      const ok = await linear.updateIssueState(task.issueId!, prior).catch(() => false);
      console.log(ok
        ? `[AutonomousRunner] Rolled back queued dispatch claim: ${task.issueIdentifier ?? task.issueId} → ${prior}`
        : `[AutonomousRunner] WARNING: could not roll back claim for ${task.issueIdentifier ?? task.issueId} — left In Progress`);
    }
  }

  private async recoverParkedRunsOnly(): Promise<void> {
    if (!this.durableRuns.isPrimary) return;
    if (this.durableRuns.listRuns(['NEEDS_RECONCILE']).length === 0) return;
    const fetchResult = await fetchLinearTasks();
    if (fetchResult.error) {
      console.warn(`[AutonomousRunner] Explicit-mode recovery fetch failed: ${fetchResult.error}`);
      return;
    }
    await this.reconcileDurableArtifacts(fetchResult.tasks);
  }

  /**
   * Turn the heartbeat cron on for a runner that was started in
   * explicit-dispatch mode — the runtime activation path behind Discord's
   * `!auto start` when startup had `autonomous.enabled: false`. No-op when a
   * cron already exists. (INT-3388)
   */
  enableHeartbeat(): boolean {
    if (this.stopping || this.cronJob) return false;
    this.config.autonomousHeartbeat = true;
    this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
      await this.heartbeat();
    });
    console.log(`[AutonomousRunner] Heartbeat enabled at runtime (schedule: ${this.config.heartbeatSchedule})`);
    return true;
  }

  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    this.stopEventLoopMonitor?.();
    this.stopEventLoopMonitor = null;
    for (const job of this.periodicReviewJobs) job.stop();
    this.periodicReviewJobs = [];
    this.orchestratorJob?.stop();
    this.orchestratorJob = null;

    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    if (this.startupHeartbeatTimer) {
      clearTimeout(this.startupHeartbeatTimer);
      this.startupHeartbeatTimer = null;
    }
    if (this._nextHeartbeatTimer) {
      clearTimeout(this._nextHeartbeatTimer);
      this._nextHeartbeatTimer = null;
    }
    this.state.isRunning = false;
    const graceMs = this.config.shutdownGraceMs ?? 30_000;
    const deadline = Date.now() + graceMs;
    const heartbeatAtStop = this.heartbeatCompletion;
    const shutdown = await this.scheduler.shutdown(graceMs);
    // Queued-but-never-started explicit dispatches were discarded by
    // shutdown() with no cancellation event — roll their Linear claims back
    // to the state they were dispatched from, or they sit In Progress forever
    // with no worker. The discard snapshot is taken atomically inside
    // shutdown() (same synchronous block as stopping+clearQueue), so none of
    // these can have started. Heartbeat-selected tasks are untouched: they
    // were never moved to In Progress at queue time. (INT-3388)
    await this.rollbackDiscardedDispatchClaims(shutdown.discardedQueue).catch((error) =>
      console.warn('[AutonomousRunner] Queued-dispatch claim rollback failed:', error));
    const remainingGrace = Math.max(0, deadline - Date.now());
    const activityDrained = await this.waitForRunnerActivity(heartbeatAtStop, remainingGrace);

    if (activityDrained) {
      await this.finalizeStoppedResources();
    } else {
      // A network fetch/notifier may ignore cancellation. Return within the
      // configured deadline, but keep the ledger open until every late callback
      // has crossed the stopping fence. Closing it now would turn a benign late
      // completion into a use-after-close race.
      console.warn('[AutonomousRunner] Shutdown grace elapsed; deferring ledger close until late callbacks settle');
      const cleanup = this.drainRunnerActivity(heartbeatAtStop)
        .then(() => this.finalizeStoppedResources());
      this.deferredShutdownCleanup = cleanup;
      void cleanup
        .catch((error) => console.warn('[AutonomousRunner] Deferred shutdown cleanup failed:', error))
        .finally(() => {
          if (this.deferredShutdownCleanup === cleanup) this.deferredShutdownCleanup = null;
        });
    }
    console.log(`[AutonomousRunner] Stopped (drained=${shutdown.drained && activityDrained}, remaining=${shutdown.remaining}, quarantined=${shutdown.quarantined}, handlers=${this.schedulerHandlers.size})`);
  }

  private async drainRunnerActivity(heartbeat: Promise<void> | null): Promise<void> {
    await Promise.all([
      heartbeat ?? Promise.resolve(),
      this.scheduler.waitForExecutorExit(),
    ]);
    // Handlers can enqueue follow-up bookkeeping while an earlier handler is
    // settling, so drain to a fixed point rather than awaiting one snapshot.
    while (this.schedulerHandlers.size > 0) {
      await Promise.allSettled(this.schedulerHandlers);
    }
  }

  private async waitForRunnerActivity(heartbeat: Promise<void> | null, graceMs: number): Promise<boolean> {
    const drained = this.drainRunnerActivity(heartbeat).then(() => true);
    if (graceMs <= 0) {
      return heartbeat === null
        && this.schedulerHandlers.size === 0
        && this.scheduler.getUnsettledExecutorCount() === 0;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); });
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private async finalizeStoppedResources(): Promise<void> {
    if (this.durableRunsClosed) return;
    await this.drainDurableOutbox().catch((error) =>
      console.warn('[AutonomousRunner] Final outbox drain failed:', error));
    this.durableRuns.close();
    this.durableRunsClosed = true;
  }

  private buildStats(): SwarmStats {
    const stats = this.scheduler.getStats();
    return {
      runningTasks: stats.running,
      queuedTasks: stats.queued,
      completedToday: stats.completed,
      uptime: this.state.startedAt ? Date.now() - this.state.startedAt : 0,
      schedulerPaused: this.scheduler.isPaused(),
    };
  }

  private refreshKnowledgeGraphs(): void {
    for (const projectPath of this.config.allowedProjects) {
      const resolvedPath = normalizeProjectPath(projectPath);
      refreshGraph(resolvedPath).then(graph => {
        if (graph) {
          const slug = toProjectSlug(resolvedPath);
          broadcastEvent({
            type: 'knowledge:updated',
            data: { projectSlug: slug, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount },
          });
        }
      }).catch((e) => {
        console.error(`[AutonomousRunner] Knowledge graph refresh failed for ${resolvedPath}:`, e);
      });
    }
  }

  /** Send system message to dashboard LIVE LOG */
  private syslog(line: string): void {
    const safeLine = line.replace(/[\r\n]/g, '');
    console.log(`[HB] ${safeLine}`);
    broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'heartbeat', line: safeLine } });
  }

  private lastSkipSummary = '';

  /**
   * Log unmapped/disabled project skips as one aggregate line per category,
   * and stay silent while the summary is identical to the previous heartbeat.
   */
  private syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void {
    const fmt = (m: Map<string, number>) => [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} (${n})`)
      .join(', ');
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    if (unmapped.size > 0) {
      lines.push(`  ⚠ Skipped ${total(unmapped)} issue(s) in ${unmapped.size} unmapped project(s): ${fmt(unmapped)} — run \`openswarm add\` to map`);
    }
    if (disabled.size > 0) {
      lines.push(`  ⚠ Skipped ${total(disabled)} issue(s) in ${disabled.size} disabled project(s): ${fmt(disabled)}`);
    }
    const summary = lines.join('\n');
    if (summary === this.lastSkipSummary) return;
    this.lastSkipSummary = summary;
    for (const line of lines) this.syslog(line);
  }

  private async groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> {
    const byProjectId = new Map<string, string>();
    for (const repoPath of this.config.allowedProjects) {
      try {
        const resolvedPath = normalizeProjectPath(repoPath);
        const meta = await loadRepoMetadata(resolvedPath);
        if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, resolvedPath);
      } catch {
        // Grooming is advisory; unreadable metadata should not block normal work.
      }
    }

    const groups = new Map<string, TaskItem[]>();
    for (const task of tasks) {
      const projectPath = task.projectPath
        ?? (task.linearProject?.id ? byProjectId.get(task.linearProject.id) : undefined)
        ?? undefined;
      if (!projectPath) continue;
      const list = groups.get(projectPath) ?? [];
      list.push(task);
      groups.set(projectPath, list);
    }
    return groups;
  }

  private async maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]> {
    const cfg = this.config.backlogGrooming;
    if (!cfg?.enabled) return tasks;

    const cadenceMs = Math.max(1, cfg.cadenceHours ?? 24) * 60 * 60 * 1000;
    const now = Date.now();
    if (this.lastBacklogGroomingAt && now - this.lastBacklogGroomingAt < cadenceMs) return tasks;

    const source = getTaskSource();
    if (!source) {
      this.syslog('⚠ Backlog grooming skipped: no task source');
      return tasks;
    }

    const groomable = filterGroomableTasks(tasks);
    if (groomable.length === 0) return tasks;

    const mode = cfg.mode ?? 'comment';
    const moved = new Set<string>();
    const groups = await this.groupTasksForGrooming(groomable);
    if (groups.size === 0) {
      this.syslog('⚠ Backlog grooming skipped: no mapped project paths');
      return tasks;
    }

    let successfulPlannerRuns = 0;
    for (const [projectPath, groupTasks] of groups) {
      this.syslog(`⟳ Backlog grooming: ${groupTasks.length} issue(s) in ${projectPath.split('/').pop()}`);
      const result = await runBacklogGroomingPlanner({
        tasks: groupTasks,
        projectPath,
        projectName: groupTasks[0]?.linearProject?.name,
        model: cfg.plannerModel ?? this.config.plannerModel,
        timeoutMs: cfg.plannerTimeoutMs ?? this.config.plannerTimeoutMs,
        maxIssues: cfg.maxIssues,
        onLog: (line) => broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'groom', line } }),
      });
      if (!result.success) {
        this.syslog(`⚠ Backlog grooming failed: ${result.error ?? 'unknown error'}`);
        continue;
      }
      successfulPlannerRuns++;
      const validIssueIds = new Set(groupTasks.map(task => task.issueId || task.id));
      const applied = await applyBacklogGrooming(source, result, mode, validIssueIds);
      for (const issueId of applied.movedIssueIds) moved.add(issueId);
      this.syslog(`✓ Backlog grooming: ${result.decisions.length} decision(s), ${applied.commented} comment(s), ${applied.failedComments} comment failure(s), ${applied.updatedDescriptions} description update(s), ${applied.moved} moved, ${applied.skippedUnknown} unknown skipped`);
      for (const decision of result.decisions.slice(0, 5)) {
        this.syslog(`  ${summarizeGroomingDecision(decision)}`);
      }
    }

    if (successfulPlannerRuns > 0) this.lastBacklogGroomingAt = now;
    if (moved.size === 0) return tasks;
    return tasks.filter(task => !moved.has(task.issueId || task.id));
  }

  async heartbeat(): Promise<void> {
    if (this.stopping) return;
    if (this._heartbeatRunning) {
      console.log('[AutonomousRunner] Heartbeat already running, skipping');
      return;
    }
    this._heartbeatRunning = true;
    let settleHeartbeat!: () => void;
    const completion = new Promise<void>((resolve) => { settleHeartbeat = resolve; });
    this.heartbeatCompletion = completion;

    console.log('[AutonomousRunner] Heartbeat triggered');
    this.state.lastHeartbeat = Date.now();
    broadcastEvent({ type: 'stats', data: this.buildStats() });
    broadcastEvent({ type: 'heartbeat' });
    this.syslog('▶ Heartbeat started');

    try {
      const expiredLeases = this.durableRuns.reconcile();
      if (expiredLeases.length > 0) {
        this.syslog(`⚠ Reconciled ${expiredLeases.length} expired execution lease(s)`);
      }
      await this.drainDurableOutbox();
      if (this.stopping) return;

      // 0. Knowledge graph refresh (async, service continues even on failure)
      this.refreshKnowledgeGraphs();

      // 0.1 Reconcile before pruning. Unknown/crash-recovery worktrees are never
      // deleted from a heartbeat without a terminal durable record.
      if (this.config.worktreeMode) {
        const activeWorktrees = new Set(
          this.scheduler.getRunningTasks().map((r) => `${r.projectPath}/worktree/${r.task.issueId}`),
        );
        for (const path of this.durableRuns.getProtectedWorktreePaths()) activeWorktrees.add(path);
        const terminalRuns = this.durableRuns.listRuns(['DONE', 'DECOMPOSED', 'CANCELLED']);
        for (const projectPath of this.config.allowedProjects) {
          if (this.stopping) return;
          const resolvedPath = normalizeProjectPath(projectPath);
          const provenOrphans = new Set(
            terminalRuns
              .filter((run) => run.projectPath === resolvedPath && run.worktreePath)
              .map((run) => run.worktreePath!),
          );
          await pruneWorktrees(resolvedPath, activeWorktrees, provenOrphans).catch((e) =>
            console.error(`[AutonomousRunner] Worktree sweep failed for ${resolvedPath}:`, e),
          );
        }
      }

      // 0.5 Long-running monitor passive check (before time window)
      const active = getActiveMonitors().filter(m => m.state === 'pending' || m.state === 'running');
      if (active.length > 0) {
        const checked = await checkAllMonitors().catch(() => 0);
        if (this.stopping) return;
        this.syslog(`✓ Monitors: ${checked} checked / ${active.length} active`);
      }

      // 1. Check time window
      const timeCheck = checkWorkAllowed();
      if (!timeCheck.allowed) {
        console.log(`[AutonomousRunner] Blocked: ${timeCheck.reason}`);
        this.syslog(`⛔ Time window blocked: ${timeCheck.reason}`);
        return;
      }
      this.syslog('✓ Time window: allowed');

      // 1.2 Rate-limit hold — skip the heartbeat while a 429 pause is still active.
      // Cleared implicitly once the clock passes rateLimitUntil. (INT-1906)
      if (Date.now() < this.rateLimitUntil) {
        const remainSec = Math.max(0, Math.ceil((this.rateLimitUntil - Date.now()) / 1000));
        const resetsLabel = new Date(this.rateLimitUntil).toISOString();
        console.log(`[AutonomousRunner] Rate limit hold active — ${remainSec}s remaining (until ${resetsLabel})`);
        this.syslog(`⏸ Rate limit hold: ~${remainSec}s remaining`);
        broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'rate_limit', line: `⏸ Rate limit hold: ~${remainSec}s remaining` } });
        return;
      }

      // 1.5 Quota gate (removed) — was a Claude Max quota check (api.anthropic.com
      // /oauth/usage). OpenSwarm runs codex-responses now, not claude -p, so a Claude
      // quota gate is irrelevant; it only spammed 401s and could wrongly skip codex
      // work. codex-responses self-protects via RateLimitError (scheduler pause).

      // 1.6 Pace gate (removed)
      // The 5h rolling window cap (globalCap = projects × dailyTaskCap) and
      // turbo-mode multiplier used to gate heartbeat here. Both were removed
      // by user request: speed is now governed only by the cron schedule and
      // the Linear API rate limiter, not by an internal completion cap.
      this.syslog(`✓ Pace: unrestricted (cron only)`);

      // 2. Fetch tasks from Linear
      this.syslog('⟳ Fetching tasks from Linear...');
      const fetchResult = await fetchLinearTasks();
      if (this.stopping) return;
      if (fetchResult.error) {
        this.syslog(`✗ Linear fetch error: ${fetchResult.error}`);
        await reportToDiscord(`⚠️ Linear fetch failed: ${fetchResult.error}`);
        return;
      }
      let tasks = fetchResult.tasks;
      if (tasks.length === 0) {
        this.syslog('— No tasks in backlog');
        return;
      }

      await this.migrateLegacyRunState(tasks);
      if (this.stopping) return;
      await this.reconcileDurableArtifacts(tasks);
      if (this.stopping) return;

      this.lastFetchedTasks = tasks;
      this.syslog(`✓ Found ${tasks.length} tasks from Linear`);

      tasks = await this.maybeRunBacklogGrooming(tasks);
      if (this.stopping) return;
      this.lastFetchedTasks = tasks;
      if (tasks.length === 0) {
        this.syslog('— No executable tasks after backlog grooming');
        return;
      }

      // Filter out completed and over-retried tasks
      const filteredTasks = this.filterAlreadyProcessed(tasks);
      if (filteredTasks.length === 0) {
        this.syslog('— All tasks already completed or max retries exceeded');
        return;
      }
      if (filteredTasks.length !== tasks.length) {
        this.syslog(`  Filtered: ${tasks.length} → ${filteredTasks.length} (skipped ${tasks.length - filteredTasks.length} completed/failed)`);
      }

      // Parallel processing mode
      if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1 && this.config.pairMode) {
        await this.heartbeatParallel(filteredTasks);
        return;
      }

      // 3. Run Decision Engine (single task)
      this.syslog('⟳ Running Decision Engine...');
      const decision = await this.engine.heartbeat(filteredTasks);
      if (this.stopping) return;
      this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      this.state.lastDecision = decision;

      // 4. Handle decision
      if (decision.action === 'execute' && decision.task) {
        await this.executeTaskPairMode(decision.task);
      } else if (decision.action === 'defer' && decision.task) {
        this.state.pendingApproval = decision.task;
        await this.requestApproval(decision);
      }
      this.state.consecutiveErrors = 0;

    } catch (error) {
      this.state.consecutiveErrors++;
      const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, '');
      console.error('[AutonomousRunner] Heartbeat error:', msg);
      this.syslog(`✗ Heartbeat error: ${msg}`);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(t('runner.consecutiveErrors', { count: this.state.consecutiveErrors, error: msg }));
      }
    } finally {
      this._heartbeatRunning = false;
      if (this.heartbeatCompletion === completion) this.heartbeatCompletion = null;
      settleHeartbeat();
    }
  }

  private async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
    if (this.stopping) return;
    const availableSlots = this.scheduler.getAvailableSlots();
    const runningCount = this.scheduler.getStats().running;
    this.syslog(`  Parallel mode | slots: ${availableSlots} free / ${this.config.maxConcurrentTasks} max | running: ${runningCount}`);

    if (availableSlots === 0) {
      this.syslog(`⏳ All slots busy (${runningCount} tasks running), waiting...`);
      return;
    }

    // Fill all available slots (worktree mode isolates each task)
    const maxSlots = availableSlots;

    // Pre-filter tasks to enabled projects only (before DecisionEngine selection)
    // This prevents DecisionEngine from wasting its max-slot budget on non-enabled projects.
    // Only execute Todo tasks; Backlog is fetched for dashboard display only
    const executableTasks = tasks.filter(t => t.linearState !== 'Backlog');

    let tasksForEngine = executableTasks;
    if (this.shouldFilterByEnabled()) {
      // Explicit repo↔Linear mapping — match fetched issues to repos by the Linear
      // projectId the user picked in `openswarm add` (written to <repo>/openswarm.json),
      // NOT by guessing from the repo directory name. Built fresh each cycle so a
      // newly-mapped repo is picked up without a restart. Name matching stays only as
      // a best-effort fallback for repos that never ran the picker.
      const byProjectId = new Map<string, string>();
      for (const repoPath of this.enabledProjects) {
        try {
          const meta = await loadRepoMetadata(repoPath);
          if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, repoPath);
        } catch (e) {
          this.syslog(`  ⚠ openswarm.json unreadable for ${repoPath.split('/').pop()}: ${(e as Error).message}`);
        }
      }

      // Aggregate skip reasons per project instead of logging one line per issue —
      // dozens of unmapped issues used to flood the LIVE LOG every heartbeat.
      const skippedUnmapped = new Map<string, number>();
      const skippedDisabled = new Map<string, number>();
      tasksForEngine = executableTasks.filter(task => {
        const projName = task.linearProject?.name;
        const projId = task.linearProject?.id;
        // 1) Explicit projectId mapping (openswarm.json) wins.
        const mappedPath = projId ? byProjectId.get(projId) : undefined;
        // 2) Fallback: repo-name path cache (only for repos without an explicit mapping).
        const cachedPath = mappedPath
          ?? (projName && (this.projectPathCache.get(projName)
            ?? this.projectPathCache.get(projName.toLowerCase())
            ?? this.projectPathCache.get(projName.replace(/-/g, ' '))));
        if (!cachedPath) {
          const key = projName ?? projId ?? 'unknown';
          skippedUnmapped.set(key, (skippedUnmapped.get(key) ?? 0) + 1);
          return false;
        }
        const enabled = this.isProjectEnabled(cachedPath);
        if (!enabled) {
          skippedDisabled.set(projName ?? cachedPath, (skippedDisabled.get(projName ?? cachedPath) ?? 0) + 1);
        }
        return enabled;
      });
      this.syslogSkipSummary(skippedUnmapped, skippedDisabled);
      if (tasksForEngine.length === 0) {
        this.syslog(`⚠ No enabled tasks (${executableTasks.length} executable, ${tasks.length - executableTasks.length} backlog)`);
        this.syslog(`  Path cache: [${[...this.projectPathCache.entries()].map(([k,v]) => `${k}→${v}`).join(', ')}]`);
        this.syslog(`  Enabled: [${[...this.enabledProjects].join(', ')}]`);
        return;
      }
      this.syslog(`  Tasks: ${tasksForEngine.length} enabled-or-uncached / ${executableTasks.length} executable / ${tasks.length} total`);
    }

    let enqueuedCount = 0;
    let skippedCount = 0;
    const consideredTaskIds = new Set<string>();
    let pass = 0;

    while (enqueuedCount < maxSlots) {
      if (this.stopping) return;
      const remainingSlots = maxSlots - enqueuedCount;
      const selectableTasks = tasksForEngine.filter(task => !consideredTaskIds.has(task.id));
      const selectionBudget = decisionSelectionBudget(remainingSlots, selectableTasks.length);
      if (selectionBudget === 0) break;

      this.syslog(pass === 0
        ? '⟳ Decision Engine evaluating tasks...'
        : `⟳ Backfill pass (${remainingSlots} slot(s) open)...`);

      const decision = await this.engine.heartbeatMultiple(
        selectableTasks,
        selectionBudget,
        [] // No project exclusion — worktree mode isolates each task
      );
      if (this.stopping) return;

      console.log(`[AutonomousRunner] Decision: ${decision.action} — ${decision.reason} (${decision.tasks?.length ?? 0} tasks)`);
      skippedCount += decision.skippedCount ?? 0;
      if (decision.action === 'skip' || decision.action === 'defer') {
        this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
        break;
      }

      for (const { task } of decision.tasks) {
        consideredTaskIds.add(task.id);
      }

      const candidates = await this.resolveRunnableCandidates(decision.tasks);
      if (this.stopping) return;
      const safeTasks = await this.detectSafeCandidateIds(candidates);
      if (this.stopping) return;

      for (const { task, projectPath } of candidates) {
        if (this.stopping) return;
        if (enqueuedCount >= maxSlots) break;
        if (!safeTasks.has(task.id)) continue;
        if (!this.canQueueProjectCandidate(projectPath)) {
          this.syslog(`  Project cap reached: ${projectPath}`);
          continue;
        }

        if (this.enqueueCandidate(task, projectPath)) {
          enqueuedCount++;
        }
      }

      pass++;

      if (enqueuedCount >= maxSlots) break;
      if (decision.tasks.length === 0) break;
      // NOTE: no "selectionBudget >= selectableTasks.length ⇒ break" here — that
      // used to short-circuit the WHOLE heartbeat the instant selectionBudget
      // covered the full candidate pool (the common case whenever free slots
      // exceed the candidate count), even when every one of decision.tasks
      // turned out already-running/queued and got discarded above (`before`).
      // A single hard-to-satisfy task occupying one slot for hours then starved
      // every other free slot forever: same task re-selected + discarded each
      // 5-min heartbeat, no backfill pass ever tried the rest of the pool. The
      // loop's own progress guarantee is enough — consideredTaskIds grows by
      // decision.tasks.length every pass, so selectableTasks strictly shrinks
      // each iteration and the top-of-loop `selectionBudget === 0` check (line
      // ~1197) is what actually terminates once nothing candidate remains.
      // (INT-2570 follow-up, observed live: INT-2061 held a WAVE slot for 4h+
      // while 7/8 scheduler slots sat idle with 18 executable tasks waiting.)
    }

    if (enqueuedCount === 0 && skippedCount > 0) {
      this.syslog(`— No new tasks queued (skipped: ${skippedCount})`);
    } else {
      this.syslog(`✓ Enqueued ${enqueuedCount} task(s) | skipped: ${skippedCount}`);
    }

    // Execute tasks
    if (!this.stopping) await this.runAvailableTasks();
  }

  private async resolveRunnableCandidates(decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]> {
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

      // Per-project 5h window cap (removed, INT-2317) — like the global pace
      // gate above, throughput is governed by the cron schedule and the Linear
      // rate limiter only. Completions are still recorded for cost telemetry.
      candidates.push({ task, projectPath });
    }

    return candidates;
  }

  private async detectSafeCandidateIds(candidates: RunnableCandidate[]): Promise<Set<string>> {
    if (worktreeFanoutEnabled(this.config)) {
      return new Set(candidates.map(candidate => candidate.task.id));
    }

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
        await Promise.all(group.map(c => resolveTaskFileScope(c.task, projPath)));

        // A later heartbeat must compare new candidates with workers that are
        // already editing another worktree. Candidate-vs-candidate detection
        // alone leaves a race window across heartbeat cycles.
        const active = this.scheduler.getRunningTasks()
          .filter(running => normalizeProjectPath(running.projectPath) === projPath);
        const runnable = group.filter(candidate => {
          const conflict = active.some(running => fileScopesConflict(
            candidate.task.fileScope,
            running.task.fileScope,
          ));
          if (conflict) {
            this.syslog(`Conflict with active worktree — deferring: ${candidate.task.issueIdentifier || candidate.task.id.slice(0, 8)} ${candidate.task.title}`);
          }
          return !conflict;
        });
        if (runnable.length === 0) continue;

        const result = await detectFileConflicts(runnable.map(c => c.task), projPath);

        for (const t of result.safe) {
          safeTasks.add(t.id);
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
  private attachPriorFeedback(task: TaskItem): void {
    if (!task.issueId) return;
    const prior = this.lastFailureDetails.get(task.issueId);
    if (prior) task.priorAttemptFeedback = prior.detail;
  }

  private enqueueCandidate(task: TaskItem, projectPath: string): boolean {
    this.attachPriorFeedback(task);
    if (!this.scheduler.enqueue(task, projectPath)) return false;
    broadcastEvent({ type: 'task:queued', data: { taskId: taskEventKey(task), title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
    this.syslog(`✓ Queued: ${task.issueIdentifier || ''} ${task.title} → ${projectPath.split('/').slice(-2).join('/')}`);
    return true;
  }

  /**
   * Explicit dispatch: queue exactly these user-chosen tasks and start
   * executing, bypassing the DecisionEngine's own selection entirely. This is
   * the API surface behind `POST /api/work` (issue board) — the counterpart
   * of the heartbeat path, usable even when the heartbeat cron is disabled
   * (`autonomousHeartbeat: false`). Rejected entries are ones the scheduler
   * refused (already queued/running — its issueId dedupe). (INT-3388)
   *
   * Throws (rather than queueing work that would never start) when the
   * runner's configuration cannot execute scheduler-queued tasks:
   * runAvailableTasks() is a no-op without pairMode + maxConcurrentTasks, so
   * silently accepting the queue here would strand the issues In Progress
   * with no worker ever picking them up.
   */
  async enqueueIssues(
    tasks: TaskItem[],
    projectPath: string,
  ): Promise<{ queued: string[]; rejected: Array<{ id: string; reason: 'duplicate' | 'stopping' }> }> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      throw new Error(
        'Explicit dispatch requires autonomous.pairMode and maxConcurrentTasks in config — ' +
        'without them queued issues would never execute',
      );
    }
    // Same provider-quota hold the heartbeat honors: dispatching during a
    // known 429 window would claim issues that cannot run and burn more calls.
    if (Date.now() < this.rateLimitUntil) {
      throw new Error(
        `Provider rate limit active until ${new Date(this.rateLimitUntil).toISOString()} — retry after it resets`,
      );
    }
    const queued: string[] = [];
    // The reason distinction matters to the caller's claim-rollback decision:
    // 'duplicate' means the scheduler already owns this issue (another live
    // dispatch/heartbeat is working it — its In Progress claim must stand),
    // while 'stopping' means nobody will ever run it (rollback is safe).
    const rejected: Array<{ id: string; reason: 'duplicate' | 'stopping' }> = [];
    for (const task of tasks) {
      if (this.stopping) {
        rejected.push({ id: task.id, reason: 'stopping' });
        continue;
      }
      if (this.enqueueCandidate(task, projectPath)) queued.push(task.id);
      else rejected.push({ id: task.id, reason: 'duplicate' });
    }
    if (queued.length > 0 && !this.stopping) {
      this.trackSchedulerHandler('explicitDispatch', this.runAvailableTasks());
    }
    return { queued, rejected };
  }

  /** Execute task in pair mode */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    if (this.stopping) return;
    // Serial path (maxConcurrentTasks=1) bypasses enqueueCandidate — attach the
    // prior-session feedback here too so both paths inject it (INT-2474).
    this.attachPriorFeedback(task);

    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);
    if (this.stopping) return;

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      // Record so this issue isn't re-picked every heartbeat (it would starve
      // runnable tasks behind it). Cleared on restart. (INT-1875)
      this.unresolvableIssueIds.add(task.issueId || task.id);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      // Move on to the next actionable task instead of ending the heartbeat here.
      this.scheduleNextHeartbeat();
      return;
    }

    // Skip if project is not in enabled list (allow-list; empty = nothing runs)
    if (this.shouldFilterByEnabled() && !this.isProjectEnabled(projectPath)) {
      console.log(`[AutonomousRunner] Project not enabled, skipping: ${projectPath}`);
      return;
    }

    // Cache linearProjectName → resolvedPath for dashboard
    if (task.linearProject?.name) {
      this.projectPathCache.set(task.linearProject.name, projectPath);
    }

    console.log(`[AutonomousRunner] projectPath: ${projectPath}`);

    // Use scheduler for parallel processing mode
    if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1) {
      if (this.scheduler.enqueue(task, projectPath)) {
        broadcastEvent({ type: 'task:queued', data: { taskId: taskEventKey(task), title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      }
      await this.runAvailableTasks();
      return;
    }

    // Single execution (legacy serial path — maxConcurrentTasks <= 1).
    // The scheduler emits task:started/completed for the parallel path; this
    // path never did, so dashboards saw no lifecycle and (since INT-3402) the
    // transcript buffer was never handed to its retention timer.
    broadcastEvent({
      type: 'task:started',
      data: { taskId: taskEventKey(task), title: task.title, issueIdentifier: task.issueIdentifier },
    });
    let result: PipelineResult;
    try {
      result = await this.executeDurably(task, projectPath);
    } catch (err) {
      broadcastEvent({
        type: 'task:completed',
        data: { taskId: taskEventKey(task), success: false, duration: 0 },
      });
      throw err;
    }
    broadcastEvent({
      type: 'task:completed',
      data: { taskId: taskEventKey(task), success: result.success, duration: result.totalDuration },
    });

    // Rate-limited: pause until quota resets. Return before any Discord/Linear
    // reporting or state change — no failure count, no card spam. Same as the
    // scheduler 'failed' handler's rate_limited branch. (INT-1906)
    if (result.finalStatus === 'rate_limited') {
      const resetsAt = result.rateLimitResetsAt ?? Date.now() + 60_000;
      this.rateLimitUntil = resetsAt;
      const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
      const resetsLabel = new Date(resetsAt).toISOString();
      console.warn(`[AutonomousRunner] Rate limit hit for ${this.formatTaskContext(task)} — pausing until ${resetsLabel} (~${waitSec}s)`);
      broadcastEvent({ type: 'log', data: { taskId: taskEventKey(task), stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` } });
      return;
    }

    await reportToDiscord(formatPipelineResultEmbed(result));

    if (result.success && task.issueId && this.durableRuns.isPrimary) {
      await this.drainDurableOutbox().catch((error) =>
        console.error('[Outbox] Serial completion delivery pass failed:', error));
      if (this.durableRuns.getRun(task.issueId)?.state !== 'DONE') {
        console.warn(`[AutonomousRunner] ${task.issueId} remains sync-pending; completion will reconcile later`);
      }
      return;
    }

    // Update Linear issue state
    if (task.issueId) {
      try {
        if (result.success) {
          // On success, move to Done
          await execution.syncSuccessState(task);
          await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, completionStats(result));
          await execution.reconcileCompletionState(task);
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Done`);

          if (result.taskContext?.projectPath) {
            await recordTaskOutcome(result.taskContext.projectPath, {
              taskTitle: task.title,
              derivedFrom: task.issueIdentifier ?? task.issueId,
              workerResult: result.workerResult,
              iterations: result.iterations,
            });
          }
        } else if (result.finalStatus === 'rejected') {
          // Change to Blocked on review rejection
          await execution.syncFailureState(
            task,
            `Review rejected: ${result.reviewResult?.feedback || t('common.fallback.noDescription')}`,
            'Todo',
          );
          await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
            t('runner.reviewRejected', { feedback: result.reviewResult?.feedback || t('common.fallback.noDescription') })
          );
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Todo (blocked) (rejected)`);
        }
        // If failed, keep In Progress (retry on next heartbeat)
      } catch (err) {
        console.error(`[AutonomousRunner] Failed to update issue state:`, err);
      }
    }
  }

  private getExecCtx(durability?: ExecutionDurabilityHooks): execution.ExecutionContext {
    return {
      allowedProjects: this.config.allowedProjects,
      plannerModel: this.config.plannerModel,
      plannerTimeoutMs: this.config.plannerTimeoutMs,
      pairMaxAttempts: this.config.pairMaxAttempts,
      enableDecomposition: this.config.enableDecomposition,
      decompositionThresholdMinutes: this.config.decompositionThresholdMinutes,
      decompositionMaxDepth: this.config.decomposition?.maxDepth ?? 2,
      decompositionMaxChildren: this.config.decomposition?.maxChildrenPerTask ?? 5,
      decompositionDailyLimit: this.config.decomposition?.dailyLimit ?? 20,
      decompositionAutoBacklog: this.config.decomposition?.autoBacklog ?? true,
      jobProfiles: this.config.jobProfiles,
      getRolesForProject: (p) => this.getRolesForProject(p),
      reportToDiscord,
      worktreeMode: this.config.worktreeMode ?? false,
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      guards: this.config.guards,
      verify: this.config.verify,
      securityAudit: this.config.securityAudit,
      maxReflections: this.config.maxReflections,
      durability,
      peerIssues: this.lastFetchedTasks,
      getActiveWorkerIssues: (p) => this.durableRuns.activeWorkerIdentifiers(p),
      mcpPolicies: this.config.mcpPolicies,
      adapterRouting: this.config.adapterRouting,
    };
  }

  private async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  private async executePipeline(
    task: TaskItem,
    projectPath: string,
    signal?: AbortSignal,
    durability?: ExecutionDurabilityHooks,
  ): Promise<PipelineResult> {
    return execution.executePipeline(this.getExecCtx(durability), task, projectPath, signal);
  }

  private async requestApproval(decision: DecisionResult): Promise<void> {
    return execution.requestApproval(decision, reportToDiscord);
  }

  async approve(): Promise<boolean> {
    if (!this.state.pendingApproval) {
      return false;
    }

    const task = this.state.pendingApproval;
    this.state.pendingApproval = undefined;

    // Get workflow from Decision Engine
    const decision = await this.engine.heartbeat([task]);
    if (decision.workflow && decision.task) {
      await this.executeTaskPairMode(decision.task);
      return true;
    }

    return false;
  }

  reject(): boolean {
    if (!this.state.pendingApproval) {
      return false;
    }

    this.state.pendingApproval = undefined;
    return true;
  }

  async runNow(): Promise<void> {
    await this.heartbeat();
  }

  getState(): RunnerState {
    return { ...this.state };
  }

  getAllowedProjects(): string[] {
    return this.config.allowedProjects ?? [];
  }

  /**
   * The project set the daemon will actually dispatch to right now: the
   * configured allow-list narrowed by the dashboard's enabled selection, the
   * same two gates every dispatch decision passes (isProjectEnabled +
   * decisionEngine's allow-list). Metrics scoped by only the former still
   * counted repositories the operator had disabled as live work. (AGT-4127
   * PR review)
   *
   * `undefined` means no restriction exists — the legacy allow-everything
   * configuration — and is deliberately distinct from `[]`, which means the
   * gates admit nothing (every project disabled). The two collapse to the same
   * array value but opposite dispatch behaviour, so the translation happens
   * here, the one place that knows which is which.
   */
  getEffectiveProjectScope(): string[] | undefined {
    return effectiveProjectScope(
      this.config.allowedProjects ?? [],
      this.enabledProjects,
      this.shouldFilterByEnabled(),
    );
  }


  updateAllowedProjects(paths: string[]): void {
    this.config.allowedProjects = paths;
    this.engine.updateAllowedProjects(paths);
  }

  getStats() {
    return { isRunning: this.state.isRunning, lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(), pendingApproval: !!this.state.pendingApproval,
      schedulerStats: this.scheduler.getStats(),
      automationLedger: this.durableRuns.getMetrics(Date.now(), this.getEffectiveProjectScope()),
      turboMode: this.turboMode,
      turboExpiresAt: this.turboExpiresAt,
      dailyPace: getDailyPaceInfo(),
    };
  }

  private startPeriodicReviews(): void {
    for (const job of this.periodicReviewJobs) job.stop();
    this.periodicReviewJobs = [];
    for (const review of this.config.periodicReviews ?? []) {
      const cron = new Cron(review.schedule, () => {
        void this.runPeriodicReviewAcrossProjects(review).catch((error) =>
          console.error(`[PeriodicReview] ${review.profile} failed:`, error));
      });
      this.periodicReviewJobs.push(cron);
    }
  }

  private async runPeriodicReviewAcrossProjects(review: NonNullable<AutonomousConfig['periodicReviews']>[number]): Promise<void> {
    const { runPeriodicReview } = await import('../coordination/periodicReview.js');
    const projects = this.getEnabledProjects().length > 0 ? this.getEnabledProjects() : this.getAllowedProjects();
    for (const repository of projects) {
      await runPeriodicReview({
        repository,
        taskId: `periodic:${review.profile}`,
        profile: review.profile,
        adapter: review.adapter,
      });
    }
  }

  private startOrchestrator(): void {
    this.orchestratorJob?.stop();
    this.orchestratorJob = null;
    const schedule = this.config.orchestratorSchedule;
    if (!schedule) return;
    this.orchestratorJob = new Cron(schedule, () => {
      void this.runOrchestratorAcrossProjects().catch((error) =>
        console.error('[Orchestrator] sweep failed:', error));
    });
  }

  /**
   * Let the MCP-connected orchestrator act on whatever the board is waiting on.
   *
   * Only runs where there is something to coordinate: a sweep with an empty
   * pending list would spend a provider call to conclude nothing, and the
   * orchestrator's whole job is unblocking work that already exists.
   */
  private async runOrchestratorAcrossProjects(): Promise<void> {
    const policy = this.config.mcpPolicies?.orchestrator;
    if (!policy) {
      console.warn('[Orchestrator] no mcpPolicies.orchestrator configured — skipping sweep');
      return;
    }
    // Imported one at a time: concurrent dynamic imports of mocked modules have
    // raced here before, with the second call resolving the real module.
    // A delegated CLI adapter runs its own tool loop: it would receive none of
    // the MCP tools the orchestrator exists to use, and spawnCli refuses to run
    // it with shell access withheld. Skip with one clear line instead of
    // throwing once per repository, every sweep.
    const { getAdapter } = await import('../adapters/index.js');
    const adapter = getAdapter();
    if (!adapter.run) {
      console.warn(
        `[Orchestrator] adapter '${adapter.name}' delegates to its own CLI tool loop and cannot use MCP — skipping sweep. `
        + `Use codex-responses, cc-router, gpt, openrouter, atlascloud, lmstudio, or local.`,
      );
      return;
    }
    const { buildOrchestratorObjective, runOrchestrator } = await import('../coordination/orchestratorAgent.js');
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = getCoordinationStore();
    const projects = this.getEnabledProjects().length > 0 ? this.getEnabledProjects() : this.getAllowedProjects();

    for (const repository of projects) {
      const objective = buildOrchestratorObjective(store.snapshot(repository).pending);
      if (!objective) continue;
      // Same rule snapshot the workers get, so the orchestrator coordinates
      // under the runbook it is coordinating against rather than an empty one.
      const { buildInstructionCapsule } = await import('../agents/instructionCapsule.js');
      await runOrchestrator({
        repository,
        taskId: 'orchestrator:sweep',
        objective,
        policy,
        instructionCapsule: buildInstructionCapsule(repository),
        // No adapter override: the orchestrator runs on the daemon's configured
        // provider, the same one the workers it coordinates use.
      }).catch((error) => console.error(`[Orchestrator] ${repository} failed:`, error));
    }
  }

  getCoordinationConfig() {
    return {
      boardIssueId: this.config.coordinationBoardIssueId,
      routing: this.config.adapterRouting,
      mcpPolicies: this.config.mcpPolicies,
      adapterRouting: this.config.adapterRouting,
      periodicReviews: this.config.periodicReviews ?? [],
      orchestratorSchedule: this.config.orchestratorSchedule,
    };
  }

  // ============================================
  // Max Pace (formerly "Turbo")
  // ============================================

  getTurboMode(): boolean {
    // Max pace no longer auto-expires; it stays on until explicitly toggled off.
    return this.turboMode;
  }

  setTurboMode(enabled: boolean): void {
    this.turboMode = enabled;
    // No auto-expiry: max pace is a persistent state, not a 4h burst. (always-max)
    this.turboExpiresAt = null;
    if (enabled) {
      console.log('[AutonomousRunner] MAX PACE ON (persistent)');
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: 'MAX PACE ON — persistent' } });
    } else {
      console.log('[AutonomousRunner] MAX PACE OFF');
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: 'MAX PACE OFF — normal pace resumed' } });
    }
  }

  async getAdapterSummary() {
    const defaultAdapter = this.config.defaultAdapter ?? 'codex';
    const defaultRoles = this.config.defaultRoles;
    const workerAdapter = defaultRoles?.worker?.adapter ?? defaultAdapter;
    const reviewerAdapter = defaultRoles?.reviewer?.adapter ?? defaultAdapter;

    return {
      defaultAdapter,
      worker: {
        adapter: workerAdapter,
        // Resolve the adapter's real default when config omits the model, so the
        // dashboard's PAIR bar shows what's running instead of "-". (INT-2393)
        model: defaultRoles?.worker?.model ?? this.config.workerModel
          ?? await resolveAdapterDefaultModel(workerAdapter, this.defaultModelCache),
        enabled: defaultRoles?.worker?.enabled !== false,
      },
      reviewer: {
        adapter: reviewerAdapter,
        model: defaultRoles?.reviewer?.model ?? this.config.reviewerModel
          ?? await resolveAdapterDefaultModel(reviewerAdapter, this.defaultModelCache),
        enabled: defaultRoles?.reviewer?.enabled !== false,
      },
      tester: defaultRoles?.tester ? {
        adapter: defaultRoles.tester.adapter ?? defaultAdapter,
        model: defaultRoles.tester.model,
        enabled: defaultRoles.tester.enabled !== false,
      } : undefined,
      documenter: defaultRoles?.documenter ? {
        adapter: defaultRoles.documenter.adapter ?? defaultAdapter,
        model: defaultRoles.documenter.model,
        enabled: defaultRoles.documenter.enabled !== false,
      } : undefined,
    };
  }

  private applyProviderConfig(adapter: AdapterName, overrideRoleAdapters = true): void {
    // On a provider switch, keep the model only if it clearly belongs to the new
    // provider; otherwise drop it (undefined) so the target adapter resolves its
    // own default via getDefaultModel(). Shared with the planner's model guard
    // (src/adapters/modelCompat.ts) so both stay in sync. (INT-2510)
    const mapModelForProvider = (model: string | undefined, _role?: string): string | undefined =>
      mapModelForAdapter(adapter, model);

    this.config.defaultAdapter = adapter;

    if (this.config.defaultRoles) {
      const roleConfig = <T extends { adapter?: AdapterName; model?: string }>(role: T): T => {
        if (!overrideRoleAdapters && role.adapter) return role;
        return {
          ...role,
          adapter,
          model: mapModelForProvider(role.model),
        };
      };
      this.config.defaultRoles.worker = {
        ...roleConfig(this.config.defaultRoles.worker),
      };
      this.config.defaultRoles.reviewer = {
        ...roleConfig(this.config.defaultRoles.reviewer),
      };

      if (this.config.defaultRoles.tester) {
        this.config.defaultRoles.tester = {
          ...roleConfig(this.config.defaultRoles.tester),
        };
      }
      if (this.config.defaultRoles.documenter) {
        this.config.defaultRoles.documenter = {
          ...roleConfig(this.config.defaultRoles.documenter),
        };
      }
      if (this.config.defaultRoles.auditor) {
        this.config.defaultRoles.auditor = {
          ...roleConfig(this.config.defaultRoles.auditor),
        };
      }
      if (this.config.defaultRoles['skill-documenter']) {
        this.config.defaultRoles['skill-documenter'] = {
          ...roleConfig(this.config.defaultRoles['skill-documenter']),
        };
      }
    }

    if (this.config.workerModel) {
      this.config.workerModel = mapModelForProvider(this.config.workerModel, 'worker');
    }
    if (this.config.reviewerModel) {
      this.config.reviewerModel = mapModelForProvider(this.config.reviewerModel, 'reviewer');
    }
    // The decomposition planner is a role too. Leaving it unmapped sent the
    // config's codex id straight into `claude -p --model gpt-5.5` — a fast 404
    // that killed EVERY decomposition on the new provider. (INT-2510)
    if (this.config.plannerModel) {
      this.config.plannerModel = mapModelForProvider(this.config.plannerModel, 'planner');
    }

    // jobProfiles ALSO pin per-role models (config's light/heavy → e.g. qwen), and getModelForRole
    // gives the profile model precedence over defaultRoles. Remapping only defaultRoles left every
    // estimate-matched task on its old provider's model → "I switched to Codex but it still uses the
    // old provider". Remap the profiles too: an incompatible id becomes undefined so the adapter
    // falls back to its OWN default model.
    if (this.config.jobProfiles) {
      for (const profile of this.config.jobProfiles) {
        if (!profile.roles) continue;
        for (const role of Object.keys(profile.roles) as Array<keyof typeof profile.roles>) {
          const mapped = mapModelForProvider(profile.roles[role], role);
          if (mapped === undefined) delete profile.roles[role];
          else profile.roles[role] = mapped;
        }
      }
    }
  }

  switchProvider(adapter: AdapterName): void {
    const previousAdapter = this.config.defaultAdapter ?? 'codex';
    this.applyProviderConfig(adapter);

    // A provider quota belongs to the provider that reported it. Keeping the
    // old reset timestamp after an explicit provider switch leaves every free
    // scheduler slot idle even though the replacement provider is available.
    // Only release quota-paused runs; task/infra failures and human gates keep
    // their durable state.
    if (adapter !== previousAdapter) {
      this.rateLimitUntil = 0;
      for (const run of this.durableRuns.listRuns(['RETRY_AT'])) {
        if (run.lastErrorCode === 'rate_limited') this.durableRuns.markReady(run.issueId);
      }
      this.scheduleNextHeartbeat();
    }

    // Persist the choice so a daemon restart keeps it (in-memory switch was lost every restart).
    writeProviderOverride(adapter);
    console.log(`[AutonomousRunner] Provider switched: ${adapter.replace(/[\r\n]/g, '')}`);
  }

  pauseScheduler(): void { this.scheduler.pause(); }
  resumeScheduler(): void { this.scheduler.resume(); }
  getQueuedTasks() { return this.scheduler.getQueuedTasks(); }
  getRunningTasks() { return this.scheduler.getRunningTasks(); }
  getPipelineHistory(limit = 50) { return getPipelineHistory(limit); }
  /** Epoch ms until which the scheduler holds for a provider rate limit (0 = none). */
  getRateLimitHoldUntil(): number { return this.rateLimitUntil; }
  /** Durable ledger record for an issue — the authoritative worktree/branch source. */
  getDurableRun(issueId: string) { return this.durableRuns.getRun(issueId); }
  getFailureCauseSummary(limit = 50) { return aggregateFailureCauses(getPipelineHistory(limit)); }

  private recordPipelineHistory(task: TaskItem, result: PipelineResult): void {
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

  disableProject(projectPath: string): void {
    this.projectSelectionTouched = true; // empty set now means "nothing runs" (INT-2207)
    const canonicalPath = normalizeProjectPath(projectPath);
    for (const enabled of this.enabledProjects) {
      if (normalizeProjectPath(enabled) === canonicalPath) this.enabledProjects.delete(enabled);
    }
    console.log(`[AutonomousRunner] Project disabled: ${canonicalPath.replace(/[\r\n]/g, '')}`);
    // Disabling gates new selection AND cancels any in-flight pipeline for this
    // project — otherwise a running task keeps working a now-disabled repo.
    const cancelled = this.scheduler.cancelProjectTasks(canonicalPath);
    if (cancelled > 0) {
      this.syslog(`⏹ Cancelled ${cancelled} in-flight task(s) for disabled project ${canonicalPath.split('/').pop()}`);
    }
    this.persistSelection();
  }

  enableProject(projectPath: string): void {
    this.projectSelectionTouched = true; // explicit selection from here on (INT-2207)
    const canonicalPath = normalizeProjectPath(projectPath);
    this.enabledProjects.add(canonicalPath);
    // Enabling a repo (via `openswarm add` / the dashboard) must also ALLOW it:
    // resolveProjectPath only reads a repo's openswarm.json for paths in
    // allowedProjects, so an enabled-but-not-allowed repo never resolves
    // ("No repo mapped"). Keep config + DecisionEngine in sync. (INT-1970)
    const allowed = this.config.allowedProjects ?? [];
    if (!allowed.some((allowedPath) => normalizeProjectPath(allowedPath) === canonicalPath)) {
      this.updateAllowedProjects([...allowed, canonicalPath]);
    }
    console.log(`[AutonomousRunner] Project enabled: ${canonicalPath.replace(/[\r\n]/g, '')}`);
    this.persistSelection();
  }

  /** Get all currently enabled project paths */
  getEnabledProjects(): string[] {
    return Array.from(this.enabledProjects);
  }

  /**
   * Running pipeline tasks for the dashboard process view. With native in-process
   * adapters (codex-responses/openrouter/local) there is no child PID to show in
   * the OS process registry, so the dashboard reads these instead.
   */
  getRunningPipelines(): Array<{
    id: string; issue?: string; title: string; project: string;
    projectPath: string; startedAt: number; stage?: string;
  }> {
    return this.scheduler.getRunningTasks().map((r) => ({
      id: r.task.id,
      issue: r.task.issueIdentifier,
      title: r.task.title,
      project: r.task.linearProject?.name ?? r.projectPath.split('/').pop() ?? r.projectPath,
      projectPath: r.projectPath,
      startedAt: r.startedAt,
      stage: r.stage,
    }));
  }

  /** Cancel a running pipeline task by id (manual stop from the dashboard). */
  cancelTask(taskId: string): boolean {
    return this.scheduler.cancelTask(taskId);
  }

  /** Pre-register project path in cache (name → path) */
  registerProjectPath(name: string, projectPath: string): void {
    if (!this.projectPathCache.has(name)) {
      this.projectPathCache.set(name, projectPath);
    }
    // Also register capitalized variant to handle "openswarm" ↔ "Openswarm" mismatch
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    if (capitalized !== name && !this.projectPathCache.has(capitalized)) {
      this.projectPathCache.set(capitalized, projectPath);
    }
  }

  getProjectsInfo(): ProjectInfo[] {
    const running = this.scheduler.getRunningTasks();
    const queued = this.scheduler.getQueuedTasks();
    // Update path cache from currently running tasks
    for (const r of running) {
      if (r.task.linearProject?.name) this.projectPathCache.set(r.task.linearProject.name, r.projectPath);
    }
    return buildProjectsInfo(this.lastFetchedTasks, running, queued, this.projectPathCache, this.enabledProjects);
  }
}

export function getRunner(config?: AutonomousConfig): AutonomousRunner {
  if (!runnerInstance && config) {
    // Declared once, where the process gets its one runner. The coordination
    // trace resolves its own path and has to land on the ledger's file; saying
    // so from the constructor instead would let two runners built in one process
    // redirect each other's archive, which is a shape only a test has.
    setAutomationDbPath(config.automationDbPath);
    runnerInstance = new AutonomousRunner(config);
  }
  if (!runnerInstance) {
    throw new Error('Runner not initialized. Call getRunner with config first.');
  }
  return runnerInstance;
}

/**
 * Start runner (convenience function)
 */
export async function startAutonomous(config: AutonomousConfig): Promise<AutonomousRunner> {
  const runner = getRunner(config);
  await runner.start();
  // A runner already running in explicit-dispatch mode occupies the singleton,
  // and start() above is a no-op on it — without this, `!auto start` after a
  // `autonomous.enabled: false` boot would report success while changing
  // nothing. Runtime activation flips the heartbeat on in place. (INT-3388)
  if (config.autonomousHeartbeat !== false) runner.enableHeartbeat();
  return runner;
}

/**
 * Stop runner (convenience function)
 */
export async function stopAutonomous(): Promise<void> {
  if (runnerInstance) {
    const stoppingRunner = runnerInstance;
    await stoppingRunner.stop();
    if (runnerInstance === stoppingRunner) runnerInstance = null;
  }
}
