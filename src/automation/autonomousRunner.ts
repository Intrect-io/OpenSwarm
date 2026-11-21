// OpenSwarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
import { Cron } from 'croner';
import { createHeartbeatCron, IdleBackoff } from './idleBackoff.js';
import {
  loadTaskState,
  saveTaskState,
  buildProjectsInfo,
  getPipelineHistory,
  aggregateFailureCauses,
  getDailyPaceInfo,
  loadProjectSelection,
  saveProjectSelection,
  type LastFailureEntry,
  type TaskState,
  type ProjectInfo,
} from './runnerState.js';
import { taskEventKey, DecisionEngine, DecisionResult, TaskItem, getDecisionEngine, composeDispatchScope, pathIsUnderAny } from '../orchestration/decisionEngine.js';
import { resolveOrchestratorConfig } from '../coordination/orchestratorConfig.js';
import { OrchestratorSupervisor } from '../coordination/orchestratorSupervisor.js';
import { repositoryCell } from '../coordination/repositoryCell.js';
// ExecutorResult used via execution.reportExecutionResult
import { checkWorkAllowed } from '../support/timeWindow.js';
import { resolveOwningProject, resolveProjectGoal } from '../support/projectGoal.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { TaskScheduler, initScheduler, normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { PipelineResult, formatPipelineResultEmbed } from '../agents/pairPipeline.js';
import type { DefaultRolesConfig } from '../core/types.js';
import { resolveHardTaskTimeoutMs } from '../orchestration/taskBudget.js';
import { stageTimeoutMs } from '../agents/stageTimeouts.js';
import { dispatchBudget, recordDispatchClaims } from './dispatchRamp.js';
import * as execution from './runnerExecution.js';
import * as taskFilter from './runnerTaskFilter.js';
import type { TaskFilterHost } from './runnerTaskFilter.js';
import * as candidateAdmission from './runnerCandidateAdmission.js';
import type { CachedDraftScope, CandidateAdmissionHost } from './runnerCandidateAdmission.js';
import * as maintenance from './runnerMaintenance.js';
import { createMaintenanceState, type MaintenanceHost } from './runnerMaintenance.js';
import { attachSchedulerEvents, type SchedulerEventsHost } from './runnerSchedulerEvents.js';
import * as durableReconcile from './runnerDurableReconcile.js';
import { createDurableReconcileState, type DurableReconcileHost } from './runnerDurableReconcile.js';
import { pruneDraftCache } from './draftCache.js';
import { pruneSessionLogs } from '../support/sessionLog.js';
import { pruneScratchpads } from '../support/scratchpad.js';
import { pruneSnapshots } from '../support/worktreeSnapshot.js';
import { reportToDiscord, fetchLinearTasks, getTaskSource } from './runnerExecution.js';
import { runLedgerRetrospective } from './ledgerRetrospective.js';
import { t } from '../locale/index.js';
import { HostDiskGate, dispatchWritePaths } from '../support/hostHealth.js';
import { reclaimWorktreesUnderDiskPressure } from './diskPressureReclaim.js';
import { decideExplicitReadmission } from './explicitDispatchReadmission.js';
import { broadcastEvent, type SwarmStats } from '../core/eventHub.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import { getTaskState, reconcileDependencyBlockers, updateTaskLinearState } from '../taskState/store.js';
import { defaultAutomationDbPath, setAutomationDbPath } from './automationDbPath.js';
import { RunnerPauseControl } from './runnerPauseControl.js';
import { providerSwitchViolation } from '../adapters/unattendedPolicy.js'; import { providerSwitchFamilyViolation } from '../adapters/reviewerIndependence.js';
import { pruneWorktrees } from '../support/worktreeManager.js';
import { isExecutionLive } from './executionLiveness.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { startEventLoopMonitor } from '../support/eventLoopMonitor.js';
import { dirname } from 'node:path';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export { pickPipelineFailureDetail } from './runnerState.js';
export { parkRunForHuman } from './runnerParking.js';
import type { AdapterName } from '../adapters/types.js';

import { mapModelForProvider as mapModelForAdapter } from '../adapters/modelCompat.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import {
  DurableRunCoordinator,
  type ExecutionDurabilityHooks,
} from './durableRunCoordinator.js';
import type { EffectClaim, RunLedgerMode } from './runLedger.js';
import {
  buildIntegrationRequeueEffect,
  completionStats,
} from './trackerEffects.js';
import { reconcileTrackerTerminalRuns } from './trackerTerminalReconciler.js';
import { planStalledInProgress } from './stalledInProgress.js';
import { DEFAULT_AGENT_SKIP, formatSkipSummary, partitionHumanOwned } from './agentEligibility.js';
import { exclusionCheck, formatReadinessSummary, projectSkipLabelsHook } from './readinessGate.js'; import { definitionOfReadyHooks, partitionByDefinitionOfReady } from './definitionOfReady.js';
import { completeParentIfChildrenDone as completeParentLocally } from '../taskState/store.js'; import { transitionWithReason } from './trackerTransition.js'; import { releaseDependentsInTracker } from './dependentRelease.js';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import {
  isExplicitAdmissionRetry,
  planExplicitDeferredRecovery,
} from './explicitDispatchRecovery.js';
import { buildInstructionCapsule } from '../agents/instructionCapsule.js';
import type { IntegrationConflictEvidence } from './integrationCoordinator.js';
import { globalRateLimit } from './rateLimitBackoff.js';

// Re-export types and integration setters (used by service.ts)
export { setNotifier, setTaskSource } from './runnerExecution.js';
export type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export type { ProjectInfo } from './runnerState.js';
export {
  decisionSelectionBudget,
  effectiveProjectConcurrency,
  failClosedConflictFallback,
  worktreeFanoutEnabled,
  type RunnableCandidate,
} from './runnerAdmissionPolicy.js';
import {
  decisionSelectionBudget,
  effectiveProjectConcurrency,
  type RunnableCandidate,
} from './runnerAdmissionPolicy.js';

let runnerInstance: AutonomousRunner | null = null;

