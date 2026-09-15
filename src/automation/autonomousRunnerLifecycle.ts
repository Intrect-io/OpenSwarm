import { Cron } from 'croner';
import { TaskItem } from '../orchestration/decisionEngine.js';
import { resolveOrchestratorConfig } from '../coordination/orchestratorConfig.js';
import { OrchestratorSupervisor } from '../coordination/orchestratorSupervisor.js';
// ExecutorResult used via execution.reportExecutionResult
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { reportToDiscord, fetchLinearTasks, getTaskSource } from './runnerExecution.js';
import { runLedgerRetrospective } from './ledgerRetrospective.js';
import { t } from '../locale/index.js';
import { broadcastEvent, type SwarmStats } from '../core/eventHub.js';
import { getTaskState, updateTaskLinearState } from '../taskState/store.js';
import { pruneWorktrees } from '../support/worktreeManager.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { startEventLoopMonitor } from '../support/eventLoopMonitor.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { scanRepository } from '../registry/entityScanner.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AutonomousConfig } from './runnerTypes.js';
import {
  applyBacklogGrooming,
  filterGroomableTasks,
  runBacklogGroomingPlanner,
  summarizeGroomingDecision,
} from './backlogGrooming.js';
import { reconcileTrackerTerminalRuns } from './trackerTerminalReconciler.js';
import { planStalledInProgress } from './stalledInProgress.js';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import {
  isExplicitAdmissionRetry,
  planExplicitDeferredRecovery,
} from './explicitDispatchRecovery.js';
import { buildInstructionCapsule } from '../agents/instructionCapsule.js';
import { AutonomousRunnerCore } from './autonomousRunnerCore.js';
import { AutonomousRunnerExecution } from './autonomousRunnerExecution.js';
export abstract class AutonomousRunnerLifecycle extends AutonomousRunnerExecution {
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
  protected async startAfterMonitor(): Promise<void> {
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
  protected async recoverParkedRunsOnly(): Promise<void> {
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

  protected async performStop(): Promise<void> {
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

  protected async drainRunnerActivity(heartbeat: Promise<void> | null): Promise<void> {
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

  protected async waitForRunnerActivity(heartbeat: Promise<void> | null, graceMs: number): Promise<boolean> {
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

  protected async finalizeStoppedResources(): Promise<void> {
    if (this.durableRunsClosed) return;
    await this.drainDurableOutbox().catch((error) =>
      console.warn('[AutonomousRunner] Final outbox drain failed:', error));
    this.durableRuns.close();
    this.durableRunsClosed = true;
  }

  protected buildStats(): SwarmStats {
    const stats = this.scheduler.getStats();
    return {
      runningTasks: stats.running,
      queuedTasks: stats.queued,
      completedToday: stats.completed,
      uptime: this.state.startedAt ? Date.now() - this.state.startedAt : 0,
      schedulerPaused: this.scheduler.isPaused(),
    };
  }


  protected refreshKnowledgeGraphs(): void {
    for (const projectPath of this.config.allowedProjects) {
      const resolvedPath = normalizeProjectPath(projectPath);
      // Coalesce concurrent heartbeats: one in-flight refresh per project.
      if (this.kgRefreshByPath.has(resolvedPath)) continue;

      const flight = refreshGraph(resolvedPath).then(graph => {
        if (graph) {
          const slug = toProjectSlug(resolvedPath);
          broadcastEvent({
            type: 'knowledge:updated',
            data: { projectSlug: slug, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount },
          });
        }
        return graph;
      }).catch((e) => {
        console.error(`[AutonomousRunner] Knowledge graph refresh failed for ${resolvedPath}:`, e);
        return null;
      }).finally(() => {
        if (this.kgRefreshByPath.get(resolvedPath) === flight) {
          this.kgRefreshByPath.delete(resolvedPath);
        }
      });

      this.kgRefreshByPath.set(resolvedPath, flight);
    }
  }

  /**
   * Keep the code-entity registry fresh for Draft File Map / registryCheck.
   * Throttled to once per 6h per project so heartbeats stay cheap; a missing
   * or empty scan still runs immediately (measured: Draft logged "0 entities"
   * for months while ~/.openswarm/registry.db sat stale since 2026-07-05).
   */

  protected refreshCodeRegistries(): void {
    for (const projectPath of this.config.allowedProjects) {
      const resolvedPath = normalizeProjectPath(projectPath);
      const last = this.registryScanAt.get(resolvedPath) ?? 0;
      if (Date.now() - last < AutonomousRunnerCore.REGISTRY_SCAN_INTERVAL_MS) continue;
      if (!existsSync(join(resolvedPath, '.git'))) continue;

      const projectId = this.resolveRegistryProjectId(resolvedPath);
      this.registryScanAt.set(resolvedPath, Date.now());
      void scanRepository(resolvedPath, projectId, { timeoutMs: 180_000 })
        .then((result) => {
          this.syslog(
            `Registry scan ${projectId}: ${result.extracted} entities `
            + `(+${result.registered}/~${result.updated}) in ${result.durationMs}ms`,
          );
        })
        .catch((e) => {
          console.error(`[AutonomousRunner] Registry scan failed for ${resolvedPath}:`, e);
          this.registryScanAt.delete(resolvedPath);
        });
    }
  }

  protected resolveRegistryProjectId(projectPath: string): string {
    const normalized = projectPath.replace(/\/+$/, '');
    const wt = normalized.match(/^(.*)\/worktree\/[^/]+$/);
    const repoRoot = wt ? wt[1] : normalized;
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name) return pkg.name.replace(/^@[^/]+\//, '');
    } catch { /* basename fallback */ }
    return repoRoot.split('/').pop() ?? repoRoot;
  }


  /** Send system message to dashboard LIVE LOG */
  protected syslog(line: string): void {
    const safeLine = line.replace(/[\r\n]/g, '');
    console.log(`[HB] ${safeLine}`);
    broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'heartbeat', line: safeLine } });
  }



  /**
   * Log unmapped/disabled project skips as one aggregate line per category,
   * and stay silent while the summary is identical to the previous heartbeat.
   */
  /**
   * The retrospective lane (AGT-4181): the runner reads its own ledger and
   * files one evidence-rich issue on the largest failure bucket, so the
   * systemic fixes an operator would derive from the same queries happen
   * without one. Isolated — a lane failure must not fail the heartbeat.
   */
  protected async maybeRunLedgerRetrospective(): Promise<void> {
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

  protected syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void {
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

  protected async groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> {
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

  protected async maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]> {
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

  /**
   * Keep Linear's In Progress column honest: it represents a scheduler-owned
   * task or a live durable lease, never an abandoned claim. The bulk heartbeat
   * fetch already carries updatedAt, so the sweep adds no read-side API calls.
   */
  protected async reconcileStalledInProgress(tasks: TaskItem[], now = Date.now()): Promise<TaskItem[]> {
    const source = getTaskSource();
    if (source?.kind !== 'linear') return tasks;

    const staleAfterMs = (this.config.stalledInProgressHours ?? 6) * 60 * 60_000;
    const candidates = planStalledInProgress(tasks, {
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
      const accepted = await source.updateState(issueId, targetState).catch((error) => {
        console.warn(`[AutonomousRunner] Failed to retire stalled ${task.issueIdentifier ?? issueId}:`, error);
        return false;
      });
      if (!accepted) {
        console.warn(`[AutonomousRunner] Tracker refused stale-state repair for ${task.issueIdentifier ?? issueId}`);
        continue;
      }
      task.linearState = targetState;
      updateTaskLinearState(issueId, targetState);
      moved++;
      this.syslog(`↩ ${task.issueIdentifier ?? issueId}: stale In Progress → ${targetState}`);
    }
    if (moved > 0) this.syslog(`✓ Retired ${moved} stalled In Progress issue(s)`);
    return tasks;
  }


  protected startPeriodicReviews(): void {
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

  protected async runPeriodicReviewAcrossProjects(review: NonNullable<AutonomousConfig['periodicReviews']>[number]): Promise<void> {
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

  protected startOrchestrator(): void {
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


}
