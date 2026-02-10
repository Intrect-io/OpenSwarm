// ============================================
// Claude Swarm - Task Scheduler
// 병렬 태스크 스케줄링 및 실행 관리
// ============================================

import { EventEmitter } from 'node:events';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from './pairPipeline.js';

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
  /** 동시 실행 가능한 최대 태스크 수 */
  maxConcurrent: number;
  /** 같은 프로젝트 동시 실행 허용 */
  allowSameProjectConcurrent?: boolean;
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
   * 태스크를 큐에 추가
   */
  enqueue(task: TaskItem, projectPath: string): void {
    // 중복 체크
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

    // 우선순위에 따라 삽입
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
   * 태스크가 큐에 있는지 확인
   */
  isTaskQueued(taskId: string): boolean {
    return this.taskQueue.some((t) => t.task.id === taskId);
  }

  /**
   * 태스크가 실행 중인지 확인
   */
  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * 큐에서 태스크 제거
   */
  dequeue(taskId: string): boolean {
    const idx = this.taskQueue.findIndex((t) => t.task.id === taskId);
    if (idx === -1) return false;

    this.taskQueue.splice(idx, 1);
    return true;
  }

  /**
   * 큐 비우기
   */
  clearQueue(): void {
    this.taskQueue = [];
    console.log('[Scheduler] Queue cleared');
  }

  // ============================================
  // Slot Management
  // ============================================

  /**
   * 사용 가능한 슬롯이 있는지 확인
   */
  hasAvailableSlot(): boolean {
    return this.runningTasks.size < this.config.maxConcurrent;
  }

  /**
   * 사용 가능한 슬롯 수
   */
  getAvailableSlots(): number {
    return Math.max(0, this.config.maxConcurrent - this.runningTasks.size);
  }

  /**
   * 프로젝트가 현재 작업 중인지 확인
   */
  isProjectBusy(projectPath: string): boolean {
    if (this.config.allowSameProjectConcurrent) {
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
   * 현재 작업 중인 프로젝트 목록 반환
   */
  getBusyProjects(): string[] {
    if (this.config.allowSameProjectConcurrent) {
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
   * 다음 실행 가능한 태스크 가져오기
   */
  getNextExecutable(): QueuedTask | null {
    if (this.paused || !this.hasAvailableSlot()) {
      return null;
    }

    for (let i = 0; i < this.taskQueue.length; i++) {
      const queued = this.taskQueue[i];

      // 프로젝트 중복 체크
      if (this.isProjectBusy(queued.projectPath)) {
        continue;
      }

      // 실행 가능
      this.taskQueue.splice(i, 1);
      return queued;
    }

    return null;
  }

  /**
   * 태스크 실행 시작
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

    // 완료 처리
    runningTask.promise
      .then((result) => {
        this.handleTaskComplete(task.id, result);
      })
      .catch((error) => {
        this.handleTaskError(task.id, error);
      });
  }

  /**
   * 태스크 완료 처리
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

    // 다음 태스크 실행 트리거
    this.emit('slotFreed');
  }

  /**
   * 태스크 에러 처리
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
   * 큐에서 실행 가능한 모든 태스크 실행
   * @param executor 태스크 실행 함수
   */
  async runAvailable(
    executor: (task: TaskItem, projectPath: string) => Promise<PipelineResult>
  ): Promise<number> {
    let started = 0;

    while (this.hasAvailableSlot()) {
      const next = this.getNextExecutable();
      if (!next) break;

      this.startTask(next.task, next.projectPath, () =>
        executor(next.task, next.projectPath)
      );
      started++;
    }

    return started;
  }

  /**
   * 모든 실행 중인 태스크 완료 대기
   */
  async waitAll(): Promise<PipelineResult[]> {
    const promises = Array.from(this.runningTasks.values()).map((r) => r.promise);
    return Promise.all(promises);
  }

  // ============================================
  // Control
  // ============================================

  /**
   * 스케줄러 일시 정지
   */
  pause(): void {
    this.paused = true;
    console.log('[Scheduler] Paused');
    this.emit('paused');
  }

  /**
   * 스케줄러 재개
   */
  resume(): void {
    this.paused = false;
    console.log('[Scheduler] Resumed');
    this.emit('resumed');
  }

  /**
   * 일시 정지 상태인지 확인
   */
  isPaused(): boolean {
    return this.paused;
  }

  // ============================================
  // Stats & Info
  // ============================================

  /**
   * 현재 상태 조회
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
   * 큐에 있는 태스크 목록
   */
  getQueuedTasks(): QueuedTask[] {
    return [...this.taskQueue];
  }

  /**
   * 실행 중인 태스크 목록
   */
  getRunningTasks(): RunningTask[] {
    return Array.from(this.runningTasks.values());
  }

  /**
   * 설정 업데이트
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
 * 스케줄러 인스턴스 가져오기
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
 * 스케줄러 초기화
 */
export function initScheduler(config: SchedulerConfig): TaskScheduler {
  schedulerInstance = new TaskScheduler(config);
  return schedulerInstance;
}

/**
 * 스케줄러 리셋 (테스트용)
 */
export function resetScheduler(): void {
  schedulerInstance = null;
}
