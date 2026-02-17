// ============================================
// Claude Swarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
// ============================================

import { Cron } from 'croner';
import {
  DecisionEngine,
  DecisionResult,
  TaskItem,
  getDecisionEngine,
} from './decisionEngine.js';
import type { ExecutorResult } from './workflowExecutor.js';
import { checkWorkAllowed } from './timeWindow.js';
import { formatParsedTaskSummary, loadParsedTask } from './taskParser.js';
import { saveCognitiveMemory } from './memory.js';
import { EmbedBuilder } from 'discord.js';
import * as linear from './linear.js';
import { TaskScheduler, initScheduler } from './taskScheduler.js';
import {
  PipelineResult,
  formatPipelineResult,
} from './pairPipeline.js';
import type { DefaultRolesConfig, ProjectAgentConfig } from './types.js';
import * as planner from './planner.js';
import * as execution from './runnerExecution.js';
import { reportToDiscord, fetchLinearTasks } from './runnerExecution.js';
import { t } from './locale/index.js';

// Re-export integration setters (used by service.ts)
export { setDiscordReporter, setLinearFetcher } from './runnerExecution.js';

// ============================================
// Types
// ============================================

export interface AutonomousConfig {
  /** Linear team ID */
  linearTeamId: string;

  /** Allowed project paths */
  allowedProjects: string[];

  /** Heartbeat interval (cron or interval) */
  heartbeatSchedule: string;

  /** Auto-execute (if false, approval required) */
  autoExecute: boolean;

  /** Discord channel ID (for reporting) */
  discordChannelId?: string;

  /** Max consecutive tasks */
  maxConsecutiveTasks: number;

  /** Cooldown between tasks (seconds) */
  cooldownSeconds: number;

  /** Dry run mode */
  dryRun: boolean;

  /** Worker/Reviewer pair mode */
  pairMode?: boolean;

  /** Pair mode max attempts */
  pairMaxAttempts?: number;

  /** Worker model (legacy) */
  workerModel?: string;

  /** Reviewer model (legacy) */
  reviewerModel?: string;

  /** Worker timeout (ms) (legacy) */
  workerTimeoutMs?: number;

  /** Reviewer timeout (ms) (legacy) */
  reviewerTimeoutMs?: number;

  /** Trigger immediately on start */
  triggerNow?: boolean;

  /** Max concurrent tasks */
  maxConcurrentTasks?: number;

  /** Default role configuration */
  defaultRoles?: DefaultRolesConfig;

  /** Per-project agent configuration */
  projectAgents?: ProjectAgentConfig[];

  /** Enable task decomposition */
  enableDecomposition?: boolean;

  /** Task decomposition threshold (minutes, default 30) */
  decompositionThresholdMinutes?: number;

  /** Planner model */
  plannerModel?: string;

  /** Planner timeout (ms, default 600000 = 10min) */
  plannerTimeoutMs?: number;
}

export interface RunnerState {
  isRunning: boolean;
  lastHeartbeat: number;
  lastDecision?: DecisionResult;
  lastExecution?: ExecutorResult;
  pendingApproval?: TaskItem;
  consecutiveErrors: number;
}