// The completion/cancellation effect payload contract (and its delivery) lives
// in trackerEffects.ts, shared with the `openswarm work` CLI so the marker
// format cannot drift between the two outbox writers. (INT-3387)

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
  private scheduler: TaskScheduler;
  private readonly durableRuns: DurableRunCoordinator;
  private readonly schedulerHandlers = new Set<Promise<void>>();
  /** Adapter default-model cache for the dashboard PAIR bar (INT-2393). */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();
  /** Unknown write scopes deferred by a known-first wave, repaid one at a time. */
  private unknownScopeDebt = new Set<string>();
  /** Sufficient drafted scopes survive heartbeat refetches and feed the pipeline. */
  private preAdmissionScopeCache = new Map<string, CachedDraftScope>();
  private cronJob: Cron | null = null; private readonly idle = new IdleBackoff({ log: (line) => this.syslog(line) }); // AGT-4607
  private periodicReviewJobs: Cron[] = [];
  private orchestratorSupervisor: OrchestratorSupervisor | null = null;
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

  /**
   * Repositories that background services may touch. Once the operator has
   * touched project selection, an empty enabled set means exactly zero — never
   * fall back to every allowed repository behind the UI's back.
   */
  private getBackgroundServiceProjects(): string[] {
    return this.shouldFilterByEnabled() ? this.getEnabledProjects() : this.getAllowedProjects();
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

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private failedTaskRetryTimes = new Map<string, number>(); // issueId → next retry timestamp (ms)
  // issueId → consecutive infra_error count since its last cleared/terminal
  // outcome (success, permanent block, operator park, or manual recovery — the
  // same events that already clear failedTaskRetryTimes for this issueId).
  // A non-infra failure that is retried again (rejection under the limit,
  // 'superseded', etc.) leaves this untouched by design: it only needs to be
  // conservative in one direction, never resetting is safe, silently resetting
  // on the wrong event is not. Not persisted across restarts — a restart is
  // itself a reasonable "give it a fresh run" signal, and losing the streak on
  // restart only ever makes the gate below MORE permissive, never less safe.
  // (AGT-4305)
  private consecutiveInfraErrorCounts = new Map<string, number>();

  // Operator-answer readmission (readmitAnsweredRun, parkedOnOperator,
  // resumeAnsweredQuestionPark, answerArrivedFor) and the heartbeat's
  // already-processed filter live in runnerTaskFilter.ts (AGT-4867). These
  // delegators keep the runner's names, which tests call and reassign; the
  // moved code calls back through the host, so a reassignment is honoured.
  private readmitAnsweredRun(issueId: string): boolean { return taskFilter.readmitAnsweredRun(this.taskFilterHost(), issueId); }
  private parkedOnOperator(issueId: string): boolean { return taskFilter.parkedOnOperator(this.taskFilterHost(), issueId); }
  private resumeAnsweredQuestionPark(issueId: string): boolean { return taskFilter.resumeAnsweredQuestionPark(this.taskFilterHost(), issueId); }
  private answerArrivedFor(issueId: string): boolean { return taskFilter.answerArrivedFor(this.taskFilterHost(), issueId); }
  private filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] { return taskFilter.filterAlreadyProcessed(this.taskFilterHost(), tasks); }

  private taskFilterHostCache: TaskFilterHost | undefined;
  /** Built once; every member reads the runner at call time (see TaskFilterHost). */
  private taskFilterHost(): TaskFilterHost {
    if (this.taskFilterHostCache) return this.taskFilterHostCache;
    const runner = () => this;
    this.taskFilterHostCache = {
      get scheduler() { return runner().scheduler; },
      get durableRuns() { return runner().durableRuns; },
      get completedTaskIds() { return runner().completedTaskIds; },
      get failedTaskCounts() { return runner().failedTaskCounts; },
      get failedTaskRetryTimes() { return runner().failedTaskRetryTimes; },
      get consecutiveInfraErrorCounts() { return runner().consecutiveInfraErrorCounts; },
      get unresolvableIssueIds() { return runner().unresolvableIssueIds; },
      maxRetryCount: AutonomousRunner.MAX_RETRY_COUNT,
      answerArrivedFor: (issueId) => this.answerArrivedFor(issueId),
      readmitAnsweredRun: (issueId) => this.readmitAnsweredRun(issueId),
      resumeAnsweredQuestionPark: (issueId) => this.resumeAnsweredQuestionPark(issueId),
      parkedOnOperator: (issueId) => this.parkedOnOperator(issueId),
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      saveTaskState: () => this.saveTaskState(),
      syslog: (line) => this.syslog(line),
    };
    return this.taskFilterHostCache;
  }
  // Last failure feedback per issue — re-injected into the next attempt's worker
  // prompt so re-picked tasks don't restart blind and repeat the same mistake
  // the reviewer already called out (INT-2474). Persisted; cleared on success.
  private lastFailureDetails = new Map<string, LastFailureEntry>();
  private static readonly MAX_RETRY_COUNT = 4; // Increased from 2 to allow more retries with backoff

  // Rate-limit hold: epoch ms until which all task execution is paused.
  // Set when any adapter returns a 429 / usage_limit_reached response (INT-1906).
  private rateLimitUntil = 0;
  // Disk-space hold: new claims wait while the volumes we write to are nearly full (AGT-4785).
  private readonly diskGate = new HostDiskGate(
    // The directory holding the automation database is measured too: on a deployment whose state
    // lives on its own volume, a full state volume fails ledger writes (SQLITE_FULL) while every
    // project volume and the temp dir still look healthy.
    () => dispatchWritePaths(
      this.config.allowedProjects.map((p) => normalizeProjectPath(p)),
      [dirname(this.config.automationDbPath ?? defaultAutomationDbPath())],
    ),
    () => (this.config.minFreeDiskGiB ?? 10) * 1024 ** 3,
  );

  // Kill switch (AGT-4808): the durable pause table, read by the heartbeat, the candidate loop and executeDurably.
  readonly pauses = new RunnerPauseControl(() => this.config.automationDbPath ?? defaultAutomationDbPath());
  // Issues whose Linear project can't be mapped to a local repo path. Recorded on
  // the first resolve failure so they aren't re-picked every heartbeat (which
  // starved other actionable tasks — they were top-priority but never runnable). (INT-1875)
  private unresolvableIssueIds = new Set<string>();

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
      dryRun: config.dryRun,
      includeBacklog: config.includeBacklog ?? false, // AGT-4784: Todo is the ready signal
      // Same-project parallel selection only makes sense when the scheduler can
      // actually run those tasks concurrently (worktree isolation). (INT-2318)
      sameProjectParallel: (config.allowSameProjectConcurrent ?? true) && (config.worktreeMode ?? false),
      // The local in_progress marker outlives a run that died; ask what is
      // actually executing (AGT-4667). Lazy, so it reads the live scheduler and ledger.
      isExecutionLive: (issueId) => isExecutionLive({
        schedulerHolds: Boolean(this.scheduler?.isTaskRunning(issueId) || this.scheduler?.isTaskQueued(issueId)),
        ledgerState: this.durableRuns?.isPrimary ? this.durableRuns.getRun(issueId)?.state : undefined,
      }),
    });

    // Initialize TaskScheduler
    // Same-repo parallelism is opt-in via config (default true) but the scheduler
    // force-disables it unless worktreeMode is on — see TaskScheduler guard. (INT-1975)
    // One budget, two readers: the watchdog below and the pipeline's iteration
    // loop get the same number, so a task can no longer be promised five
    // attempts and given time for three and a half (AGT-4430).
    const hardTaskTimeoutMs = resolveHardTaskTimeoutMs({
      maxIterations: config.pairMaxAttempts ?? 3,
      workerTimeoutMs: stageTimeoutMs('worker', config.defaultRoles?.worker?.timeoutMs),
      otherStagesTimeoutMs: enabledStageTimeoutsMs(config.defaultRoles, config.verify),
    });
    console.log(`[Scheduler] Task wall-clock budget: ${Math.round(hardTaskTimeoutMs / 60_000)}min for ${config.pairMaxAttempts ?? 3} iteration(s)`);
    this.scheduler = initScheduler({
      hardTaskTimeoutMs,
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: config.allowSameProjectConcurrent ?? true,
      // Preserve omission for TaskScheduler: undefined activates its weighted,
      // work-conserving fairness without inventing a hidden hard project cap.
      // Durable admission still receives the effective global safety ceiling.
      maxConcurrentPerProject: config.maxConcurrentPerProject == null
        ? undefined
        : effectiveProjectConcurrency(config),
      worktreeMode: config.worktreeMode ?? false,
    });

    const ledgerMode: RunLedgerMode = config.automationLedgerMode
      ?? (config.dryRun ? 'off' : 'primary');
    this.durableRuns = new DurableRunCoordinator({
      mode: ledgerMode,
      dbPath: config.automationDbPath,
      leaseMs: config.automationLeaseMs,
      maxActiveForProject: effectiveProjectConcurrency(config),
      infraFailureCircuit: config.infraFailureCircuit,
    });

    // Set up scheduler event handling
    this.setupSchedulerEvents(); this.idle.attach(this.scheduler);
  }

  // The scheduler event handlers (and the pipeline-history record they write) live in
  // runnerSchedulerEvents.ts (AGT-4867 slice D); they reach the runner through the
  // late-bound host below, so a reassigned runner member is honoured at call time.
  private setupSchedulerEvents(): void { attachSchedulerEvents(this.schedulerEventsHost()); }

  private schedulerEventsHostCache: SchedulerEventsHost | undefined;
  /** Built once (from the constructor); every member reads the runner at call time (see SchedulerEventsHost). */
  private schedulerEventsHost(): SchedulerEventsHost {
    if (this.schedulerEventsHostCache) return this.schedulerEventsHostCache;
    const runner = () => this;
    this.schedulerEventsHostCache = {
      get scheduler() { return runner().scheduler; },
      get durableRuns() { return runner().durableRuns; },
      get config() { return runner().config; },
      get completedTaskIds() { return runner().completedTaskIds; },
      get failedTaskCounts() { return runner().failedTaskCounts; },
      get failedTaskRetryTimes() { return runner().failedTaskRetryTimes; },
      get consecutiveInfraErrorCounts() { return runner().consecutiveInfraErrorCounts; },
      get lastFailureDetails() { return runner().lastFailureDetails; },
      get taskStateRef() { return runner().taskStateRef; },
      get diskGate() { return runner().diskGate; },
      maxRetryCount: AutonomousRunner.MAX_RETRY_COUNT,
      get rateLimitUntil() { return runner().rateLimitUntil; },
      set rateLimitUntil(value: number) { runner().rateLimitUntil = value; },
      formatTaskContext: (task) => this.formatTaskContext(task),
      trackSchedulerHandler: (label, operation) => this.trackSchedulerHandler(label, operation),
      saveTaskState: () => this.saveTaskState(),
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      drainDurableOutbox: () => this.drainDurableOutbox(),
      runAvailableTasks: () => this.runAvailableTasks(),
    };
    return this.schedulerEventsHostCache;
  }

  private trackSchedulerHandler(label: string, operation: Promise<void>): void {
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

  // Durable execution admission, the missing-worktree sweep, artifact reconciliation, legacy
  // import and the outbox drain live in runnerDurableReconcile.ts (AGT-4867 slice E). These
  // delegators keep the runner's names, which tests call and reassign; the moved code calls
  // back through the host, so a reassignment is honoured.
  private readonly durableReconcileState = createDurableReconcileState();
  private executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult> { return durableReconcile.executeDurably(this.durableReconcileHost(), task, projectPath, signal); }
  private reconcileMissingWorktreePointers(): Promise<void> { return durableReconcile.reconcileMissingWorktreePointers(this.durableReconcileHost()); }
  private reconcileDurableArtifacts(tasks: TaskItem[]): Promise<void> { return durableReconcile.reconcileDurableArtifacts(this.durableReconcileHost(), tasks); }
  private migrateLegacyRunState(tasks: TaskItem[]): Promise<void> { return durableReconcile.migrateLegacyRunState(this.durableReconcileHost(), tasks); }
  private deliverOutboxEffect(effect: EffectClaim): Promise<void> { return durableReconcile.deliverOutboxEffect(effect); }
  private drainDurableOutbox(): Promise<void> { return durableReconcile.drainDurableOutbox(this.durableReconcileHost()); }

  private durableReconcileHostCache: DurableReconcileHost | undefined;
  /** Built once; every member reads the runner at call time (see DurableReconcileHost). */
  private durableReconcileHost(): DurableReconcileHost {
    if (this.durableReconcileHostCache) return this.durableReconcileHostCache;
    const runner = () => this;
    this.durableReconcileHostCache = {
      get durableReconcile() { return runner().durableReconcileState; },
      get config() { return runner().config; },
      get durableRuns() { return runner().durableRuns; },
      get pauses() { return runner().pauses; },
      get stopping() { return runner().stopping; },
      get completedTaskIds() { return runner().completedTaskIds; },
      get failedTaskCounts() { return runner().failedTaskCounts; },
      get failedTaskRetryTimes() { return runner().failedTaskRetryTimes; },
      get consecutiveInfraErrorCounts() { return runner().consecutiveInfraErrorCounts; },
      get lastFailureDetails() { return runner().lastFailureDetails; },
      maxRetryCount: AutonomousRunner.MAX_RETRY_COUNT,
      getRunningTasks: () => this.getRunningTasks(),
      syslog: (line) => this.syslog(line),
      saveTaskState: () => this.saveTaskState(),
      resolveProjectPath: (task) => this.resolveProjectPath(task),
      executePipeline: (task, projectPath, signal, durability) => this.executePipeline(task, projectPath, signal, durability),
      deliverOutboxEffect: (effect) => this.deliverOutboxEffect(effect),
      drainDurableOutbox: () => this.drainDurableOutbox(),
    };
    return this.durableReconcileHostCache;
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
      advisor: projectConfig.roles.advisor
        ? { ...base.advisor, ...projectConfig.roles.advisor }
        : base.advisor,
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
      this.cronJob = createHeartbeatCron(this.config.heartbeatSchedule, this.idle, () => this.heartbeat()); // ticks gated by idle backoff (AGT-4607)
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
  private async recoverParkedRunsOnly(): Promise<void> {
    if (!this.durableRuns.isPrimary) return;
    const inScope = this.getDispatchScopePredicate();
    const needsArtifactRecovery = this.durableRuns.listRuns(['NEEDS_RECONCILE']).length > 0;
    const explicitDeferredRuns = this.durableRuns.listRuns(['RETRY_AT'])
      .filter((run) => isExplicitAdmissionRetry(run, inScope));
    let tasks: TaskItem[] = [];
    if (needsArtifactRecovery || explicitDeferredRuns.length > 0) {
      const fetchResult = await fetchLinearTasks();
      if (fetchResult.error) {
        console.warn(`[AutonomousRunner] Explicit-mode recovery fetch failed: ${fetchResult.error}`);
      } else {
        tasks = fetchResult.tasks;
        if (needsArtifactRecovery) await this.reconcileDurableArtifacts(tasks);

        let restored = 0;
        for (const recovery of planExplicitDeferredRecovery(explicitDeferredRuns, tasks, inScope)) {
          // Re-read the row immediately before taking in-memory ownership. A
          // second daemon may have claimed or reclassified the snapshot while
          // the tracker fetch was in flight; durable claim fencing handles the
          // remaining race when the deadline arrives.
          const current = this.durableRuns.getRun(recovery.run.issueId);
          if (
            !current
            || current.stateVersion !== recovery.run.stateVersion
            || !isExplicitAdmissionRetry(current, inScope)
            || current.retryAt !== recovery.retryAt
          ) continue;
          if (this.scheduler.isTaskQueued(recovery.task.id) || this.scheduler.isTaskRunning(recovery.task.id)) {
            continue;
          }
          if (this.enqueueCandidate(recovery.task, recovery.projectPath, recovery.retryAt)) restored++;
        }
        if (restored > 0) {
          console.log(`[AutonomousRunner] Restored ${restored} explicit deferred task(s) from durable RETRY_AT`);
          await this.runAvailableTasks();
        }
      }
    }
    await reconcileTrackerTerminalRuns({
      durableRuns: this.durableRuns,
      source: getTaskSource(),
      inScope,
      knownTasks: tasks,
    });
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
    this.cronJob = createHeartbeatCron(this.config.heartbeatSchedule, this.idle, () => this.heartbeat());
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
    await this.orchestratorSupervisor?.stop();
    this.orchestratorSupervisor = null;

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

  // The maintenance lanes (knowledge-graph refresh, registry scan, skip summary,
  // backlog grooming, merged-publication sweep) and their state live in
  // runnerMaintenance.ts (AGT-4867). These delegators keep the runner's names,
  // which tests call and reassign; the moved code calls back through the host,
  // so a reassignment is honoured.
  private readonly maintenanceState = createMaintenanceState();
  private refreshKnowledgeGraphs(): void { maintenance.refreshKnowledgeGraphs(this.maintenanceHost()); }
  private refreshCodeRegistries(): void { maintenance.refreshCodeRegistries(this.maintenanceHost()); }
  private resolveRegistryProjectId(projectPath: string): string { return maintenance.resolveRegistryProjectId(projectPath); }
  private syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void { maintenance.syslogSkipSummary(this.maintenanceHost(), unmapped, disabled); }
  private groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> { return maintenance.groupTasksForGrooming(this.maintenanceHost(), tasks); }
  private maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]> { return maintenance.maybeRunBacklogGrooming(this.maintenanceHost(), tasks); }
  private reconcileMergedPublications(tasks: TaskItem[], now?: number): Promise<void> { return maintenance.reconcileMergedPublications(this.maintenanceHost(), tasks, now); }

  private maintenanceHostCache: MaintenanceHost | undefined;
  /** Built once; every member reads the runner at call time (see MaintenanceHost). */
  private maintenanceHost(): MaintenanceHost {
    if (this.maintenanceHostCache) return this.maintenanceHostCache;
    const runner = () => this;
    this.maintenanceHostCache = {
      get maintenance() { return runner().maintenanceState; },
      get config() { return runner().config; },
      get scheduler() { return runner().scheduler; },
      get durableRuns() { return runner().durableRuns; },
      syslog: (line) => this.syslog(line),
      resolveProjectPath: (task) => this.resolveProjectPath(task),
      resolveRegistryProjectId: (projectPath) => this.resolveRegistryProjectId(projectPath),
      groupTasksForGrooming: (tasks) => this.groupTasksForGrooming(tasks),
      completeParentIfChildrenMerged: (childIssueId, source) => this.completeParentIfChildrenMerged(childIssueId, source),
    };
    return this.maintenanceHostCache;
  }

  /** Send system message to dashboard LIVE LOG */
  private syslog(line: string): void {
    const safeLine = line.replace(/[\r\n]/g, '');
    console.log(`[HB] ${safeLine}`);
    broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'heartbeat', line: safeLine } });
  }

  /**
   * The retrospective lane (AGT-4181): the runner reads its own ledger and
   * files one evidence-rich issue on the largest failure bucket, so the
   * systemic fixes an operator would derive from the same queries happen
   * without one. Isolated — a lane failure must not fail the heartbeat.
   */
  private async maybeRunLedgerRetrospective(): Promise<void> {
    if (!this.config.retrospectiveProjectId || !this.durableRuns.isPrimary || this.stopping) return;
    try {
      const source = getTaskSource();
      if (source) {
        const outcome = await runLedgerRetrospective({ taskSource: source, projectId: this.config.retrospectiveProjectId });
        if (outcome.filed) this.syslog(`🔁 Retrospective filed ${outcome.identifier}: ${outcome.reason}`);
      }
    } catch (error) {
      console.warn('[AutonomousRunner] Ledger retrospective failed:', error instanceof Error ? error.message : error);
    }
  }

  private async completeParentIfChildrenMerged(childIssueId: string, source: NonNullable<ReturnType<typeof getTaskSource>>): Promise<void> {
    const parentState = getTaskState(childIssueId)?.parentIssueId
      ? getTaskState(getTaskState(childIssueId)!.parentIssueId!)
      : undefined;
    if (!parentState || parentState.childIssueIds.length === 0) return;
    for (const childId of parentState.childIssueIds) {
      const lookup = await source.lookupIssueState(childId).catch(() => null);
      if (!lookup || !lookup.ok || !lookup.issue || lookup.issue.state.toLowerCase() !== 'done') return;
    }
    const parent = completeParentLocally(childIssueId);
    if (!parent) return;
    const accepted = await transitionWithReason(source, parent.issueId, 'Done', `All ${parent.childIssueIds.length} child tasks merged, so this parent closes as Done.`).catch(() => false);
    if (!accepted) return;
    await releaseDependentsInTracker(source, parent.issueId); // AGT-4817: tasks waiting on the parent go to Todo in the tracker too
    this.syslog(`✓ ${parent.issueIdentifier ?? parent.issueId}: all children merged → Done`);
  }

  /**
   * Keep Linear's In Progress column honest: it represents a scheduler-owned
   * task or a live durable lease, never an abandoned claim. The bulk heartbeat
   * fetch already carries updatedAt, so the sweep adds no read-side API calls.
   */
  private async reconcileStalledInProgress(tasks: TaskItem[], now = Date.now()): Promise<TaskItem[]> {
    const source = getTaskSource(); if (source?.kind !== 'linear') return tasks;

    const staleAfterMs = (this.config.stalledInProgressHours ?? 6) * 60 * 60_000;
    const candidates = planStalledInProgress(tasks, {
      isExcluded: await exclusionCheck(tasks, this.config.skip ?? DEFAULT_AGENT_SKIP, this.config.projectAgents, (t: TaskItem) => this.resolveProjectPath(t)), // AGT-4784
      now,
      staleAfterMs,
      hasOpenSwarmClaim: (issueId) =>
        this.durableRuns.getRun(issueId) != null
        && getTaskState(issueId)?.execution.status === 'in_progress',
      isSchedulerOwned: (issueId) => this.scheduler.isTaskQueued(issueId) || this.scheduler.isTaskRunning(issueId),
      hasLiveLease: (issueId) => {
        const run = this.durableRuns.getRun(issueId);
        return Boolean(
          run
          && ACTIVE_LEASE_STATES.includes(run.state)
          && run.leaseExpiresAt != null
          && run.leaseExpiresAt > now,
        );
      },
      hasPublishedArtifact: (issueId) => Boolean(this.durableRuns.getRun(issueId)?.prUrl),
    });

    let moved = 0;
    for (const { task, targetState } of candidates) {
      const issueId = task.issueId || task.id;
      // Re-read immediately before the write. The heartbeat snapshot may be
      // minutes old; a person or another daemon could have reclaimed or edited
      // the issue since then. Linear has no conditional issue-update mutation,
      // so an exact state+updatedAt match is the strongest available optimistic
      // guard and missing evidence must fail closed.
      const refreshed = await source.lookupIssueState(task.issueIdentifier ?? issueId).catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (
        !refreshed.ok
        || !refreshed.issue
        || refreshed.issue.state.toLowerCase() !== 'in progress'
        || !Number.isFinite(refreshed.issue.updatedAt)
        || refreshed.issue.updatedAt !== task.trackerUpdatedAt
      ) {
        console.warn(
          `[AutonomousRunner] Skipping stale-state repair for ${task.issueIdentifier ?? issueId}: tracker ownership changed or could not be revalidated`,
        );
        continue;
      }
      const reason = `No OpenSwarm run, lease or pull request has owned this issue for ${this.config.stalledInProgressHours ?? 6}h, so it returns to ${targetState}.`;
      const accepted = await transitionWithReason(source, issueId, targetState, reason).catch((error) => {
        console.warn(`[AutonomousRunner] Failed to retire stalled ${task.issueIdentifier ?? issueId}:`, error);
        return false;
      });
      if (!accepted) {
        console.warn(`[AutonomousRunner] Tracker refused stale-state repair for ${task.issueIdentifier ?? issueId}`);
        continue;
      }
      task.linearState = targetState; updateTaskLinearState(issueId, targetState);
      moved++;
      this.syslog(`↩ ${task.issueIdentifier ?? issueId}: stale In Progress → ${targetState}`);
    }
    if (moved > 0) this.syslog(`✓ Retired ${moved} stalled In Progress issue(s)`);
    return tasks;
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
    this.state.lastHeartbeat = Date.now(); this.idle.beginHeartbeat();
    broadcastEvent({ type: 'stats', data: this.buildStats() });
    broadcastEvent({ type: 'heartbeat' });
    this.syslog('▶ Heartbeat started');
    // Swept here rather than on read: a read only knows the one row it asked
    // for, so without this the table keeps every task the daemon ever drafted.
    const pruned = pruneDraftCache();
    if (pruned > 0) this.syslog(`  Pruned ${pruned} expired draft cache entr${pruned === 1 ? 'y' : 'ies'}`);
    // Session transcripts are written per agent invocation, so the directory
    // grows with every iteration of every attempt. Swept on the same cadence,
    // and the sweep itself skips anything a live recorder is still appending
    // to. (AGT-4442)
    const prunedSessions = pruneSessionLogs();
    if (prunedSessions > 0) this.syslog(`  Pruned ${prunedSessions} expired session log(s)`);
    // A task that finishes clears its own notes; this catches the ones that
    // never got there — killed, abandoned, or parked and then forgotten.
    // (AGT-4459)
    const prunedScratch = pruneScratchpads();
    if (prunedScratch > 0) this.syslog(`  Pruned ${prunedScratch} expired scratchpad(s)`);
    const prunedSnapshots = pruneSnapshots();
    if (prunedSnapshots > 0) this.syslog(`  Pruned ${prunedSnapshots} expired snapshot store(s)`);

    try {
      const expiredLeases = this.durableRuns.reconcile();
      if (expiredLeases.length > 0) {
        this.syslog(`⚠ Reconciled ${expiredLeases.length} expired execution lease(s)`);
      }
      await this.drainDurableOutbox();
      if (this.stopping) return;

      // 0. Knowledge graph refresh (async, service continues even on failure)
      this.refreshKnowledgeGraphs();
      // 0.05 Code-entity registry (Draft File Map / registryCheck) — throttled
      this.refreshCodeRegistries();

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
        // Pruning may have removed a tree whose durable row was still pointing
        // at it. Reconcile in this heartbeat, before admission sees it.
        await this.reconcileMissingWorktreePointers();
        if (this.stopping) return;
      }

      // 0.5 Long-running monitor passive check (before time window)
      const active = getActiveMonitors().filter(m => m.state === 'pending' || m.state === 'running');
      if (active.length > 0) {
        const checked = await checkAllMonitors().catch(() => 0);
        if (this.stopping) return;
        this.syslog(`✓ Monitors: ${checked} checked / ${active.length} active`);
      }

      // 1. Kill switch + anomaly auto-pause (AGT-4808, AGT-4809) before the holds below return, so a `now` pause
      // cancels and logs during them. Free disk is measured once here (AGT-4785); low disk pauses the factory (`auto:disk`).
      const disk = this.diskGate.evaluate();
      const dispatchable = await this.pauses.apply(this.scheduler, (line) => this.syslog(line), { projects: this.config.allowedProjects, alert: reportToDiscord, diskLow: disk.pause && !disk.hold ? disk.line : undefined }); // a timed ENOSPC hold is not a factory pause
      if (disk.notice) { // before the time-window return, or a recovery seen on a blocked heartbeat is lost
        console.warn(`[AutonomousRunner] ${disk.notice}`);
        if (!disk.pause) await reportToDiscord(`✅ ${disk.notice}`);
      }
      const timeCheck = checkWorkAllowed();
      if (!timeCheck.allowed) {
        console.log(`[AutonomousRunner] Blocked: ${timeCheck.reason}`);
        this.syslog(`⛔ Time window blocked: ${timeCheck.reason}`);
        return;
      }
      this.syslog('✓ Time window: allowed');

      // 1.1 Disk-space hold (AGT-4785), measured above after the worktree sweep; the low reading's one alert is auto:disk's.
      // A measured low (not an unconfirmed-ENOSPC hold) also reclaims pushed RETRY_AT/CANCELLED worktrees, or nothing frees space (AGT-4816).
      if (disk.pause) { this.syslog(`⏸ Disk space hold: ${disk.line}`); if (!disk.hold) await reclaimWorktreesUnderDiskPressure({ durableRuns: this.durableRuns, projects: this.config.allowedProjects, spaceRecovered: () => !this.diskGate.belowFloor(), runningWorktreePaths: this.scheduler.getRunningTasks().map((r) => `${r.projectPath}/worktree/${r.task.issueId}`), stopping: () => this.stopping, log: (line) => this.syslog(`♻ ${line}`) }); return; }

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

      // 2. Fetch tasks from Linear; a pause (or unreadable pause table) stops the heartbeat before it (AGT-4808)
      if (!dispatchable) { this.syslog('⏸ Dispatch held (factory paused or pause table unreadable); heartbeat stops before fetch'); return; }
      this.syslog('⟳ Fetching tasks from Linear...');
      const fetchResult = await fetchLinearTasks();
      if (this.stopping) return;
      if (fetchResult.error) {
        this.syslog(`✗ Linear fetch error: ${fetchResult.error}`);
        await reportToDiscord(`⚠️ Linear fetch failed: ${fetchResult.error}`);
        return;
      }
      this.idle.beginSelection(); let tasks = await this.reconcileStalledInProgress(fetchResult.tasks); // from here an empty result counts (AGT-4607)
      await this.reconcileMergedPublications(tasks).catch((error) => {
        console.warn('[AutonomousRunner] Merge reconciliation failed:', error);
      });
      const trackerReconcile = await reconcileTrackerTerminalRuns({
        durableRuns: this.durableRuns,
        source: getTaskSource(),
        inScope: this.getDispatchScopePredicate(),
        knownTasks: tasks,
      });
      if (trackerReconcile.lookedUp > 0 || trackerReconcile.fromFetch > 0) {
        this.syslog(`✓ Tracker cache: ${trackerReconcile.fromFetch} bulk hit(s), ${trackerReconcile.lookedUp} explicit lookup(s), ${trackerReconcile.terminal} terminal ledger row(s) reconciled`);
      }
      const knownTaskIds = new Set<string>();
      const priorityDepIds = new Set<string>();
      for (const t of tasks) {
        if (t.issueId) knownTaskIds.add(t.issueId);
        if (t.id) knownTaskIds.add(t.id);
        for (const depId of t.blockedBy ?? []) priorityDepIds.add(depId);
        const cached = getTaskState(t.issueId || t.id);
        for (const depId of cached?.dependencyIssueIds ?? []) priorityDepIds.add(depId);
      }
      const depReconcile = await reconcileDependencyBlockers({
        source: getTaskSource(),
        knownTaskIds,
        priorityDepIds,
        releaseDependents: (depId) => releaseDependentsInTracker(getTaskSource(), depId), // AGT-4817: Todo in the tracker too
      });
      if (depReconcile.lookedUp > 0) {
        this.syslog(`✓ Dependency cache: ${depReconcile.lookedUp} explicit lookup(s), ${depReconcile.resolved} blocker(s) confirmed done, ${depReconcile.released} dependent task(s) released`);
      }
      if (this.stopping) return;
      if (tasks.length === 0) {
        this.syslog('— No tasks in backlog');
        return;
      }

      await this.migrateLegacyRunState(tasks);
      if (this.stopping) return;
      await this.reconcileMissingWorktreePointers();
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

      // Issues a person owns (a skip label, an epic, a title tag) never reach selection or
      // idle fill: the idle-fill loop inside filterAlreadyProcessed would otherwise lift a
      // parked or backed-off ledger row for them. (AGT-4682)
      // Readiness comes first and is the only thing in front of idle fill that reads the tracker
      // state: a Backlog issue must not reach `filterAlreadyProcessed`, whose idle fill would lift
      // a park on it. (AGT-4784)
      const skipConfig = this.config.skip ?? DEFAULT_AGENT_SKIP;
      const { ready: readyTasks, held: notReady } = await partitionByDefinitionOfReady(tasks, {
        exclusionLabels: skipConfig.labels, includeBacklog: this.config.includeBacklog ?? false, projectExclusionLabels: projectSkipLabelsHook(this.config.projectAgents, (t: TaskItem) => this.resolveProjectPath(t)),
        definitionOfReady: definitionOfReadyHooks(this.config.projectAgents, getTaskSource(), (t) => this.resolveProjectPath(t)), // AGT-4805
      });
      for (const line of formatReadinessSummary(notReady)) this.syslog(line);
      const { eligible: agentTasks, skipped: humanOwned } = partitionHumanOwned(readyTasks, skipConfig);
      for (const line of formatSkipSummary(humanOwned)) this.syslog(line);
      if (agentTasks.length === 0) {
        this.syslog('— Nothing ready for the swarm (Backlog, skip labels, epics, title tags)');
        return;
      }

      // Filter out completed and over-retried tasks
      const filteredTasks = this.filterAlreadyProcessed(agentTasks);
      if (filteredTasks.length === 0) {
        this.syslog('— All tasks already completed or max retries exceeded');
        return;
      }
      if (filteredTasks.length !== agentTasks.length) {
        this.syslog(`  Filtered: ${agentTasks.length} → ${filteredTasks.length} (skipped ${agentTasks.length - filteredTasks.length} completed/failed)`);
      }

      // Parallel processing mode. vela runs this branch on every heartbeat
      // (maxConcurrentTasks 12, pairMode true) — an early `return` here used to
      // skip everything below, including the retrospective lane (AGT-4181):
      // it was configured and deployed for 9+ hours (2026-09-02 20:26–
      // 2026-09-03 07:55) and never ran once, because vela never takes the
      // serial branch the lane's call sat in. `else` instead of `return` so
      // both branches reach the shared tail.
      if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1 && this.config.pairMode) {
        await this.heartbeatParallel(filteredTasks);
      } else {
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
      }
      this.state.consecutiveErrors = 0;

      await this.maybeRunLedgerRetrospective();

    } catch (error) {
      this.state.consecutiveErrors++;
      const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, '');
      console.error('[AutonomousRunner] Heartbeat error:', msg);
      this.syslog(`✗ Heartbeat error: ${msg}`);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(t('runner.consecutiveErrors', { count: this.state.consecutiveErrors, error: msg }));
      }
    } finally {
      this._heartbeatRunning = false; this.idle.endHeartbeat(() => this.scheduler.getStats());
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

    const maxSlots = dispatchBudget(this, this.config.dispatchRampClaims, availableSlots, this.config.heartbeatSchedule); // free slots, capped by the cold-start ramp

    // Pre-filter tasks to enabled projects only (before DecisionEngine selection)
    // This prevents DecisionEngine from wasting its max-slot budget on non-enabled projects.
    // AGT-4257: Backlog is a queue when slots are free. Terminal Linear
    // states are still dropped later by the decision engine.
    const executableTasks = (this.config.includeBacklog ?? false)
      ? tasks
      : tasks.filter(t => t.linearState !== 'Backlog');

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
        if (!safeTasks.has(task.id) || this.pauses.blocks(projectPath)) continue;
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
    recordDispatchClaims(this, enqueuedCount); // only claiming passes advance the cold-start ramp

    // Execute tasks
    if (!this.stopping) await this.runAvailableTasks();
  }

  // Candidate admission (resolveRunnableCandidates, holdDeclinedBeforeClaim,
  // detectSafeCandidateIds) lives in runnerCandidateAdmission.ts (AGT-4867). These
  // delegators keep the runner's names, which tests call and reassign; the moved
  // code calls back through the host, so a reassignment is honoured.
  private resolveRunnableCandidates(decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]> {
    return candidateAdmission.resolveRunnableCandidates(this.candidateAdmissionHost(), decisionTasks);
  }
  private holdDeclinedBeforeClaim(group: RunnableCandidate[], draftFailed: ReadonlySet<string>): Promise<RunnableCandidate[]> {
    return candidateAdmission.holdDeclinedBeforeClaim(this.candidateAdmissionHost(), group, draftFailed);
  }
  private detectSafeCandidateIds(candidates: RunnableCandidate[]): Promise<Set<string>> {
    return candidateAdmission.detectSafeCandidateIds(this.candidateAdmissionHost(), candidates);
  }

  private candidateAdmissionHostCache: CandidateAdmissionHost | undefined;
  /** Built once; every member reads the runner at call time (see CandidateAdmissionHost). */
  private candidateAdmissionHost(): CandidateAdmissionHost {
    if (this.candidateAdmissionHostCache) return this.candidateAdmissionHostCache;
    const runner = () => this;
    this.candidateAdmissionHostCache = {
      get stopping() { return runner().stopping; },
      get config() { return runner().config; },
      get scheduler() { return runner().scheduler; },
      get unresolvableIssueIds() { return runner().unresolvableIssueIds; },
      get projectPathCache() { return runner().projectPathCache; },
      get preAdmissionScopeCache() { return runner().preAdmissionScopeCache; },
      get unknownScopeDebt() { return runner().unknownScopeDebt; },
      syslog: (line) => this.syslog(line),
      resolveProjectPath: (task) => this.resolveProjectPath(task),
      shouldFilterByEnabled: () => this.shouldFilterByEnabled(),
      isProjectEnabled: (resolvedPath) => this.isProjectEnabled(resolvedPath),
      holdDeclinedBeforeClaim: (group, draftFailed) => this.holdDeclinedBeforeClaim(group, draftFailed),
      getExecCtx: () => this.getExecCtx(),
    };
    return this.candidateAdmissionHostCache;
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

  private enqueueCandidate(task: TaskItem, projectPath: string, availableAt?: number): boolean {
    this.attachPriorFeedback(task);
    if (!this.scheduler.enqueue(task, projectPath, { availableAt })) return false;
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
   * silently accepting the queue here would claim success for work that can
   * never start.
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
    // The distinction tells the caller whether another live scheduler entry
    // owns the task or the runner cannot accept it at all.
    const rejected: Array<{ id: string; reason: 'duplicate' | 'stopping' }> = [];
    for (const task of tasks) {
      if (this.stopping) {
        rejected.push({ id: task.id, reason: 'stopping' });
        continue;
      }
      // The heartbeat filter reopens a parked/terminal ledger row for an
      // explicitly dispatched task; this path skips that filter, so do the
      // same here or the coordinator fences the task as superseded.
      if (task.explicitDispatch === true && !this.readmitForExplicitDispatch(task)) {
        rejected.push({ id: task.id, reason: 'duplicate' });
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

  /**
   * Apply the operator's redispatch act to the durable row. False only for a
   * park that dispatching cannot end (an unanswered operator question).
   */
  private readmitForExplicitDispatch(task: TaskItem): boolean {
    if (!this.durableRuns.isPrimary) return true;
    const id = task.issueId || task.id;
    const decision = decideExplicitReadmission(this.durableRuns.getRun(id));
    const label = task.issueIdentifier || id;
    switch (decision.action) {
      case 'none': return true;
      case 'refuse':
        console.log(`[Scheduler] Explicit dispatch of ${label} refused: ${decision.reason}`);
        return false;
      case 'resume-needs-human': {
        const resumed = this.durableRuns.resumeNeedsHuman(id, Date.now(), 'explicit_dispatch');
        if (resumed) console.log(`[Scheduler] Explicit dispatch resumed ${label} from NEEDS_HUMAN (${resumed})`);
        // A dead external effect resumes through SYNC_PENDING; the heartbeat
        // drains it, not the scheduler, so make sure one is coming.
        if (resumed === 'SYNC_PENDING') this.scheduleNextHeartbeat();
        return resumed !== null;
      }
      case 'mark-ready': {
        const ready = this.durableRuns.markReady(id);
        if (ready) console.log(`[Scheduler] Explicit dispatch reopened ${label} as READY`);
        return ready;
      }
    }
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

    this.idle.markProgress(); console.log(`[AutonomousRunner] projectPath: ${projectPath}`); // a task starts: only now reset the idle streak

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
      result = await this.pauses.guardSerial(task.id, projectPath, (signal) => this.executeDurably(task, projectPath, signal)); // `now` pause reaches serial runs
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
      const resetsAt = globalRateLimit.hit(result.rateLimitResetsAt);
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
      // Was declared on ExecutionContext but never set — the drafter always ran
      // the adapter's built-in default, so a single-model fleet was impossible.
      draftModel: this.config.draftModel,
      pairMaxAttempts: this.config.pairMaxAttempts,
      enableDecomposition: this.config.enableDecomposition,
      decompositionThresholdMinutes: this.config.decompositionThresholdMinutes,
      decompositionMaxDepth: this.config.decomposition?.maxDepth ?? 2,
      decompositionMaxChildren: this.config.decomposition?.maxChildrenPerTask ?? 5,
      decompositionDailyLimit: this.config.decomposition?.dailyLimit ?? 20,
      decompositionAutoBacklog: this.config.decomposition?.autoBacklog ?? true,
      decomposeAfterFailures: this.config.decomposition?.decomposeAfterFailures ?? 3,
      getPriorFailures: (issueId) => this.failedTaskCounts.get(issueId) ?? 0,
      jobProfiles: this.config.jobProfiles,
      getRolesForProject: (p) => this.getRolesForProject(p),
      getProjectGoal: (p) => resolveProjectGoal(this.config.projectAgents, p),
      getProjectSetup: (p) => resolveOwningProject(this.config.projectAgents, p)?.setup,
      reportToDiscord,
      worktreeMode: this.config.worktreeMode ?? false,
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      guards: this.config.guards,
      verify: this.config.verify,
      securityAudit: this.config.securityAudit,
      maxReflections: this.config.maxReflections,
      loopAdvisor: this.config.loopAdvisor,
      advisorRole: this.config.defaultRoles?.advisor,
      durability,
      peerIssues: this.lastFetchedTasks,
      getActiveWorkerIssues: (p) => this.durableRuns.activeWorkerIdentifiers(p),
      mcpPolicies: this.config.mcpPolicies,
      adapterRouting: this.config.adapterRouting,
      workerSandbox: this.config.workerSandbox,
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
    this.idle.reset('runNow'); await this.heartbeat();
  }

  getState(): RunnerState {
    return { ...this.state };
  }

  getAllowedProjects(): string[] {
    return this.config.allowedProjects ?? [];
  }

  isProjectCoordinatorAvailable(repoKey: string): boolean {
    return this.orchestratorSupervisor !== null && this.state.isRunning
      && this.getBackgroundServiceProjects().some((path) => repositoryCell(path).repoKey === repoKey);
  }

  /**
   * The membership test dispatch applies to a resolved project path, for
   * scoping ledger metrics. Regime choice and rationale live in
   * `composeDispatchScope`; both gates are built here, bound over
   * `normalizePath` — taskScheduler's normalizeProjectPath, the same
   * realpath-inclusive space the ledger stores rows in — so neither can
   * drift from dispatch or from storage (AGT-4127; tier-2 review C1: a
   * resolve-only comparison counted every row under a symlinked configured
   * path as out of scope).
   */
  getDispatchScopePredicate(): ((projectPath: string) => boolean) | undefined {
    const allowed = (this.config.allowedProjects ?? []).map((p) => this.normalizePath(p));
    return composeDispatchScope(
      this.shouldFilterByEnabled(),
      (projectPath) => this.isProjectEnabled(projectPath),
      allowed.length > 0 ? (projectPath) => pathIsUnderAny(this.normalizePath(projectPath), allowed) : undefined,
    );
  }

  updateAllowedProjects(paths: string[]): void {
    this.config.allowedProjects = paths;
    this.engine.updateAllowedProjects(paths);
  }

  getRunStatus(issueId: string) {
    const run = this.durableRuns.getRun(issueId);
    return run ? { ...run, recovery: this.durableRuns.getRecoveryStatus(issueId) } : undefined;
  }

  getStats() {
    return { isRunning: this.state.isRunning, lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(), pendingApproval: !!this.state.pendingApproval,
      schedulerStats: this.scheduler.getStats(),
      automationLedger: this.durableRuns.getMetrics(Date.now(), this.getDispatchScopePredicate()),
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
    const projects = this.getBackgroundServiceProjects();
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
    const config = resolveOrchestratorConfig(this.config);
    if (!config?.enabled) return;

    const trackerSource = getTaskSource();
    const getCachedIssue = (issueIdOrIdentifier: string) => {
      const requested = issueIdOrIdentifier.toLowerCase();
      const task = this.lastFetchedTasks.find((candidate) =>
        candidate.issueId?.toLowerCase() === requested
        || candidate.issueIdentifier?.toLowerCase() === requested
        || candidate.id.toLowerCase() === requested);
      const issueId = task?.issueId ?? task?.id;
      if (!task || !issueId) return undefined;
      return {
        issueId,
        identifier: task.issueIdentifier ?? issueId,
        title: task.title,
        state: task.linearState,
        priority: task.priority,
        blockedBy: task.blockedBy,
      };
    };
    const tracker = trackerSource ? {
      getCachedIssue,
      resolveIssue: async (issueIdOrIdentifier: string) => {
        const cached = getCachedIssue(issueIdOrIdentifier);
        if (cached) return { issueId: cached.issueId, identifier: cached.identifier, source: 'cache' as const };
        if (!trackerSource.resolveIssue) return null;
        const resolved = await trackerSource.resolveIssue(issueIdOrIdentifier);
        if (!resolved.ok) throw new Error(`Tracker issue lookup failed: ${resolved.error}`);
        return resolved.issue ? {
          issueId: resolved.issue.id,
          identifier: resolved.issue.identifier,
          source: 'tracker' as const,
        } : null;
      },
      addComment: (issueId: string, body: string, idempotencyKey: string) =>
        trackerSource.addComment(issueId, body, idempotencyKey),
    } : undefined;

    const supervisor = new OrchestratorSupervisor({
      config,
      policy: this.config.mcpPolicies?.orchestrator,
      getRepositories: () => this.getBackgroundServiceProjects(),
      buildInstructionCapsule,
      tracker,
    });
    try {
      supervisor.start();
      this.orchestratorSupervisor = supervisor;
      console.log(
        `[Orchestrator] supervisor enabled (${config.eventDriven ? 'events' : 'cron-only'}`
        + `${config.schedule ? `, ${config.schedule}` : ''}; ${config.adapter ?? 'daemon-default'}/${config.model ?? 'adapter-default'})`,
      );
    } catch (error) {
      // A bad optional schedule must not tear down the worker heartbeat after it
      // has already started. No listener was registered if Cron construction failed.
      console.error('[Orchestrator] supervisor disabled: invalid lifecycle configuration:', error);
      void supervisor.stop();
    }
  }

  getCoordinationConfig() {
    return {
      boardIssueId: this.config.coordinationBoardIssueId,
      routing: this.config.adapterRouting,
      mcpPolicies: this.config.mcpPolicies,
      adapterRouting: this.config.adapterRouting,
      periodicReviews: this.config.periodicReviews ?? [],
      orchestrator: resolveOrchestratorConfig(this.config),
      orchestratorSchedule: this.config.orchestratorSchedule,
    };
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
    const mapModelForProvider = (model: string | undefined, role?: ModelRole): string | undefined =>
      mapModelForAdapter(adapter, model, role);

    this.config.defaultAdapter = adapter;

    if (this.config.defaultRoles) {
      // The role NAME travels with the model. Without it every entry here
      // mapped anonymously, so an adapter that resolves per role — cursor, whose
      // catalogue shares no id with any other provider — could not tell the
      // worker from the reviewer and gave both the same model. That is the role
      // split going missing at the one call site whose entire job is to preserve
      // it. (AGT-4273)
      const roleConfig = <T extends { adapter?: AdapterName; model?: string }>(role: T, roleName: ModelRole): T => {
        if (!overrideRoleAdapters && role.adapter) return role;
        return {
          ...role,
          adapter,
          model: mapModelForProvider(role.model, roleName),
        };
      };
      this.config.defaultRoles.worker = {
        ...roleConfig(this.config.defaultRoles.worker, 'worker'),
      };
      this.config.defaultRoles.reviewer = {
        ...roleConfig(this.config.defaultRoles.reviewer, 'reviewer'),
      };

      if (this.config.defaultRoles.tester) {
        this.config.defaultRoles.tester = {
          ...roleConfig(this.config.defaultRoles.tester, 'tester'),
        };
      }
      if (this.config.defaultRoles.documenter) {
        this.config.defaultRoles.documenter = {
          ...roleConfig(this.config.defaultRoles.documenter, 'documenter'),
        };
      }
      if (this.config.defaultRoles.auditor) {
        this.config.defaultRoles.auditor = {
          ...roleConfig(this.config.defaultRoles.auditor, 'auditor'),
        };
      }
      if (this.config.defaultRoles['skill-documenter']) {
        this.config.defaultRoles['skill-documenter'] = {
          ...roleConfig(this.config.defaultRoles['skill-documenter'], 'skill-documenter'),
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

  /**
   * Why this runner may not be switched to `adapter`, or null. A delegated CLI owns its tool loop,
   * so the fences the daemon refused to start without (AGT-4444) would not reach it; the operator's
   * `allowDelegatedAdapters` is the only way past. Callers that take the adapter from outside the
   * process (the dashboard toggle, `openswarm provider`) ask this before `switchProvider`.
   */
  providerSwitchViolation(adapter: AdapterName): string | null {
    return providerSwitchViolation(adapter, this.config.allowDelegatedAdapters) ?? providerSwitchFamilyViolation(adapter); // nor same-family review (#886)
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
  /** Branch refs currently protected by live durable worker leases. */
  getActiveIntegrationBranches(projectPath: string): string[] | undefined {
    return this.durableRuns.activeWorkerBranches(projectPath);
  }
  getActiveIntegrationIssues(projectPath: string): string[] | undefined {
    return this.durableRuns.activeWorkerIdentifiers(projectPath);
  }
  withIntegrationReservation(
    projectPath: string,
    branch: string,
    issueIdentifier: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    return this.durableRuns.withIntegrationReservation(projectPath, branch, issueIdentifier, operation);
  }

  /**
   * Return a conflicted sibling PR to its owning issue with replay evidence.
   * The coordinator already checks the lease; the ledger repeats that fence
   * while atomically queuing the tracker effect and SYNC_PENDING transition.
   */
  async routeIntegrationConflict(evidence: IntegrationConflictEvidence): Promise<void> {
    const run = this.durableRuns.listRuns().find((candidate) =>
      candidate.identifier === evidence.issueIdentifier
      && candidate.branchName === evidence.branch);
    if (!run) {
      throw new Error(`No durable run owns ${evidence.issueIdentifier} branch ${evidence.branch}`);
    }
    const activeBranches = this.durableRuns.activeWorkerBranches(run.projectPath);
    const activeIssues = this.durableRuns.activeWorkerIdentifiers(run.projectPath);
    if (activeBranches === undefined || activeIssues === undefined) {
      throw new Error('Durable lease state is unavailable');
    }
    if (activeBranches.includes(evidence.branch) || activeIssues.includes(evidence.issueIdentifier)) {
      throw new Error(`Branch ${evidence.branch} acquired an active worker lease`);
    }
    const evidenceBody = JSON.stringify({
      mergedPR: evidence.mergedPRNumber,
      mergedBranch: evidence.mergedBranch,
      mergeCommit: evidence.mergeCommitOid,
      baseBranch: evidence.baseBranch,
      baseOid: evidence.baseOid,
      expectedHeadOid: evidence.expectedHeadOid,
      conflictFiles: evidence.conflictFiles,
    }, null, 2);
    const idempotencyKey = `integration-conflict:${evidence.repo}#${evidence.prNumber}@${evidence.mergeCommitOid}`;
    const effect = buildIntegrationRequeueEffect(
      run.issueId,
      idempotencyKey,
      `Post-merge integration found a rebase conflict in PR #${evidence.prNumber}. `
        + `The owning run is queued for retry.\n\n\`\`\`json\n${evidenceBody}\n\`\`\``,
    );
    if (!this.durableRuns.queueIntegrationRequeue(run.issueId, run.stateVersion, effect)) {
      const current = this.durableRuns.getRun(run.issueId);
      throw new Error(`Refusing to reactivate ${evidence.issueIdentifier} from ${current?.state ?? 'missing'}`);
    }
    // Delivery may fail transiently; the durable SYNC_PENDING row and outbox
    // effect remain authoritative and every normal heartbeat retries them.
    await this.drainDurableOutbox();
  }
  getFailureCauseSummary(limit = 50) { return aggregateFailureCauses(getPipelineHistory(limit)); }

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

/** Per-iteration wall clock of every enabled stage except the worker (AGT-4430). */
function enabledStageTimeoutsMs(
  roles?: import('../core/types.js').DefaultRolesConfig,
  verify?: import('../core/types.js').VerifyConfig,
): number {
  const stages: Array<'reviewer' | 'tester' | 'documenter'> = [];
  if (roles?.reviewer?.enabled !== false) stages.push('reviewer');
  if (roles?.tester?.enabled || verify?.enabled) stages.push('tester');
  if (roles?.documenter?.enabled) stages.push('documenter');
  return stages.reduce((total, stage) => total + stageTimeoutMs(stage, roles?.[stage]?.timeoutMs), 0);
}
