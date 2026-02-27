// OpenSwarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
import { Cron } from 'croner';
import { loadTaskState, saveTaskState, buildProjectsInfo, appendPipelineHistory, getPipelineHistory, getRejectionCount, incrementRejection, clearRejection, isRejectionLimitReached, type TaskState, type ProjectInfo, type PipelineHistoryEntry } from './runnerState.js';
import {
  DecisionEngine,
  DecisionResult,
  TaskItem,
  getDecisionEngine,
} from '../orchestration/decisionEngine.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import { checkWorkAllowed } from '../support/timeWindow.js';
import { formatParsedTaskSummary, loadParsedTask } from '../orchestration/taskParser.js';
import { saveCognitiveMemory } from '../memory/index.js';
import { EmbedBuilder } from 'discord.js';
import * as linear from '../linear/index.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { TaskScheduler, initScheduler } from '../orchestration/taskScheduler.js';
import {
  PipelineResult,
  formatPipelineResult,
  formatPipelineResultEmbed,
} from '../agents/pairPipeline.js';
import type { DefaultRolesConfig, ProjectAgentConfig } from '../core/types.js';
import * as planner from '../support/planner.js';
import * as execution from './runnerExecution.js';
import { reportToDiscord, fetchLinearTasks } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { broadcastEvent, type SwarmStats } from '../core/eventHub.js';
import { pruneWorktrees } from '../support/worktreeManager.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';

// Re-export integration setters (used by service.ts)
export { setDiscordReporter, setLinearFetcher } from './runnerExecution.js';

export interface AutonomousConfig {
  linearTeamId: string;
  allowedProjects: string[];
  heartbeatSchedule: string;
  autoExecute: boolean;
  discordChannelId?: string;
  maxConsecutiveTasks: number;
  cooldownSeconds: number;
  dryRun: boolean;
  pairMode?: boolean;
  pairMaxAttempts?: number;
  workerModel?: string;
  reviewerModel?: string;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  triggerNow?: boolean;
  maxConcurrentTasks?: number;
  defaultRoles?: DefaultRolesConfig;
  projectAgents?: ProjectAgentConfig[];
  enableDecomposition?: boolean;
  decompositionThresholdMinutes?: number;
  plannerModel?: string;
  plannerTimeoutMs?: number;
  worktreeMode?: boolean;
}

export type { ProjectInfo } from './runnerState.js';

export interface RunnerState {
  isRunning: boolean;
  lastHeartbeat: number;
  lastDecision?: DecisionResult;
  lastExecution?: ExecutorResult;
  pendingApproval?: TaskItem;
  consecutiveErrors: number;
  startedAt?: number;
}

