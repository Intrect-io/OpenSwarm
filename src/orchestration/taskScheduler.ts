// ============================================
// OpenSwarm - Task Scheduler
// Parallel task scheduling and execution management
// ============================================

import { EventEmitter } from 'node:events';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

// ============================================
// Types
// ============================================

export interface QueuedTask {
  task: TaskItem;
  projectPath: string;
  queuedAt: number;
  priority: number; // 1=Urgent, 2=High, 3=Normal, 4=Low
}

export interface RunningTask {
  task: TaskItem;
  projectPath: string;
  startedAt: number;
  promise: Promise<PipelineResult>;
}

export interface SchedulerConfig {
  /** Maximum number of concurrent tasks */
  maxConcurrent: number;
  /** Allow concurrent execution on same project */
  allowSameProjectConcurrent?: boolean;
  /** Git worktree mode: each task runs in its own isolated worktree (bypasses project busy check) */
  worktreeMode?: boolean;
}

export interface SchedulerStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  byProject: Map<string, number>;
}

// ============================================
// Task Scheduler
// ============================================

export class TaskScheduler extends EventEmitter {
  private config: SchedulerConfig;
  private taskQueue: QueuedTask[] = [];
  private runningTasks: Map<string, RunningTask> = new Map();
  private completedCount = 0;
  private failedCount = 0;
  private paused = false;

  constructor(config: SchedulerConfig) {
    super();
    this.config = {
      allowSameProjectConcurrent: false,
      ...config,
    };
  }

  // ============================================
  // Queue Management
  // ============================================

  /**
   * Add task to queue
   */
  enqueue(task: TaskItem, projectPath: string): void {
    // Duplicate check
    if (this.isTaskQueued(task.id) || this.isTaskRunning(task.id)) {
      console.log(`[Scheduler] Task ${task.id} already in queue/running, skipping`);
      return;
    }

    const queuedTask: QueuedTask = {
      task,
      projectPath,
      queuedAt: Date.now(),
      priority: task.priority,
    };

    // Insert by priority
    const insertIdx = this.taskQueue.findIndex(
      (t) => t.priority > queuedTask.priority
    );

    if (insertIdx === -1) {
      this.taskQueue.push(queuedTask);
    } else {
      this.taskQueue.splice(insertIdx, 0, queuedTask);
    }

    console.log(`[Scheduler] Enqueued task: ${task.title} (priority: ${task.priority})`);
    this.emit('enqueued', queuedTask);
  }

  /**
   * Check if task is in queue
   */
  isTaskQueued(taskId: string): boolean {
    return this.taskQueue.some((t) => t.task.id === taskId);
  }

  /**
   * Check if task is running
   */
  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * Remove task from queue
   */
  dequeue(taskId: string): boolean {
    const idx = this.taskQueue.findIndex((t) => t.task.id === taskId);
    if (idx === -1) return false;

    this.taskQueue.splice(idx, 1);
    return true;
  }

  /**
   * Clear queue
   */
  clearQueue(): void {
    this.taskQueue = [];
    console.log('[Scheduler] Queue cleared');
  }

  // ============================================
  // Slot Management
  // ============================================

  /**
   * Check if available slots exist
   */
  hasAvailableSlot(): boolean {
    return this.runningTasks.size < this.config.maxConcurrent;
  }

  /**
   * Number of available slots
   */
  getAvailableSlots(): number {
    return Math.max(0, this.config.maxConcurrent - this.runningTasks.size);
  }