// ============================================
// Autonomous Runner
// ============================================

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

  // Track completed/failed task IDs to prevent re-selection
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private static readonly MAX_RETRY_COUNT = 2;

  // Rate limiting: max 1 issue per hour
  private lastTaskStartedAt = 0;
  private static readonly RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Format task project/issue context string
   */
  private formatTaskContext(task: TaskItem): string {
    const parts: string[] = [];
    if (task.linearProject?.name) parts.push(`[${task.linearProject.name}]`);
    if (task.issueIdentifier) parts.push(task.issueIdentifier);
    else if (task.issueId) parts.push(task.issueId.slice(0, 8));
    return parts.length > 0 ? parts.join(' ') : '';
  }

  constructor(config: AutonomousConfig) {
    this.config = config;
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
    });

    // Set up scheduler event handling
    this.setupSchedulerEvents();
  }

  /**
   * Set up scheduler events
   */
  private setupSchedulerEvents(): void {
    this.scheduler.on('started', async (running) => {
      const taskCtx = this.formatTaskContext(running.task);
      console.log(`[Scheduler] Task started: ${taskCtx} ${running.task.title}`);
      this.lastTaskStartedAt = Date.now();
    });

    this.scheduler.on('completed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task completed: ${taskCtx} ${task.title}`);
      await reportToDiscord(formatPipelineResult(result));

      // Track as completed to prevent re-selection
      if (task.issueId) {
        this.completedTaskIds.add(task.issueId);
      }

      // Skip Linear state update for decomposed tasks (sub-issues handle themselves)
      if (result.finalStatus === 'decomposed') {
        console.log(`[Scheduler] Task decomposed into sub-issues, skipping Done state`);
        return;
      }

      // On success, update Linear issue to Done
      if (result.success && task.issueId) {
        try {
          await linear.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
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
    });

    this.scheduler.on('failed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task failed: ${taskCtx} ${task.title}`);
      await reportToDiscord(formatPipelineResult(result));

      // If rejected, change to Blocked immediately
      if (task.issueId && result.finalStatus === 'rejected') {
        this.completedTaskIds.add(task.issueId); // Prevent re-selection
        try {
          await linear.logBlocked(task.issueId, 'autonomous-runner',
            t('runner.reviewRejected', { feedback: result.reviewResult?.feedback || t('common.fallback.noDescription') })
          );
          console.log(`[Scheduler] Issue ${task.issueId} marked as Blocked (rejected)`);
        } catch (err) {
          console.error(`[Scheduler] Failed to update issue state:`, err);
        }
        return;
      }

      // Track failure count — block after MAX_RETRY_COUNT failures
      if (task.issueId) {
        const count = (this.failedTaskCounts.get(task.issueId) ?? 0) + 1;
        this.failedTaskCounts.set(task.issueId, count);
        console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx}`);

        if (count >= AutonomousRunner.MAX_RETRY_COUNT) {
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          try {
            await linear.logBlocked(task.issueId, 'autonomous-runner',
              `Autonomous execution failed ${count} times. Moving to Blocked for manual review.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked as Blocked (max retries exceeded)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
        }
      }
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

  /**
   * Filter out tasks already completed or exceeding retry limit
   */
  private filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] {
    return tasks.filter(task => {
      const id = task.issueId || task.id;
      if (this.completedTaskIds.has(id)) {
        return false;
      }
      const failCount = this.failedTaskCounts.get(id) ?? 0;
      if (failCount >= AutonomousRunner.MAX_RETRY_COUNT) {
        return false;
      }
      return true;
    });
  }

  /**
   * Execute tasks in available slots
   */
  private async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // Parallel processing disabled
    }

    await this.scheduler.runAvailable(async (task, projectPath) => {
      return this.executePipeline(task, projectPath);
    });
  }

  /**
   * Get role configuration for a project
   */
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
          model: this.config.reviewerModel || 'claude-3-5-haiku-20241022',
          timeoutMs: this.config.reviewerTimeoutMs ?? 0,
        },
      };
    }

    // Apply per-project overrides
    const base = this.config.defaultRoles || {
      worker: { enabled: true, model: 'claude-sonnet-4-20250514', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'claude-3-5-haiku-20241022', timeoutMs: 0 },
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

  /**
   * Start the runner
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[AutonomousRunner] Already running');
      return;
    }

    await this.engine.init();

    // Set up cron job
    this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
      await this.heartbeat();
    });

    this.state.isRunning = true;
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

  /**
   * Stop the runner
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.state.isRunning = false;
    console.log('[AutonomousRunner] Stopped');
  }

  /**
   * Execute heartbeat
   */
  async heartbeat(): Promise<void> {
    console.log('[AutonomousRunner] Heartbeat triggered');
    this.state.lastHeartbeat = Date.now();

    try {
      // 1. Check time window
      const timeCheck = checkWorkAllowed();
      if (!timeCheck.allowed) {
        console.log(`[AutonomousRunner] Blocked: ${timeCheck.reason}`);
        return;
      }

      // 1.5. Rate limit: max 1 issue per hour
      if (this.lastTaskStartedAt > 0) {
        const elapsed = Date.now() - this.lastTaskStartedAt;
        if (elapsed < AutonomousRunner.RATE_LIMIT_MS) {
          const remainMin = Math.ceil((AutonomousRunner.RATE_LIMIT_MS - elapsed) / 60000);
          console.log(`[AutonomousRunner] Rate limited: last task started ${Math.floor(elapsed / 60000)}min ago, next allowed in ${remainMin}min`);
          return;
        }
      }

      // 2. Fetch tasks from Linear
      const tasks = await fetchLinearTasks();
      if (tasks.length === 0) {
        console.log('[AutonomousRunner] No tasks in backlog');
        return;
      }

      console.log(`[AutonomousRunner] Found ${tasks.length} tasks`);

      // Filter out completed and over-retried tasks
      const filteredTasks = this.filterAlreadyProcessed(tasks);
      if (filteredTasks.length === 0) {
        console.log('[AutonomousRunner] All tasks already completed or max retries exceeded');
        return;
      }
      if (filteredTasks.length !== tasks.length) {
        console.log(`[AutonomousRunner] Filtered: ${tasks.length} → ${filteredTasks.length} (skipped ${tasks.length - filteredTasks.length} completed/failed)`);
      }

      // Parallel processing mode
      if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1 && this.config.pairMode) {
        await this.heartbeatParallel(filteredTasks);
        return;
      }

      // 3. Run Decision Engine (single task)
      console.log('[AutonomousRunner] Calling DecisionEngine.heartbeat...');
      const decision = await this.engine.heartbeat(filteredTasks);
      console.log(`[AutonomousRunner] Decision: action=${decision.action}, reason=${decision.reason}`);
      this.state.lastDecision = decision;

      // 4. Handle decision
      console.log('[AutonomousRunner] Calling handleDecision...');
      await this.handleDecision(decision);
      console.log('[AutonomousRunner] handleDecision completed');

      this.state.consecutiveErrors = 0;

    } catch (error: any) {
      this.state.consecutiveErrors++;
      console.error('[AutonomousRunner] Heartbeat error:', error.message);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(t('runner.consecutiveErrors', { count: this.state.consecutiveErrors, error: error.message }));
      }
    }
  }

  /**
   * Parallel processing heartbeat (uses DecisionEngine.heartbeatMultiple)
   */
  private async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
    console.log(`[AutonomousRunner] Parallel heartbeat: ${tasks.length} tasks`);

    const availableSlots = this.scheduler.getAvailableSlots();
    if (availableSlots === 0) {
      console.log('[AutonomousRunner] No available slots');
      return;
    }

    // Get list of already running projects
    const busyProjects = this.scheduler.getBusyProjects();

    // Rate limit: only allow 1 task per heartbeat cycle
    const maxSlots = 1;

    // Get validated task list from DecisionEngine
    const decision = await this.engine.heartbeatMultiple(
      tasks,
      maxSlots,
      busyProjects
    );

    if (decision.action === 'skip' || decision.action === 'defer') {
      console.log(`[AutonomousRunner] Decision: ${decision.action} - ${decision.reason}`);
      return;
    }

    // Add validated tasks to queue
    let enqueuedCount = 0;
    for (const { task } of decision.tasks) {
      // Skip if already queued or running
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);

      // Skip if project path mapping failed
      if (!projectPath) {
        console.error(`[AutonomousRunner] Skipping task "${task.title}" - project path not resolved`);
        continue;
      }

      // Skip if project is already busy (double check)
      if (this.scheduler.isProjectBusy(projectPath)) {
        console.log(`[AutonomousRunner] Project busy: ${projectPath}`);
        continue;
      }

      this.scheduler.enqueue(task, projectPath);
      enqueuedCount++;
    }

    console.log(`[AutonomousRunner] Enqueued ${enqueuedCount} tasks (skipped: ${decision.skippedCount})`);

    // Execute tasks
    await this.runAvailableTasks();
  }

  /**
   * Handle decision
   */
  private async handleDecision(decision: DecisionResult): Promise<void> {
    console.log(`[AutonomousRunner] handleDecision: action=${decision.action}`);
    switch (decision.action) {
      case 'execute':
        console.log('[AutonomousRunner] Entering execute case');
        if (decision.task && decision.workflow) {
          console.log(`[AutonomousRunner] About to execute task: ${decision.task.title}`);
          await this.executeTask(decision.task, decision.workflow);
          console.log('[AutonomousRunner] executeTask completed');
        }
        break;

      case 'defer':
        if (decision.task) {
          this.state.pendingApproval = decision.task;
          await this.requestApproval(decision);
        }
        break;

      case 'skip':
        console.log(`[AutonomousRunner] Skipped: ${decision.reason}`);
        break;

      case 'add_to_backlog':
        console.log(`[AutonomousRunner] Added to backlog: ${decision.reason}`);
        break;
    }
  }

  /**
   * Execute task
   */
  private async executeTask(task: TaskItem, workflow: any): Promise<void> {
    console.log(`[AutonomousRunner] executeTask called, pairMode=${this.config.pairMode}`);
    // If pair mode, use pair execution
    if (this.config.pairMode) {
      console.log('[AutonomousRunner] Calling executeTaskPairMode...');
      await this.executeTaskPairMode(task);
      console.log('[AutonomousRunner] executeTaskPairMode completed');
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

  /**
   * Execute task in pair mode (Worker/Reviewer loop)
   * Legacy mode - processes single task without parallel execution
   */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    console.log('[AutonomousRunner] executeTaskPairMode started');

    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      return;
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
      await this.runAvailableTasks();
      return;
    }

    // Single execution (legacy)
    const result = await this.executePipeline(task, projectPath);
    await reportToDiscord(formatPipelineResult(result));

    // Update Linear issue state
    if (task.issueId) {
      try {
        if (result.success) {
          // On success, move to Done
          await linear.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
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
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Blocked (rejected)`);
        }
        // If failed, keep In Progress (retry on next heartbeat)
      } catch (err) {
        console.error(`[AutonomousRunner] Failed to update issue state:`, err);
      }
    }
  }

  // ============================================
  // Delegation to runnerExecution.ts
  // ============================================

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
    };
  }

  private async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  private async decomposeTask(task: TaskItem, projectPath: string, targetMinutes: number): Promise<boolean> {
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

  /**
   * Manual approval
   */
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

  /**
   * Manual rejection
   */
  reject(): boolean {
    if (!this.state.pendingApproval) {
      return false;
    }

    this.state.pendingApproval = undefined;
    return true;
  }

  /**
   * Run now (manual trigger)
   */
  async runNow(): Promise<void> {
    await this.heartbeat();
  }

  /**
   * Get state
   */
  getState(): RunnerState {
    return { ...this.state };
  }

  /**
   * Get statistics
   */
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

  /**
   * Pause scheduler
   */
  pauseScheduler(): void {
    this.scheduler.pause();
  }

  /**
   * Resume scheduler
   */
  resumeScheduler(): void {
    this.scheduler.resume();
  }

  /**
   * Get queued tasks
   */
  getQueuedTasks() {
    return this.scheduler.getQueuedTasks();
  }

  /**
   * Get running tasks
   */
  getRunningTasks() {
    return this.scheduler.getRunningTasks();
  }
}

// ============================================
// Singleton & Convenience Functions
// ============================================

/**
 * Get runner instance
 */
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
