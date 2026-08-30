// ============================================
// OpenSwarm - Task Scheduler
// Parallel task scheduling and execution management
// ============================================

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import { safeConsole as console } from '../support/safeLog.js';
import {
  SchedulerThroughputTracker,
  type SchedulerThroughputSnapshot,
} from './schedulerThroughput.js';

// Absolute upper bound on a single task's wall-clock time — a LAST-RESORT backstop.
// The fast reclaiming is done by per-stage timeouts (pairPipeline: worker 20min,
// reviewer/tester 6min) and git-op timeouts; this only catches a hang OUTSIDE those
// (e.g. non-stage code). Set above realistic multi-iteration work (observed worker
// runs 2-5min) but low enough to reclaim a genuine hang within the hour. A rare
// false-kill of a pathologically long-but-progressing task just retries — the
// watchdog's reject frees the slot and does NOT count toward STUCK. (INT-2521)
const HARD_TASK_TIMEOUT_MS = 60 * 60_000;

export function normalizeProjectPath(path: string): string {
  // Guard: resolve('') returns process.cwd(), so an accidental empty-string
  // cancellation would match every task under the daemon's cwd. Keep the
  // pre-#192 no-op behavior ('/' matches nothing in practice) instead.
  if (!path.trim()) return '/';
  const slashed = path.replace(/\\/g, '/');
  const expanded = slashed === '~' || slashed.startsWith('~/')
    ? `${homedir()}${slashed.slice(1)}`
    : slashed;
  const resolved = resolve(expanded);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Queueing can precede worktree creation; a not-yet-existing path still gets
    // a stable absolute fallback.
  }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/+$/g, '');
  return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) || '/';
}

function isSameProjectOrDescendant(candidatePath: string, projectPath: string): boolean {
  const candidate = normalizeProjectPath(candidatePath);
  const project = normalizeProjectPath(projectPath);
  return candidate === project || candidate.startsWith(`${project}/`);
}

// Types

export interface QueuedTask {
  task: TaskItem;
  projectPath: string;
  queuedAt: number;
  priority: number; // 1=Urgent, 2=High, 3=Normal, 4=Low
}

export interface RunningTask {
  /** Unique execution generation. Task ids may be reused after retries. */
  runId: string;
  task: TaskItem;
  projectPath: string;
  startedAt: number;
  promise: Promise<PipelineResult>;
  /** Settles only when the underlying executor really exits, not when a watchdog frees the slot. */
  executorSettled: Promise<void>;
  /** Aborts this task's pipeline + in-flight adapter call (cancel / project disable). */
  abortController: AbortController;
  /** Current pipeline stage (worker/reviewer/…), for the dashboard process view. */
  stage?: string;
}

export interface SchedulerConfig {
  /** Maximum number of concurrent tasks */
  maxConcurrent: number;
  /** Allow concurrent execution on same project */
  allowSameProjectConcurrent?: boolean;
  /** Maximum concurrent tasks per project when same-project parallelism is enabled. */
  maxConcurrentPerProject?: number;
  /** Git worktree mode: each task runs in its own isolated worktree (bypasses project busy check) */
  worktreeMode?: boolean;
  /** Test/operations override for the last-resort watchdog. */
  hardTaskTimeoutMs?: number;
}

export interface SchedulerStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  /** Timed-out executors that have not acknowledged cancellation yet. */
  quarantined: number;
  byProject: Map<string, number>;
  throughput: SchedulerThroughputSnapshot;
}

function normalizeSchedulerConfig(config: SchedulerConfig): SchedulerConfig {
  const normalized: SchedulerConfig = {
    allowSameProjectConcurrent: false,
    ...config,
  };

  // Same-project parallelism REQUIRES per-task worktree isolation. Without it,
  // two concurrent tasks would mutate one shared working tree and corrupt each
  // other. Guard at the one place that holds both flags: force-disable + warn.
  // (INT-1975)
  if (normalized.allowSameProjectConcurrent && !normalized.worktreeMode) {
    console.warn(
      '[Scheduler] allowSameProjectConcurrent ignored: requires worktreeMode ' +
        '(a shared working tree would be corrupted by concurrent tasks). ' +
        'Set worktreeMode:true to enable same-project parallelism.'
    );
    normalized.allowSameProjectConcurrent = false;
  }

  if (normalized.maxConcurrentPerProject != null) {
    const cap = Math.floor(normalized.maxConcurrentPerProject);
    normalized.maxConcurrentPerProject = Math.max(1, Math.min(cap, normalized.maxConcurrent));
  }

  return normalized;
}

// Task Scheduler