  /**
   * Check if project is currently busy
   */
  isProjectBusy(projectPath: string): boolean {
    if (this.config.worktreeMode || this.config.allowSameProjectConcurrent) {
      return false;
    }

    for (const running of this.runningTasks.values()) {
      if (running.projectPath === projectPath) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return list of currently busy projects
   */
  getBusyProjects(): string[] {
    if (this.config.worktreeMode || this.config.allowSameProjectConcurrent) {
      return [];
    }

    const projects = new Set<string>();
    for (const running of this.runningTasks.values()) {
      projects.add(running.projectPath);
    }
    return Array.from(projects);
  }

  // ============================================
  // Execution
  // ============================================

  /**
   * Get next executable task
   */
  getNextExecutable(): QueuedTask | null {
    if (this.paused || !this.hasAvailableSlot()) {
      return null;
    }

    for (let i = 0; i < this.taskQueue.length; i++) {
      const queued = this.taskQueue[i];

      // Project duplication check
      if (this.isProjectBusy(queued.projectPath)) {
        continue;
      }

      // Executable
      this.taskQueue.splice(i, 1);
      return queued;
    }

    return null;
  }

  /**
   * Start task execution
   */
  startTask(
    task: TaskItem,
    projectPath: string,
    executor: () => Promise<PipelineResult>
  ): void {
    const runningTask: RunningTask = {
      task,
      projectPath,
      startedAt: Date.now(),
      promise: executor(),
    };

    this.runningTasks.set(task.id, runningTask);
    console.log(`[Scheduler] Started task: ${task.title}`);
    this.emit('started', runningTask);

    // Completion handling
    runningTask.promise
      .then((result) => {
        this.handleTaskComplete(task.id, result);
      })
      .catch((error) => {
        this.handleTaskError(task.id, error);
      });
  }

  /**
   * Handle task completion
   */
  private handleTaskComplete(taskId: string, result: PipelineResult): void {
    const running = this.runningTasks.get(taskId);
    if (!running) return;

    this.runningTasks.delete(taskId);

    if (result.success) {
      this.completedCount++;
      console.log(`[Scheduler] Task completed: ${running.task.title}`);
      this.emit('completed', { task: running.task, result });
    } else {
      this.failedCount++;
      console.log(`[Scheduler] Task failed: ${running.task.title}`);
      this.emit('failed', { task: running.task, result });
    }

    // Trigger next task execution
    this.emit('slotFreed');
  }

  /**
   * Handle task error
   */
  private handleTaskError(taskId: string, error: Error): void {
    const running = this.runningTasks.get(taskId);
    if (!running) return;

    this.runningTasks.delete(taskId);
    this.failedCount++;

    console.error(`[Scheduler] Task error: ${running.task.title}`, error.message);
    this.emit('error', { task: running.task, error });
    this.emit('slotFreed');
  }

  /**
   * Execute all available tasks from queue
   * @param executor Task execution function
   */
  async runAvailable(
    executor: (task: TaskItem, projectPath: string) => Promise<PipelineResult>
  ): Promise<number> {
    let started = 0;

    console.log(`[Scheduler] runAvailable: paused=${this.paused}, running=${this.runningTasks.size}/${this.config.maxConcurrent}, queue=${this.taskQueue.length}, worktreeMode=${this.config.worktreeMode}`);

    while (this.hasAvailableSlot()) {
      const next = this.getNextExecutable();
      if (!next) {
        console.log(`[Scheduler] runAvailable: no more executable tasks (queue=${this.taskQueue.length})`);
        break;
      }

      this.startTask(next.task, next.projectPath, () =>
        executor(next.task, next.projectPath)
      );
      started++;
    }

    console.log(`[Scheduler] runAvailable: started ${started} tasks`);
    return started;
  }

  /**
   * Wait for all running tasks to complete
   */
  async waitAll(): Promise<PipelineResult[]> {
    const promises = Array.from(this.runningTasks.values()).map((r) => r.promise);
    return Promise.all(promises);
  }

  // ============================================
  // Control
  // ============================================

  /**
   * Pause scheduler
   */
  pause(): void {
    this.paused = true;
    console.log('[Scheduler] Paused');
    this.emit('paused');
  }

  /**
   * Resume scheduler
   */
  resume(): void {
    this.paused = false;
    console.log('[Scheduler] Resumed');
    this.emit('resumed');
  }

  /**
   * Check if scheduler is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  // ============================================
  // Stats & Info
  // ============================================

  /**
   * Get current stats
   */
  getStats(): SchedulerStats {
    const byProject = new Map<string, number>();

    for (const running of this.runningTasks.values()) {
      const count = byProject.get(running.projectPath) || 0;
      byProject.set(running.projectPath, count + 1);
    }

    return {
      queued: this.taskQueue.length,
      running: this.runningTasks.size,
      completed: this.completedCount,
      failed: this.failedCount,
      byProject,
    };
  }

  /**
   * Get list of queued tasks
   */
  getQueuedTasks(): QueuedTask[] {
    return [...this.taskQueue];
  }

  /**
   * Get list of running tasks
   */
  getRunningTasks(): RunningTask[] {
    return Array.from(this.runningTasks.values());
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('[Scheduler] Config updated:', this.config);
  }
}

// ============================================
// Singleton
// ============================================

let schedulerInstance: TaskScheduler | null = null;

/**
 * Get scheduler instance
 */
export function getScheduler(config?: SchedulerConfig): TaskScheduler {
  if (!schedulerInstance && config) {
    schedulerInstance = new TaskScheduler(config);
  }
  if (!schedulerInstance) {
    throw new Error('Scheduler not initialized. Call getScheduler with config first.');
  }
  return schedulerInstance;
}

/**
 * Initialize scheduler
 */
export function initScheduler(config: SchedulerConfig): TaskScheduler {
  schedulerInstance = new TaskScheduler(config);
  return schedulerInstance;
}

/**
 * Reset scheduler (for testing)
 */
export function resetScheduler(): void {
  schedulerInstance = null;
}
