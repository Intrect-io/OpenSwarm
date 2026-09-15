import { getDailyPaceInfo } from './runnerState.js';
import { taskEventKey, DecisionResult, TaskItem, composeDispatchScope, pathIsUnderAny } from '../orchestration/decisionEngine.js';
// ExecutorResult used via execution.reportExecutionResult
import { checkWorkAllowed } from '../support/timeWindow.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import * as execution from './runnerExecution.js';
import { pruneDraftCache } from './draftCache.js';
import { reportToDiscord, fetchLinearTasks, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { decideExplicitReadmission } from './explicitDispatchReadmission.js';
import { broadcastEvent } from '../core/eventHub.js';
import { getTaskState, reconcileDependencyBlockers } from '../taskState/store.js';
import { setAutomationDbPath } from './automationDbPath.js';
import { pruneWorktrees } from '../support/worktreeManager.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
import { buildIntegrationRequeueEffect } from './trackerEffects.js';
import { reconcileTrackerTerminalRuns } from './trackerTerminalReconciler.js';
import type { IntegrationConflictEvidence } from './integrationCoordinator.js';
import { AutonomousRunnerLifecycle } from './autonomousRunnerLifecycle.js';
import { decisionSelectionBudget } from './runnerHelpers.js';
let runnerInstance: AutonomousRunner | null = null;

export class AutonomousRunner extends AutonomousRunnerLifecycle {
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
    // Swept here rather than on read: a read only knows the one row it asked
    // for, so without this the table keeps every task the daemon ever drafted.
    const pruned = pruneDraftCache();
    if (pruned > 0) this.syslog(`  Pruned ${pruned} expired draft cache entr${pruned === 1 ? 'y' : 'ies'}`);

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

      // 2. Fetch tasks from Linear
      this.syslog('⟳ Fetching tasks from Linear...');
      const fetchResult = await fetchLinearTasks();
      if (this.stopping) return;
      if (fetchResult.error) {
        this.syslog(`✗ Linear fetch error: ${fetchResult.error}`);
        await reportToDiscord(`⚠️ Linear fetch failed: ${fetchResult.error}`);
        return;
      }
      let tasks = await this.reconcileStalledInProgress(fetchResult.tasks);
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
      this._heartbeatRunning = false;
      if (this.heartbeatCompletion === completion) this.heartbeatCompletion = null;
      settleHeartbeat();
    }
  }


  protected async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
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
    // AGT-4257: Backlog is a queue when slots are free. Terminal Linear
    // states are still dropped later by the decision engine.
    const executableTasks = (this.config.includeBacklog ?? true)
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


  protected attachPriorFeedback(task: TaskItem): void {
    if (!task.issueId) return;
    const prior = this.lastFailureDetails.get(task.issueId);
    if (prior) task.priorAttemptFeedback = prior.detail;
  }

  protected enqueueCandidate(task: TaskItem, projectPath: string, availableAt?: number): boolean {
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
  protected readmitForExplicitDispatch(task: TaskItem): boolean {
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
        const resumed = this.durableRuns.resumeNeedsHuman(id);
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

  protected async requestApproval(decision: DecisionResult): Promise<void> {
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

  getStats() {
    return { isRunning: this.state.isRunning, lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(), pendingApproval: !!this.state.pendingApproval,
      schedulerStats: this.scheduler.getStats(),
      automationLedger: this.durableRuns.getMetrics(Date.now(), this.getDispatchScopePredicate()),
      dailyPace: getDailyPaceInfo(),
    };
  }


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

export { pickPipelineFailureDetail } from './runnerState.js';
export { setNotifier, setTaskSource } from './runnerExecution.js';
export type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export type { ProjectInfo } from './runnerState.js';

export {
  effectiveProjectConcurrency,
  worktreeFanoutEnabled,
  failClosedConflictFallback,
  decisionSelectionBudget,
  parkRunForHuman,
} from './runnerHelpers.js';
export type { RunnableCandidate } from './runnerHelpers.js';
