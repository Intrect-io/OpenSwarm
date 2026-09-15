import { Cron } from 'croner';
import { loadTaskState, saveTaskState, buildProjectsInfo, appendPipelineHistory, getPipelineHistory, aggregateFailureCauses, classifyFailureCause, clearRetryTime, loadProjectSelection, saveProjectSelection, type LastFailureEntry, type TaskState, type ProjectInfo } from './runnerState.js';
import { DecisionEngine, TaskItem, getDecisionEngine } from '../orchestration/decisionEngine.js';
import { getCoordinationStore } from '../coordination/coordinationStore.js';
import { OrchestratorSupervisor } from '../coordination/orchestratorSupervisor.js';
import { OPERATOR_PARK_REASON, shouldReadmitEarly } from '../coordination/operatorAnswers.js';
// ExecutorResult used via execution.reportExecutionResult
import { TaskScheduler, initScheduler, normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { PipelineResult } from '../agents/pairPipeline.js';
import type { DefaultRolesConfig } from '../core/types.js';
import * as execution from './runnerExecution.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import { getTaskState } from '../taskState/store.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
import type { AdapterName } from '../adapters/types.js';
import { mapModelForProvider as mapModelForAdapter } from '../adapters/modelCompat.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import { DurableRunCoordinator, type ExecutionDurabilityHooks } from './durableRunCoordinator.js';
import type { RunLedgerMode } from './runLedger.js';
import { effectiveProjectConcurrency, CachedDraftScope } from './runnerHelpers.js';
export abstract class AutonomousRunnerCore {
  protected config: AutonomousConfig;
  protected engine: DecisionEngine;
  protected scheduler: TaskScheduler;
  protected readonly durableRuns: DurableRunCoordinator;
  protected outboxDrain: Promise<void> | null = null;
  protected readonly schedulerHandlers = new Set<Promise<void>>();
  /** Adapter default-model cache for the dashboard PAIR bar (INT-2393). */
  protected defaultModelCache = new Map<string, Promise<string | undefined>>();
  /** Unknown write scopes deferred by a known-first wave, repaid one at a time. */
  protected unknownScopeDebt = new Set<string>();
  /** Sufficient drafted scopes survive heartbeat refetches and feed the pipeline. */
  protected preAdmissionScopeCache = new Map<string, CachedDraftScope>();
  protected cronJob: Cron | null = null;
  protected periodicReviewJobs: Cron[] = [];
  protected orchestratorSupervisor: OrchestratorSupervisor | null = null;
  protected startupHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  protected stopping = false;
  protected state: RunnerState = {
    isRunning: false,
    lastHeartbeat: 0,
    consecutiveErrors: 0,
  };

  // Heartbeat concurrency guard
  protected _heartbeatRunning = false;
  protected heartbeatCompletion: Promise<void> | null = null;
  protected stopPromise: Promise<void> | null = null;
  protected stopEventLoopMonitor: (() => void) | null = null;
  protected deferredShutdownCleanup: Promise<void> | null = null;
  protected durableRunsClosed = false;

  // Explicitly enabled project paths (allow-list; empty = nothing runs ONLY once
  // the selection has been touched — see projectSelectionTouched).
  protected enabledProjects = new Set<string>();

  // Whether the user has explicitly enabled/disabled any project (dashboard/CLI).
  // Before this, an empty enabledProjects means "no selection yet → all allowed
  // projects run" (legacy fallback). After, an empty set means "nothing runs" —
  // so disabling every project actually stops the daemon. (INT-2207)
  protected projectSelectionTouched = false;

  /**
   * macOS (APFS default) and Windows have case-insensitive filesystems by
   * default, so `/Users/x/dev/AnalogModeling` and `/Users/x/dev/analogModeling`
   * refer to the same directory. Do the enabled-set comparison in a case-
   * insensitive way on those platforms so UI-captured casing doesn't
   * mismatch Linear's project-name casing.
   */

  protected abstract setupSchedulerEvents(): void;
  protected abstract scheduleNextHeartbeat(): void;
  protected abstract runAvailableTasks(): Promise<void>;
  protected abstract drainDurableOutbox(): Promise<void>;
  protected abstract getExecCtx(durability?: ExecutionDurabilityHooks): execution.ExecutionContext;
  protected abstract resolveProjectPath(task: TaskItem): Promise<string | null>;
  protected abstract attachPriorFeedback(task: TaskItem): void;
  protected abstract enqueueCandidate(task: TaskItem, projectPath: string, availableAt?: number): boolean;
  protected abstract syslog(line: string): void;
  protected abstract startOrchestrator(): void;
  public abstract heartbeat(): Promise<void>;
  public abstract getAllowedProjects(): string[];
  public abstract updateAllowedProjects(paths: string[]): void;
  public abstract getDispatchScopePredicate(): ((projectPath: string) => boolean) | undefined;

  protected get pathsCaseInsensitive(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  protected normalizePath(p: string): string {
    const canonical = normalizeProjectPath(p);
    return this.pathsCaseInsensitive ? canonical.toLowerCase() : canonical;
  }

  /** Check if a resolved path is under any enabled project */
  protected isProjectEnabled(resolvedPath: string): boolean {
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
  protected shouldFilterByEnabled(): boolean {
    return this.projectSelectionTouched || this.enabledProjects.size > 0;
  }

  /**
   * Repositories that background services may touch. Once the operator has
   * touched project selection, an empty enabled set means exactly zero — never
   * fall back to every allowed repository behind the UI's back.
   */
  protected getBackgroundServiceProjects(): string[] {
    return this.shouldFilterByEnabled() ? this.getEnabledProjects() : this.getAllowedProjects();
  }

  protected sameProjectCandidateCap(): number | null {
    const sameProjectParallel = (this.config.allowSameProjectConcurrent ?? true) && (this.config.worktreeMode ?? false);
    return sameProjectParallel ? effectiveProjectConcurrency(this.config) : null;
  }

  protected currentProjectLoad(projectPath: string): number {
    const target = normalizeProjectPath(projectPath);
    const queued = this.scheduler.getQueuedTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    const running = this.scheduler.getRunningTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    return queued + running;
  }

  protected canQueueProjectCandidate(projectPath: string): boolean {
    const cap = this.sameProjectCandidateCap();
    if (cap == null) return true;
    return this.currentProjectLoad(projectPath) < cap;
  }

  /** Persist the project selection so it survives a restart. No-op under dryRun
   * (tests) to avoid touching the real ~/.openswarm. (INT-2208) */
  protected persistSelection(): void {
    if (this.config.dryRun) return;
    saveProjectSelection({ enabled: [...this.enabledProjects], touched: this.projectSelectionTouched });
  }

  // Last fetched Linear tasks (for dashboard display)

  protected lastFetchedTasks: TaskItem[] = [];

  // Cache: linearProjectName → resolvedLocalPath (populated during task execution)
  protected projectPathCache = new Map<string, string>();

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  protected completedTaskIds = new Set<string>();
  protected failedTaskCounts = new Map<string, number>();
  protected failedTaskRetryTimes = new Map<string, number>(); // issueId → next retry timestamp (ms)
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
  protected consecutiveInfraErrorCounts = new Map<string, number>();

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

  protected readmitAnsweredRun(issueId: string): boolean {
    if (!this.answerArrivedFor(issueId)) return false;
    if (!this.durableRuns.readmitParkedRun(issueId, OPERATOR_PARK_REASON)) return false;
    clearRetryTime(issueId, this.failedTaskRetryTimes);
    this.consecutiveInfraErrorCounts.delete(issueId);
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
  protected parkedOnOperator(issueId: string): boolean {
    const durableRun = this.durableRuns.getRun(issueId);
    if (this.durableRuns.isPrimary && durableRun) {
      return durableRun.lastErrorCode === OPERATOR_PARK_REASON;
    }
    return getTaskState(issueId)?.execution?.blockedReason === OPERATOR_PARK_REASON;
  }

  protected answerArrivedFor(issueId: string): boolean {
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

  protected lastFailureDetails = new Map<string, LastFailureEntry>();
  protected static readonly MAX_RETRY_COUNT = 4; // Increased from 2 to allow more retries with backoff
  // Consecutive infra_error attempts (same issue, no intervening non-infra
  // outcome) allowed to bypass backoff via idle-fill before the real 1h
  // backoff is enforced instead. (AGT-4305)
  protected static readonly MAX_CONSECUTIVE_INFRA_IDLE_FILL = 3;

  // Rate-limit hold: epoch ms until which all task execution is paused.
  // Set when any adapter returns a 429 / usage_limit_reached response (INT-1906).
  protected rateLimitUntil = 0;

  // Issues whose Linear project can't be mapped to a local repo path. Recorded on
  // the first resolve failure so they aren't re-picked every heartbeat (which
  // starved other actionable tasks — they were top-priority but never runnable). (INT-1875)
  protected unresolvableIssueIds = new Set<string>();
  protected lastBacklogGroomingAt = 0;


  protected _nextHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly kgRefreshByPath = new Map<string, Promise<unknown>>();


  protected readonly registryScanAt = new Map<string, number>();
  protected static readonly REGISTRY_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

  protected lastSkipSummary = '';

  protected get taskStateRef(): TaskState {
    return {
      completedTaskIds: this.completedTaskIds,
      failedTaskCounts: this.failedTaskCounts,
      failedTaskRetryTimes: this.failedTaskRetryTimes,
      lastFailureDetails: this.lastFailureDetails,
    };
  }

  protected loadTaskState(): void {
    loadTaskState(this.taskStateRef);
  }

  protected saveTaskState(): void {
    saveTaskState(this.taskStateRef);
  }

  protected formatTaskContext(task: TaskItem): string {
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
      includeBacklog: config.includeBacklog ?? true,
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
    this.setupSchedulerEvents();
  }


  protected getRolesForProject(projectPath: string): DefaultRolesConfig | undefined {
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

  protected applyProviderConfig(adapter: AdapterName, overrideRoleAdapters = true): void {
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

    // The supervisor is a role too. Leaving `autonomous.orchestrator.adapter`
    // pinned (e.g. codex-responses) while switchProvider remapped only
    // worker/reviewer meant the daemon ran OpenRouter workers under a Codex
    // supervisor that then died on the 10080min ChatGPT quota window
    // (AGT-4259). Remap it on the same path — and restart the live supervisor
    // in switchProvider so the new adapter actually takes effect.
    if (this.config.orchestrator) {
      if (overrideRoleAdapters || !this.config.orchestrator.adapter) {
        this.config.orchestrator = {
          ...this.config.orchestrator,
          adapter,
          model: mapModelForProvider(this.config.orchestrator.model, 'orchestrator'),
        };
      }
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
    const previousOrchestratorAdapter = this.config.orchestrator?.adapter;
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

    // Restart a live supervisor when its adapter changed. applyProviderConfig
    // already remapped config.orchestrator; without a restart the old Codex
    // (or whatever) process keeps burning the wrong quota (AGT-4259).
    const nextOrchestratorAdapter = this.config.orchestrator?.adapter;
    if (
      this.orchestratorSupervisor
      && previousOrchestratorAdapter !== nextOrchestratorAdapter
    ) {
      const previous = this.orchestratorSupervisor;
      this.orchestratorSupervisor = null;
      void previous.stop()
        .catch((err) => {
          console.error('[Orchestrator] stop after provider switch failed:', err);
        })
        .finally(() => {
          this.startOrchestrator();
        });
    }
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

  getFailureCauseSummary(limit = 50) { return aggregateFailureCauses(getPipelineHistory(limit)); }

  protected recordPipelineHistory(task: TaskItem, result: PipelineResult): void {
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