let runnerInstance: AutonomousRunner | null = null;

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
  private scheduler: TaskScheduler;
  private cronJob: Cron | null = null;
  private state: RunnerState = {
    isRunning: false,
    lastHeartbeat: 0,
    consecutiveErrors: 0,
  };

  // Heartbeat concurrency guard
  private _heartbeatRunning = false;

  // Explicitly enabled project paths (allow-list; empty = nothing runs)
  private enabledProjects = new Set<string>();

  /** Check if a resolved path is under any enabled project */
  private isProjectEnabled(resolvedPath: string): boolean {
    if (this.enabledProjects.size === 0) return false;
    if (this.enabledProjects.has(resolvedPath)) return true;
    // Check if resolvedPath is a subdirectory of any enabled project
    for (const enabled of this.enabledProjects) {
      if (resolvedPath.startsWith(enabled + '/')) return true;
    }
    return false;
  }

  // Last fetched Linear tasks (for dashboard display)
  private lastFetchedTasks: TaskItem[] = [];

  // Cache: linearProjectName → resolvedLocalPath (populated during task execution)
  private projectPathCache = new Map<string, string>();

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private static readonly MAX_RETRY_COUNT = 2;


  private get taskStateRef(): TaskState {
    return { completedTaskIds: this.completedTaskIds, failedTaskCounts: this.failedTaskCounts };
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
    this.loadTaskState();  // Restore completed/failed task IDs from disk
    this.engine = getDecisionEngine({
      allowedProjects: config.allowedProjects,
      linearTeamId: config.linearTeamId,
      autoExecute: config.autoExecute,
      maxConsecutiveTasks: config.maxConsecutiveTasks,
      cooldownSeconds: config.cooldownSeconds,
      dryRun: config.dryRun,
    });

    // Initialize TaskScheduler
    this.scheduler = initScheduler({
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: false,
      worktreeMode: config.worktreeMode ?? false,
    });

    // Set up scheduler event handling
    this.setupSchedulerEvents();
  }

  private setupSchedulerEvents(): void {
    this.scheduler.on('started', async (running) => {
      const taskCtx = this.formatTaskContext(running.task);
      console.log(`[Scheduler] Task started: ${taskCtx} ${running.task.title}`);
      broadcastEvent({ type: 'task:started', data: { taskId: running.task.id, title: running.task.title, issueIdentifier: running.task.issueIdentifier } });
    });

    this.scheduler.on('completed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task completed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: result.success, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await reportToDiscord(formatPipelineResultEmbed(result));

      // Track as completed to prevent re-selection (persist to disk)
      if (task.issueId) {
        this.completedTaskIds.add(task.issueId);
        clearRejection(task.issueId); // Clear rejection count on success
        this.saveTaskState();
      }

      // Skip Linear state update for decomposed tasks (markAsDecomposed already moves to Done)
      if (result.finalStatus === 'decomposed') {
        console.log(`[Scheduler] Task decomposed into sub-issues, skipping Done state`);
        this.scheduleNextHeartbeat();
        return;
      }

      // On success, update Linear issue to Done
      if (result.success && task.issueId) {
        try {
          await linear.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
            workerSummary: result.workerResult?.summary,
            workerCommands: result.workerResult?.commands,
            reviewerFeedback: result.reviewResult?.feedback,
            reviewerDecision: result.reviewResult?.decision,
            testResults: result.testerResult ? {
              passed: result.testerResult.testsPassed,
              failed: result.testerResult.testsFailed,
              coverage: result.testerResult.coverage,
              failedTests: result.testerResult.failedTests,
            } : undefined,
          });
          console.log(`[Scheduler] Issue ${task.issueId} marked as Done`);
        } catch (err) {
          console.error(`[Scheduler] Failed to update issue state:`, err);
        }

        try {
          await saveCognitiveMemory('strategy',
            `Pipeline execution succeeded: "${task.title}"`,
            { confidence: 0.9, derivedFrom: task.issueId }
          );
        } catch (memErr) {
          console.warn(`[Scheduler] Memory save failed (non-critical):`, memErr);
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
        }).catch(e => console.warn('[Scheduler] Project update failed:', e));
      }

      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('failed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task failed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: false, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await reportToDiscord(formatPipelineResultEmbed(result));

      // If rejected, track rejection count and block after max attempts
      if (task.issueId && result.finalStatus === 'rejected') {
        const feedback = result.reviewResult?.feedback || 'No feedback provided';
        const rejectionCount = incrementRejection(task.issueId, feedback);

        console.log(`[Scheduler] Task rejected (${rejectionCount}/3): ${taskCtx} ${task.title}`);
        console.log(`[Scheduler] Rejection reason: ${feedback}`);

        if (isRejectionLimitReached(task.issueId)) {
          // Max rejections reached - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          this.saveTaskState();

          try {
            await linear.logBlocked(task.issueId, 'autonomous-runner',
              `⚠️ **Max rejection limit reached (${rejectionCount} attempts)**\n\n` +
              `This task has been rejected ${rejectionCount} times by the reviewer and requires manual intervention.\n\n` +
              `**Latest rejection reason:**\n${feedback}\n\n` +
              `**Action required:** Please review the task requirements and code manually, or adjust the task scope.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} permanently blocked (max rejections reached)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
          return;
        } else {
          // Not max yet - temporary block, will retry later
          try {
            await linear.logBlocked(task.issueId, 'autonomous-runner',
              t('runner.reviewRejected', { feedback }) + `\n\n**Rejection count:** ${rejectionCount}/3 - Will retry automatically.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked as Todo (blocked) (rejected ${rejectionCount}/3)`);
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
        console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx}`);

        if (count >= AutonomousRunner.MAX_RETRY_COUNT) {
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          this.saveTaskState();
          try {
            await linear.logBlocked(task.issueId, 'autonomous-runner',
              `Autonomous execution failed ${count} times. Moving to Blocked for manual review.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked as Todo (blocked) (max retries exceeded)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
        } else {
          // Save updated fail count even before max retries
          this.saveTaskState();
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
        }).catch(e => console.warn('[Scheduler] Project update failed:', e));
      }

      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('error', async ({ task, error }) => {
      const taskCtx = this.formatTaskContext(task);
      console.error(`[Scheduler] Task error: ${taskCtx} ${task.title}`, error);
      await reportToDiscord(t('runner.pipelineError', { title: `${taskCtx} ${task.title}`, error: error.message }));
    });

    this.scheduler.on('slotFreed', () => {
      // Auto-execute next task when slot becomes available
      void this.runAvailableTasks();
    });
  }

  private filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] {
    let recovered = 0;
    const recoverableStates = new Set(['Todo', 'In Progress', 'In Review']);
    const filtered = tasks.filter(task => {
      const id = task.issueId || task.id;

      // Check rejection limit first
      if (isRejectionLimitReached(id)) {
        return false; // Skip tasks that hit max rejection limit
      }

      // Recover issues in active states from completed/failed list
      // (user or system intentionally moved back to active, so retry)
      if (recoverableStates.has(task.linearState || '') && (this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT)) {
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id); // Clear rejection count on recovery
        recovered++;
        return true;
      }
      if (this.completedTaskIds.has(id)) return false;
      if ((this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT) return false;
      return true;
    });
    if (recovered > 0) {
      this.saveTaskState();
      this.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
    }
    return filtered;
  }

  /** Schedule next heartbeat (debounced 5s) */
  private _nextHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleNextHeartbeat(): void {
    if (this._nextHeartbeatTimer) return; // already scheduled
    console.log('[AutonomousRunner] Scheduling next heartbeat in 5s (event-driven)');
    this._nextHeartbeatTimer = setTimeout(() => {
      this._nextHeartbeatTimer = null;
      void this.heartbeat();
    }, 5000);
  }

  private async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // Parallel processing disabled
    }

    await this.scheduler.runAvailable(async (task, projectPath) => {
      return this.executePipeline(task, projectPath);
    });
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
          model: this.config.workerModel || 'claude-sonnet-4-20250514',
          timeoutMs: this.config.workerTimeoutMs ?? 0,
        },
        reviewer: {
          enabled: true,
          model: this.config.reviewerModel || 'claude-haiku-4-5-20251001',
          timeoutMs: this.config.reviewerTimeoutMs ?? 0,
        },
      };
    }

    // Apply per-project overrides
    const base = this.config.defaultRoles || {
      worker: { enabled: true, model: 'claude-sonnet-4-20250514', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'claude-haiku-4-5-20251001', timeoutMs: 0 },
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
    if (this.state.isRunning) {
      console.log('[AutonomousRunner] Already running');
      return;
    }

    await this.engine.init();

    // worktree mode: clean up dangling worktrees at startup
    if (this.config.worktreeMode) {
      for (const projectPath of this.config.allowedProjects) {
        const resolvedPath = projectPath.replace('~', process.env.HOME || '');
        pruneWorktrees(resolvedPath).catch((e) => console.error(`[AutonomousRunner] Worktree prune failed for ${resolvedPath}:`, e));
      }
    }

    // Set up cron job
    this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
      await this.heartbeat();
    });

    this.state.isRunning = true;
    this.state.startedAt = Date.now();
    console.log(`[AutonomousRunner] Started with schedule: ${this.config.heartbeatSchedule}`);

    await reportToDiscord(`🤖 ${t('runner.modeStarted')}\n` +
      `Schedule: \`${this.config.heartbeatSchedule}\`\n` +
      `Auto-execute: ${this.config.autoExecute ? '✅' : '❌'}\n` +
      `Projects: ${this.config.allowedProjects.join(', ')}`
    );

    // Immediate execution option
    if (this.config.triggerNow) {
      console.log('[AutonomousRunner] Triggering immediate heartbeat in 10s...');
      setTimeout(() => void this.heartbeat(), 10000); // Run after 10s (wait for Discord/Linear connection)
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.state.isRunning = false;
    console.log('[AutonomousRunner] Stopped');
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
      const resolvedPath = projectPath.replace('~', process.env.HOME || '');
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
    broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'heartbeat', line } });
  }

  async heartbeat(): Promise<void> {
    if (this._heartbeatRunning) {
      console.log('[AutonomousRunner] Heartbeat already running, skipping');
      return;
    }
    this._heartbeatRunning = true;

    console.log('[AutonomousRunner] Heartbeat triggered');
    this.state.lastHeartbeat = Date.now();
    broadcastEvent({ type: 'stats', data: this.buildStats() });
    broadcastEvent({ type: 'heartbeat' });
    this.syslog('▶ Heartbeat started');

    try {
      // 0. Knowledge graph refresh (async, service continues even on failure)
      this.refreshKnowledgeGraphs();

      // 0.5 Long-running monitor passive check (before time window)
      const active = getActiveMonitors().filter(m => m.state === 'pending' || m.state === 'running');
      if (active.length > 0) {
        const checked = await checkAllMonitors().catch(() => 0);
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

      // 2. Fetch tasks from Linear
      this.syslog('⟳ Fetching tasks from Linear...');
      const tasks = await fetchLinearTasks();
      if (tasks.length === 0) {
        this.syslog('— No tasks in backlog');
        return;
      }

      this.lastFetchedTasks = tasks;
      this.syslog(`✓ Found ${tasks.length} tasks from Linear`);

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
      this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      this.state.lastDecision = decision;

      // 4. Handle decision
      await this.handleDecision(decision);
      this.state.consecutiveErrors = 0;

    } catch (error) {
      this.state.consecutiveErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[AutonomousRunner] Heartbeat error:', msg);
      this.syslog(`✗ Heartbeat error: ${msg}`);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(t('runner.consecutiveErrors', { count: this.state.consecutiveErrors, error: msg }));
      }
    } finally {
      this._heartbeatRunning = false;
    }
  }

  private async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
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
    if (this.enabledProjects.size > 0) {
      tasksForEngine = executableTasks.filter(task => {
        const projName = task.linearProject?.name;
        if (!projName) return false;
        const cachedPath = this.projectPathCache.get(projName)
          ?? this.projectPathCache.get(projName.toLowerCase())
          ?? this.projectPathCache.get(projName.replace(/-/g, ' '));
        if (!cachedPath) {
          this.syslog(`  ⚠ No path cache for project "${projName}" — skipping ${task.issueIdentifier}`);
          return false;
        }
        const enabled = this.isProjectEnabled(cachedPath);
        if (!enabled) {
          this.syslog(`  ⚠ Project "${projName}" (${cachedPath}) not enabled — skipping ${task.issueIdentifier}`);
        }
        return enabled;
      });
      if (tasksForEngine.length === 0) {
        this.syslog(`⚠ No enabled tasks (${executableTasks.length} executable, ${tasks.length - executableTasks.length} backlog)`);
        this.syslog(`  Path cache: [${[...this.projectPathCache.entries()].map(([k,v]) => `${k}→${v}`).join(', ')}]`);
        this.syslog(`  Enabled: [${[...this.enabledProjects].join(', ')}]`);
        return;
      }
      this.syslog(`  Tasks: ${tasksForEngine.length} enabled-or-uncached / ${executableTasks.length} executable / ${tasks.length} total`);
    }

    // Get validated task list from DecisionEngine
    this.syslog('⟳ Decision Engine evaluating tasks...');
    const decision = await this.engine.heartbeatMultiple(
      tasksForEngine,
      maxSlots,
      [] // No project exclusion — worktree mode isolates each task
    );

    if (decision.action === 'skip' || decision.action === 'defer') {
      this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      return;
    }

    // Add validated tasks to queue
    let enqueuedCount = 0;
    for (const { task } of decision.tasks) {
      // Skip if already queued or running
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        this.syslog(`  Skip (already queued/running): ${task.issueIdentifier || task.id.slice(0, 8)} ${task.title}`);
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);

      // Skip if project path mapping failed
      if (!projectPath) {
        this.syslog(`✗ Cannot resolve project path for "${task.linearProject?.name || task.title}" — skipping`);
        continue;
      }

      // Cache linearProjectName → resolvedPath for dashboard
      if (task.linearProject?.name) {
        this.projectPathCache.set(task.linearProject.name, projectPath);
      }

      // Skip if project is already busy (double check)
      if (this.scheduler.isProjectBusy(projectPath)) {
        this.syslog(`  Project busy: ${projectPath}`);
        continue;
      }

      // Skip if project is not in enabled list (allow-list; empty = nothing runs)
      if (this.enabledProjects.size > 0 && !this.isProjectEnabled(projectPath)) {
        this.syslog(`  Project not enabled: ${projectPath}`);
        continue;
      }

      this.scheduler.enqueue(task, projectPath);
      broadcastEvent({ type: 'task:queued', data: { taskId: task.id, title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      this.syslog(`✓ Queued: ${task.issueIdentifier || ''} ${task.title} → ${projectPath.split('/').slice(-2).join('/')}`);
      enqueuedCount++;

      // Claim the task immediately: set Linear to 'In Progress' so restarts don't re-queue it
      // (fetch filter only picks up 'Todo' issues)
      if (task.issueId) {
        linear.updateIssueState(task.issueId, 'In Progress').catch((err: Error) =>
          console.warn(`[AutonomousRunner] Failed to claim issue ${task.issueIdentifier}:`, err)
        );
      }
    }

    if (enqueuedCount === 0 && decision.skippedCount > 0) {
      this.syslog(`— No new tasks queued (skipped: ${decision.skippedCount})`);
    } else {
      this.syslog(`✓ Enqueued ${enqueuedCount} task(s) | skipped: ${decision.skippedCount}`);
    }

    // Execute tasks
    await this.runAvailableTasks();
  }

  /** Handle decision */
  private async handleDecision(decision: DecisionResult): Promise<void> {
    switch (decision.action) {
      case 'execute':
        if (decision.task && decision.workflow) await this.executeTask(decision.task, decision.workflow);
        break;
      case 'defer':
        if (decision.task) { this.state.pendingApproval = decision.task; await this.requestApproval(decision); }
        break;
      case 'skip':
      case 'add_to_backlog':
        break;
    }
  }

  private async executeTask(task: TaskItem, workflow: any): Promise<void> {
    if (this.config.pairMode) {
      await this.executeTaskPairMode(task);
      return;
    }

    // Report start
    const projectInfo = task.linearProject?.name
      ? `📁 **${task.linearProject.name}**\n`
      : '';
    const issueRef = task.issueIdentifier || task.issueId || 'N/A';

    const startEmbed = new EmbedBuilder()
      .setTitle(t('runner.taskStarting'))
      .setColor(0x00AE86)
      .addFields(
        { name: t('runner.result.taskLabel'), value: `${projectInfo}${task.title}`, inline: false },
        { name: 'Issue', value: issueRef, inline: true },
        { name: 'Priority', value: `P${task.priority}`, inline: true },
        { name: 'Steps', value: `${workflow.steps?.length || '?'}`, inline: true },
      )
      .setTimestamp();

    await reportToDiscord(startEmbed);

    // Display parsed result if available
    if (task.issueId) {
      const parsed = await loadParsedTask(task.issueId);
      if (parsed) {
        const summary = formatParsedTaskSummary(parsed);
        await reportToDiscord(`${t('runner.analysisResult')}\n${summary.slice(0, 1500)}`);
      }
    }

    // Execute
    const result = await this.engine.executeTask(task, workflow);
    this.state.lastExecution = result;

    // Report results
    await this.reportExecutionResult(task, result);
  }

  /** Execute task in pair mode (legacy single-task) */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      return;
    }

    // Skip if project is not in enabled list (allow-list; empty = nothing runs)
    if (this.enabledProjects.size > 0 && !this.isProjectEnabled(projectPath)) {
      console.log(`[AutonomousRunner] Project not enabled, skipping: ${projectPath}`);
      return;
    }

    // Cache linearProjectName → resolvedPath for dashboard
    if (task.linearProject?.name) {
      this.projectPathCache.set(task.linearProject.name, projectPath);
    }

    console.log(`[AutonomousRunner] projectPath: ${projectPath}`);

    // Check task decomposition (when enableDecomposition is set)
    if (this.config.enableDecomposition) {
      const threshold = this.config.decompositionThresholdMinutes ?? 30;
      const needsDecomp = planner.needsDecomposition(task, threshold);

      if (needsDecomp) {
        console.log(`[AutonomousRunner] Task "${task.title}" needs decomposition (>${threshold}min estimated)`);
        const decomposed = await this.decomposeTask(task, projectPath, threshold);
        if (decomposed) {
          // Decomposition succeeded - sub-tasks added to queue, skip original task
          return;
        }
        // Decomposition failed - execute original task as-is
        console.log('[AutonomousRunner] Decomposition failed, executing original task');
      }
    }

    // Use scheduler for parallel processing mode
    if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1) {
      this.scheduler.enqueue(task, projectPath);
      broadcastEvent({ type: 'task:queued', data: { taskId: task.id, title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      await this.runAvailableTasks();
      return;
    }

    // Single execution (legacy)
    const result = await this.executePipeline(task, projectPath);
    await reportToDiscord(formatPipelineResultEmbed(result));

    // Update Linear issue state
    if (task.issueId) {
      try {
        if (result.success) {
          // On success, move to Done
          await linear.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
            workerSummary: result.workerResult?.summary,
            workerCommands: result.workerResult?.commands,
            reviewerFeedback: result.reviewResult?.feedback,
            reviewerDecision: result.reviewResult?.decision,
            testResults: result.testerResult ? {
              passed: result.testerResult.testsPassed,
              failed: result.testerResult.testsFailed,
              coverage: result.testerResult.coverage,
              failedTests: result.testerResult.failedTests,
            } : undefined,
          });
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Done`);

          try {
            await saveCognitiveMemory('strategy',
              `Pair execution succeeded: "${task.title}"`,
              { confidence: 0.9, derivedFrom: task.issueId }
            );
          } catch (memErr) {
            console.warn(`[AutonomousRunner] Memory save failed (non-critical):`, memErr);
          }
        } else if (result.finalStatus === 'rejected') {
          // Change to Blocked on review rejection
          await linear.logBlocked(task.issueId, 'autonomous-runner',
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

  private getExecCtx(): execution.ExecutionContext {
    return {
      allowedProjects: this.config.allowedProjects,
      plannerModel: this.config.plannerModel,
      plannerTimeoutMs: this.config.plannerTimeoutMs,
      pairMaxAttempts: this.config.pairMaxAttempts,
      enableDecomposition: this.config.enableDecomposition,
      decompositionThresholdMinutes: this.config.decompositionThresholdMinutes,
      getRolesForProject: (p) => this.getRolesForProject(p),
      reportToDiscord,
      worktreeMode: this.config.worktreeMode ?? false,
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
    };
  }

  private async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  private async decomposeTask(task: TaskItem, projectPath: string, targetMinutes: number): Promise<boolean | 'no-decomp'> {
    return execution.decomposeTask(this.getExecCtx(), task, projectPath, targetMinutes);
  }

  private async executePipeline(task: TaskItem, projectPath: string): Promise<PipelineResult> {
    return execution.executePipeline(this.getExecCtx(), task, projectPath);
  }

  private async requestApproval(decision: DecisionResult): Promise<void> {
    return execution.requestApproval(decision, reportToDiscord);
  }

  private async reportExecutionResult(task: TaskItem, result: ExecutorResult): Promise<void> {
    return execution.reportExecutionResult(task, result, reportToDiscord);
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
      await this.executeTask(decision.task, decision.workflow);
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

  updateAllowedProjects(paths: string[]): void {
    this.config.allowedProjects = paths;
    this.engine.updateAllowedProjects(paths);
  }

  getStats(): {
    isRunning: boolean;
    lastHeartbeat: number;
    engineStats: ReturnType<DecisionEngine['getStats']>;
    pendingApproval: boolean;
    schedulerStats: ReturnType<TaskScheduler['getStats']>;
  } {
    return {
      isRunning: this.state.isRunning,
      lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(),
      pendingApproval: !!this.state.pendingApproval,
      schedulerStats: this.scheduler.getStats(),
    };
  }

  pauseScheduler(): void { this.scheduler.pause(); }
  resumeScheduler(): void { this.scheduler.resume(); }
  getQueuedTasks() { return this.scheduler.getQueuedTasks(); }
  getRunningTasks() { return this.scheduler.getRunningTasks(); }
  getPipelineHistory(limit = 50) { return getPipelineHistory(limit); }

  private recordPipelineHistory(task: TaskItem, result: PipelineResult): void {
    const entry: PipelineHistoryEntry = {
      sessionId: result.sessionId,
      issueIdentifier: task.issueIdentifier || task.issueId,
      issueId: task.issueId,
      taskTitle: task.title,
      projectName: task.linearProject?.name,
      projectPath: result.taskContext?.projectPath,
      success: result.success,
      finalStatus: result.finalStatus,
      iterations: result.iterations,
      totalDuration: result.totalDuration,
      stages: result.stages.map(s => ({ stage: s.stage, success: s.success, duration: s.duration })),
      cost: result.totalCost ? {
        costUsd: result.totalCost.costUsd,
        inputTokens: result.totalCost.inputTokens,
        outputTokens: result.totalCost.outputTokens,
      } : undefined,
      prUrl: result.prUrl,
      reviewerFeedback: result.reviewResult?.feedback, // Save reviewer rejection reason
      completedAt: new Date().toISOString(),
    };
    appendPipelineHistory(entry);
  }

  disableProject(projectPath: string): void {
    this.enabledProjects.delete(projectPath);
    console.log(`[AutonomousRunner] Project disabled: ${projectPath}`);
  }

  enableProject(projectPath: string): void {
    this.enabledProjects.add(projectPath);
    console.log(`[AutonomousRunner] Project enabled: ${projectPath}`);
  }

  /** Get all currently enabled project paths */
  getEnabledProjects(): string[] {
    return Array.from(this.enabledProjects);
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
  return runner;
}

/**
 * Stop runner (convenience function)
 */
export function stopAutonomous(): void {
  if (runnerInstance) {
    runnerInstance.stop();
  }
}