export class TaskScheduler extends EventEmitter {
  private config: SchedulerConfig;
  private taskQueue: QueuedTask[] = [];
  private runningTasks: Map<string, RunningTask> = new Map();
  private completedCount = 0;
  private failedCount = 0;
  private readonly throughput: SchedulerThroughputTracker;
  private paused = false;
  private stopping = false;
  /** A timed-out executor may still mutate its worktree. Keep that repository fail-closed. */
  private quarantinedProjects = new Map<string, Map<string, { taskId: string; projectPath: string }>>();
  /** Includes executors whose logical task promise was already timed out/rejected. */
  private unsettledExecutors = new Map<string, Promise<void>>();

  constructor(config: SchedulerConfig) {
    super();
    this.config = normalizeSchedulerConfig(config);
    this.throughput = new SchedulerThroughputTracker(this.config.maxConcurrent);
  }

  // ============================================
  // Queue Management
  // ============================================

  /**
   * Add task to queue
   */
  enqueue(task: TaskItem, projectPath: string): boolean {
    if (this.stopping) {
      console.warn(`[Scheduler] Refusing enqueue while stopping: ${task.title}`);
      return false;
    }
    // Duplicate check
    if (this.isTaskQueued(task.id) || this.isTaskRunning(task.id)) {
      console.log(`[Scheduler] Task ${task.id} already in queue/running, skipping`);
      return false;
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
    return true;
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
    return !this.stopping && this.runningTasks.size < this.config.maxConcurrent;
  }

  /**
   * Number of available slots
   */
  getAvailableSlots(): number {
    return Math.max(0, this.config.maxConcurrent - this.runningTasks.size);
  }

  /**
   * Check if project is currently busy. One worker per project at a time (so the
   * global slot budget spreads across projects instead of piling onto one). Only
   * `allowSameProjectConcurrent` opts out — worktreeMode keeps per-task isolation
   * but no longer implies same-project parallelism.
   */
  isProjectBusy(projectPath: string): boolean {
    const normalizedProject = normalizeProjectPath(projectPath);
    if (this.quarantinedProjects.has(normalizedProject)) return true;
    let runningCount = 0;
    for (const running of this.runningTasks.values()) {
      if (normalizeProjectPath(running.projectPath) === normalizedProject) {
        runningCount++;
      }
    }

    if (this.config.allowSameProjectConcurrent) {
      const cap = this.config.maxConcurrentPerProject;
      return cap != null ? runningCount >= cap : false;
    }

    return runningCount > 0;
  }

  private runningCountByProject(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const running of this.runningTasks.values()) {
      const key = normalizeProjectPath(running.projectPath);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  private quarantinedExecutorCount(): number {
    let count = 0;
    for (const runs of this.quarantinedProjects.values()) count += runs.size;
    return count;
  }

  private displayPathForNormalizedProject(normalizedProject: string): string {
    for (const running of this.runningTasks.values()) {
      if (normalizeProjectPath(running.projectPath) === normalizedProject) {
        return running.projectPath;
      }
    }
    return normalizedProject;
  }

  /**
   * Return list of currently busy projects
   */
  getBusyProjects(): string[] {
    if (this.config.allowSameProjectConcurrent) {
      const cap = this.config.maxConcurrentPerProject;
      if (cap == null) return [];
      const busy = Array.from(this.runningCountByProject().entries())
        .filter(([, count]) => count >= cap)
        .map(([project]) => this.displayPathForNormalizedProject(project));
      for (const quarantines of this.quarantinedProjects.values()) {
        const quarantine = quarantines.values().next().value as { projectPath: string } | undefined;
        if (!quarantine) continue;
        if (!busy.some((path) => normalizeProjectPath(path) === normalizeProjectPath(quarantine.projectPath))) {
          busy.push(quarantine.projectPath);
        }
      }
      return busy;
    }

    const busy = Array.from(this.runningCountByProject().keys())
      .map(project => this.displayPathForNormalizedProject(project));
    for (const quarantines of this.quarantinedProjects.values()) {
      const quarantine = quarantines.values().next().value as { projectPath: string } | undefined;
      if (!quarantine) continue;
      if (!busy.some((path) => normalizeProjectPath(path) === normalizeProjectPath(quarantine.projectPath))) {
        busy.push(quarantine.projectPath);
      }
    }
    return busy;
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
    executor: (signal: AbortSignal) => Promise<PipelineResult>,
    queuedAt?: number,
  ): boolean {
    if (this.stopping || this.paused) {
      console.warn(`[Scheduler] Refusing start while ${this.stopping ? 'stopping' : 'paused'}: ${task.title}`);
      return false;
    }
    if (this.runningTasks.has(task.id)) {
      console.warn(`[Scheduler] Refusing duplicate running task id: ${task.id}`);
      return false;
    }
    const normalizedProject = normalizeProjectPath(projectPath);
    if (!this.hasAvailableSlot()) {
      console.warn(`[Scheduler] Refusing start at global capacity: ${task.title}`);
      return false;
    }
    if (this.isProjectBusy(normalizedProject)) {
      console.warn(`[Scheduler] Refusing start at project capacity: ${projectPath}`);
      return false;
    }
    if (this.quarantinedProjects.has(normalizedProject)) {
      console.warn(`[Scheduler] Refusing start in quarantined project: ${projectPath}`);
      return false;
    }

    const runId = randomUUID();
    const abortController = new AbortController();
    let resolveTask!: (result: PipelineResult) => void;
    let rejectTask!: (error: unknown) => void;
    const promise = new Promise<PipelineResult>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });

    let settleExecutor!: () => void;
    const executorSettled = new Promise<void>((resolve) => { settleExecutor = resolve; });
    const startedAt = Date.now();
    const runningTask: RunningTask = {
      runId,
      task,
      projectPath,
      startedAt,
      abortController,
      promise,
      executorSettled,
    };

    this.runningTasks.set(task.id, runningTask);
    this.throughput.observeOccupancy(this.runningTasks.size, this.config.maxConcurrent, startedAt);
    if (queuedAt !== undefined) this.throughput.recordQueueStart(queuedAt, startedAt);
    this.unsettledExecutors.set(runId, executorSettled);
    console.log(`[Scheduler] Started task: ${task.title}`);
    this.emit('started', runningTask);

    // Hard wall-clock backstop. The logical slot is reclaimed so other repositories
    // can progress, but the repository stays quarantined until the underlying
    // executor actually settles. This closes the timeout-vs-retry mutation race;
    // the durable ledger separately fences any late state callback. (INT-2521)
    const hardTaskTimeoutMs = this.config.hardTaskTimeoutMs ?? HARD_TASK_TIMEOUT_MS;
    const watchdog = setTimeout(() => {
      const current = this.runningTasks.get(task.id);
      if (!current || current.runId !== runId) return;
      console.warn(`[Scheduler] Task "${task.title}" exceeded the ${Math.round(hardTaskTimeoutMs / 60_000)}min hard watchdog — aborting and quarantining its project`);
      const quarantines = this.quarantinedProjects.get(normalizedProject) ?? new Map();
      quarantines.set(runId, { taskId: task.id, projectPath });
      this.quarantinedProjects.set(normalizedProject, quarantines);
      abortController.abort();
      rejectTask(new Error(`Task timed out after ${hardTaskTimeoutMs}ms (scheduler hard watchdog)`));
    }, hardTaskTimeoutMs);

    // Completion handling
    runningTask.promise
      .then((result) => {
        this.handleTaskComplete(task.id, runId, result);
      })
      .catch((error) => {
        this.handleTaskError(task.id, runId, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => clearTimeout(watchdog));

    let executorPromise: Promise<PipelineResult>;
    try {
      executorPromise = Promise.resolve(executor(abortController.signal));
    } catch (error) {
      executorPromise = Promise.reject(error);
    }
    executorPromise
      .then(resolveTask, rejectTask)
      .finally(() => {
        settleExecutor();
        this.unsettledExecutors.delete(runId);
        const quarantines = this.quarantinedProjects.get(normalizedProject);
        if (quarantines?.delete(runId)) {
          if (quarantines.size === 0) {
            this.quarantinedProjects.delete(normalizedProject);
            console.log(`[Scheduler] Timed-out executor exited; project quarantine cleared: ${projectPath}`);
            if (!this.stopping) this.emit('quarantineCleared', { task, projectPath, runId });
          } else {
            console.log(`[Scheduler] Timed-out executor exited; ${quarantines.size} quarantine(s) remain: ${projectPath}`);
          }
        }
      })
      .catch(() => {
        // The wrapper promise above owns error reporting; prevent a secondary
        // unhandled rejection from this bookkeeping chain.
      });
    return true;
  }

  /**
   * Handle task completion
   */
  private handleTaskComplete(taskId: string, runId: string, result: PipelineResult): void {
    const running = this.runningTasks.get(taskId);
    if (!running || running.runId !== runId) return;

    const finishedAt = Date.now();
    this.throughput.recordResult(result, running.startedAt, finishedAt);
    this.runningTasks.delete(taskId);
    this.throughput.observeOccupancy(this.runningTasks.size, this.config.maxConcurrent, finishedAt);

    if (result.finalStatus === 'superseded') {
      // Existing in-flight work owns this scope. It is neither completed nor
      // failed; free the slot and let the runner schedule a delayed re-check.
      console.log(`[Scheduler] Task superseded: ${running.task.title}`);
      this.emit('superseded', { task: running.task, result });
    } else if (result.finalStatus === 'cancelled' || result.finalStatus === 'decomposed'
        || result.finalStatus === 'waiting_on_operator') {
      // These are coordination outcomes, not completed implementations. In
      // particular, a decomposed parent can carry success=true even though only
      // child issues were created; counting it as completed races the durable
      // child workflow and makes capacity/pace telemetry lie. A run waiting on
      // an operator decision likewise neither failed nor finished — counting it
      // failed would failure-budget a task whose only blocker is a human.
      console.log(`[Scheduler] Task ${result.finalStatus}: ${running.task.title}`);
      this.emit(result.finalStatus, { task: running.task, result });
    } else if (result.success) {
      this.completedCount++;
      console.log(`[Scheduler] Task completed: ${running.task.title}`);
      this.emit('completed', { task: running.task, result });
    } else {
      this.failedCount++;
      console.log(`[Scheduler] Task failed: ${running.task.title}`);
      this.emit('failed', { task: running.task, result });
    }

    // Trigger next task execution
    if (!this.stopping) this.emit('slotFreed');
  }

  /**
   * Handle task error
   */
  private handleTaskError(taskId: string, runId: string, error: Error): void {
    const running = this.runningTasks.get(taskId);
    if (!running || running.runId !== runId) return;

    const finishedAt = Date.now();
    this.throughput.recordError(running.startedAt, finishedAt);
    this.runningTasks.delete(taskId);
    this.throughput.observeOccupancy(this.runningTasks.size, this.config.maxConcurrent, finishedAt);
    this.failedCount++;

    console.error(`[Scheduler] Task error: ${running.task.title}`, error.message);
    if (this.listenerCount('error') > 0) {
      this.emit('error', {
        task: running.task,
        error,
        startedAt: running.startedAt,
        projectPath: running.projectPath,
      });
    }
    if (!this.stopping) this.emit('slotFreed');
  }

  /**
   * Execute all available tasks from queue
   * @param executor Task execution function
   */
  async runAvailable(
    executor: (task: TaskItem, projectPath: string, signal: AbortSignal) => Promise<PipelineResult>
  ): Promise<number> {
    let started = 0;

    console.log(`[Scheduler] runAvailable: paused=${this.paused}, running=${this.runningTasks.size}/${this.config.maxConcurrent}, queue=${this.taskQueue.length}, worktreeMode=${this.config.worktreeMode}, perProject=${this.config.maxConcurrentPerProject ?? 'unlimited'}`);

    while (this.hasAvailableSlot()) {
      const next = this.getNextExecutable();
      if (!next) {
        console.log(`[Scheduler] runAvailable: no more executable tasks (queue=${this.taskQueue.length})`);
        break;
      }

      const didStart = this.startTask(
        next.task,
        next.projectPath,
        (signal) => executor(next.task, next.projectPath, signal),
        next.queuedAt,
      );
      if (didStart) started++;
      else {
        this.taskQueue.unshift(next);
        break;
      }
    }

    console.log(`[Scheduler] runAvailable: started ${started} tasks`);
    return started;
  }

  /** Record the current pipeline stage of a running task (dashboard process view). */
  setTaskStage(taskId: string, stage: string): void {
    const running = this.runningTasks.get(taskId);
    if (running) running.stage = stage;
  }

  /**
   * Cancel one running task — aborts its pipeline + in-flight adapter call. The
   * pipeline returns a 'cancelled' result and its worktree is cleaned up by the
   * executor's finally block. Returns true if the task was running.
   */
  cancelTask(taskId: string): boolean {
    const running = this.runningTasks.get(taskId);
    if (!running) return false;
    console.log(`[Scheduler] Cancelling task: ${running.task.title}`);
    running.abortController.abort();
    return true;
  }

  /**
   * Cancel every running task belonging to a project (e.g. when the project is
   * disabled). Matches by repo path or worktree-path prefix. Returns the count.
   */
  cancelProjectTasks(projectPath: string): number {
    let n = 0;
    for (const running of this.runningTasks.values()) {
      const p = running.projectPath;
      if (isSameProjectOrDescendant(p, projectPath)) {
        running.abortController.abort();
        n++;
      }
    }
    if (n > 0) console.log(`[Scheduler] Cancelled ${n} running task(s) for ${projectPath}`);
    return n;
  }

  /**
   * Wait for all running tasks to complete
   */
  async waitAll(): Promise<PipelineResult[]> {
    const promises = Array.from(this.runningTasks.values()).map((r) => r.promise);
    const settled = await Promise.allSettled(promises);
    return settled
      .filter((result): result is PromiseFulfilledResult<PipelineResult> => result.status === 'fulfilled')
      .map((result) => result.value);
  }

  /** Wait to a fixed point for underlying executor processes, including ones
   * whose watchdog already reclaimed their logical scheduler slot. */
  async waitForExecutorExit(): Promise<void> {
    while (this.unsettledExecutors.size > 0) {
      await Promise.allSettled(this.unsettledExecutors.values());
    }
  }

  getUnsettledExecutorCount(): number {
    return this.unsettledExecutors.size;
  }

  /**
   * Stop admitting work, abort all executors, and wait up to `graceMs` for real
   * executor exit. A timed-out executor remains quarantined and can no longer
   * race a replacement in the same repository.
   */
  async shutdown(graceMs = 30_000): Promise<{ drained: boolean; remaining: number; quarantined: number; discardedQueue: QueuedTask[] }> {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('graceMs must be a non-negative finite number');
    this.stopping = true;
    this.paused = true;
    // Snapshotted in the same synchronous block that sets stopping and clears
    // the queue — none of these tasks can ever start after this point, so a
    // caller can safely roll back their external claims (Linear In Progress
    // from explicit dispatch) without racing a freed slot. (INT-3388)
    const discardedQueue = [...this.taskQueue];
    this.clearQueue();

    const running = Array.from(this.runningTasks.values());
    for (const task of running) task.abortController.abort();
    if (this.unsettledExecutors.size > 0 && graceMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.waitForExecutorExit(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
      ]);
      if (timer) clearTimeout(timer);
      // Let the completion/error handlers remove their matching run generation.
      await Promise.resolve();
    }

    return {
      drained: this.unsettledExecutors.size === 0 && this.runningTasks.size === 0 && this.quarantinedProjects.size === 0,
      remaining: this.unsettledExecutors.size,
      quarantined: this.quarantinedExecutorCount(),
      discardedQueue,
    };
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
    if (this.stopping) {
      console.warn('[Scheduler] Resume ignored: scheduler is stopping');
      return;
    }
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
    const now = Date.now();
    const byProject = new Map<string, number>();

    for (const running of this.runningTasks.values()) {
      const count = byProject.get(running.projectPath) || 0;
      byProject.set(running.projectPath, count + 1);
    }

    const hasGlobalSlot = !this.stopping && this.runningTasks.size < this.config.maxConcurrent;
    const runningByProject = this.runningCountByProject();
    let runnableQueued = 0;
    let blockedByProjectCapacity = 0;
    let blockedByQuarantine = 0;
    let oldestQueuedAgeMs = 0;
    for (const queued of this.taskQueue) {
      oldestQueuedAgeMs = Math.max(oldestQueuedAgeMs, now - queued.queuedAt);
      const project = normalizeProjectPath(queued.projectPath);
      if (this.quarantinedProjects.has(project)) {
        blockedByQuarantine += 1;
        continue;
      }
      const runningCount = runningByProject.get(project) ?? 0;
      const projectBlocked = this.config.allowSameProjectConcurrent
        ? this.config.maxConcurrentPerProject != null && runningCount >= this.config.maxConcurrentPerProject
        : runningCount > 0;
      if (projectBlocked) blockedByProjectCapacity += 1;
      else if (hasGlobalSlot) runnableQueued += 1;
    }

    const throughput = this.throughput.snapshot({
      running: this.runningTasks.size,
      maxConcurrent: this.config.maxConcurrent,
      availableSlots: this.getAvailableSlots(),
      runnableQueued,
      blockedByGlobalCapacity: hasGlobalSlot ? 0 : this.taskQueue.length,
      blockedByProjectCapacity,
      blockedByQuarantine,
      oldestQueuedAgeMs,
    }, now);

    return {
      queued: this.taskQueue.length,
      running: this.runningTasks.size,
      completed: this.completedCount,
      failed: this.failedCount,
      quarantined: this.quarantinedExecutorCount(),
      byProject,
      throughput,
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
    const now = Date.now();
    this.throughput.observeOccupancy(this.runningTasks.size, this.config.maxConcurrent, now);
    this.config = normalizeSchedulerConfig({ ...this.config, ...config });
    this.throughput.observeOccupancy(this.runningTasks.size, this.config.maxConcurrent, now);
    console.log('[Scheduler] Config updated:', this.config);
  }
}

// Singleton

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
