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

// Re-export integration setters (used by service.ts)
export { setDiscordReporter, setLinearFetcher } from './runnerExecution.js';

// ============================================
// Types
// ============================================

export interface AutonomousConfig {
  /** Linear 팀 ID */
  linearTeamId: string;

  /** 허용된 프로젝트 경로 */
  allowedProjects: string[];

  /** Heartbeat 간격 (cron 또는 interval) */
  heartbeatSchedule: string;

  /** 자동 실행 (false면 승인 필요) */
  autoExecute: boolean;

  /** Discord 채널 ID (보고용) */
  discordChannelId?: string;

  /** 최대 연속 작업 수 */
  maxConsecutiveTasks: number;

  /** 작업 간 쿨다운 (초) */
  cooldownSeconds: number;

  /** Dry run 모드 */
  dryRun: boolean;

  /** Worker/Reviewer 페어 모드 */
  pairMode?: boolean;

  /** 페어 모드 최대 시도 횟수 */
  pairMaxAttempts?: number;

  /** Worker 모델 (레거시) */
  workerModel?: string;

  /** Reviewer 모델 (레거시) */
  reviewerModel?: string;

  /** Worker 타임아웃 (ms) (레거시) */
  workerTimeoutMs?: number;

  /** Reviewer 타임아웃 (ms) (레거시) */
  reviewerTimeoutMs?: number;

  /** 시작 시 즉시 실행 */
  triggerNow?: boolean;

  /** 동시 실행 가능한 최대 태스크 수 */
  maxConcurrentTasks?: number;

  /** 기본 역할 설정 */
  defaultRoles?: DefaultRolesConfig;

  /** 프로젝트별 에이전트 설정 */
  projectAgents?: ProjectAgentConfig[];

  /** 작업 분해 활성화 */
  enableDecomposition?: boolean;

  /** 작업 분해 기준 시간 (분, 기본 30분) */
  decompositionThresholdMinutes?: number;

  /** Planner 모델 */
  plannerModel?: string;
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

    // TaskScheduler 초기화
    this.scheduler = initScheduler({
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: false,
    });

    // 스케줄러 이벤트 핸들링
    this.setupSchedulerEvents();
  }

  /**
   * 스케줄러 이벤트 설정
   */
  private setupSchedulerEvents(): void {
    this.scheduler.on('started', async (running) => {
      console.log(`[Scheduler] Task started: ${running.task.title}`);
    });

    this.scheduler.on('completed', async ({ task, result }) => {
      console.log(`[Scheduler] Task completed: ${task.title}`);
      await reportToDiscord(formatPipelineResult(result));

      // 성공 시 Linear 이슈를 Done으로 업데이트
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
      console.log(`[Scheduler] Task failed: ${task.title}`);
      await reportToDiscord(formatPipelineResult(result));

      // rejected 상태면 Blocked로 변경
      if (task.issueId && result.finalStatus === 'rejected') {
        try {
          await linear.logBlocked(task.issueId, 'autonomous-runner',
            `리뷰 거부됨: ${result.reviewResult?.feedback || '상세 정보 없음'}`
          );
          console.log(`[Scheduler] Issue ${task.issueId} marked as Blocked (rejected)`);
        } catch (err) {
          console.error(`[Scheduler] Failed to update issue state:`, err);
        }
      }
      // failed인 경우 In Progress 유지 (다음 heartbeat에서 재시도)
    });

    this.scheduler.on('error', async ({ task, error }) => {
      console.error(`[Scheduler] Task error: ${task.title}`, error);
      await reportToDiscord(`❌ **파이프라인 에러**: ${task.title}\n\`\`\`${error.message}\`\`\``);
    });

    this.scheduler.on('slotFreed', () => {
      // 슬롯이 비면 다음 태스크 자동 실행
      void this.runAvailableTasks();
    });
  }

  /**
   * 사용 가능한 슬롯에 태스크 실행
   */
  private async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // 병렬 처리 비활성화
    }

    await this.scheduler.runAvailable(async (task, projectPath) => {
      return this.executePipeline(task, projectPath);
    });
  }

  /**
   * 프로젝트별 역할 설정 가져오기
   */
  private getRolesForProject(projectPath: string): DefaultRolesConfig | undefined {
    // 프로젝트별 설정 찾기
    const projectConfig = this.config.projectAgents?.find(
      pa => projectPath.includes(pa.projectPath.replace('~', ''))
    );

    if (!projectConfig?.roles && !this.config.defaultRoles) {
      // 레거시 설정에서 변환
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

    // 프로젝트별 오버라이드 적용
    const base = this.config.defaultRoles || {
      worker: { enabled: true, model: 'claude-sonnet-4-20250514', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'claude-3-5-haiku-20241022', timeoutMs: 0 },
    };

    if (!projectConfig?.roles) {
      return base;
    }

    // 오버라이드 병합
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
   * Runner 시작
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[AutonomousRunner] Already running');
      return;
    }

    await this.engine.init();

    // Cron job 설정
    this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
      await this.heartbeat();
    });

    this.state.isRunning = true;
    console.log(`[AutonomousRunner] Started with schedule: ${this.config.heartbeatSchedule}`);

    await reportToDiscord(`🤖 **자율 실행 모드 시작**\n` +
      `Schedule: \`${this.config.heartbeatSchedule}\`\n` +
      `Auto-execute: ${this.config.autoExecute ? '✅' : '❌ (승인 필요)'}\n` +
      `Projects: ${this.config.allowedProjects.join(', ')}`
    );

    // 즉시 실행 옵션
    if (this.config.triggerNow) {
      console.log('[AutonomousRunner] Triggering immediate heartbeat in 10s...');
      setTimeout(() => void this.heartbeat(), 10000); // 10초 후 실행 (Discord/Linear 연결 대기)
    }
  }

  /**
   * Runner 중지
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
   * Heartbeat 실행
   */
  async heartbeat(): Promise<void> {
    console.log('[AutonomousRunner] Heartbeat triggered');
    this.state.lastHeartbeat = Date.now();

    try {
      // 1. 시간 윈도우 체크
      const timeCheck = checkWorkAllowed();
      if (!timeCheck.allowed) {
        console.log(`[AutonomousRunner] Blocked: ${timeCheck.reason}`);
        return;
      }

      // 2. Linear에서 작업 가져오기
      const tasks = await fetchLinearTasks();
      if (tasks.length === 0) {
        console.log('[AutonomousRunner] No tasks in backlog');
        return;
      }

      console.log(`[AutonomousRunner] Found ${tasks.length} tasks`);

      // 병렬 처리 모드
      if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1 && this.config.pairMode) {
        await this.heartbeatParallel(tasks);
        return;
      }

      // 3. Decision Engine 실행 (단일 태스크)
      console.log('[AutonomousRunner] Calling DecisionEngine.heartbeat...');
      const decision = await this.engine.heartbeat(tasks);
      console.log(`[AutonomousRunner] Decision: action=${decision.action}, reason=${decision.reason}`);
      this.state.lastDecision = decision;

      // 4. 결정에 따른 처리
      console.log('[AutonomousRunner] Calling handleDecision...');
      await this.handleDecision(decision);
      console.log('[AutonomousRunner] handleDecision completed');

      this.state.consecutiveErrors = 0;

    } catch (error: any) {
      this.state.consecutiveErrors++;
      console.error('[AutonomousRunner] Heartbeat error:', error.message);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(`⚠️ **자율 실행 오류** (연속 ${this.state.consecutiveErrors}회)\n` +
          `\`\`\`${error.message}\`\`\``
        );
      }
    }
  }

  /**
   * 병렬 처리 Heartbeat (DecisionEngine.heartbeatMultiple 사용)
   */
  private async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
    console.log(`[AutonomousRunner] Parallel heartbeat: ${tasks.length} tasks`);

    const availableSlots = this.scheduler.getAvailableSlots();
    if (availableSlots === 0) {
      console.log('[AutonomousRunner] No available slots');
      return;
    }

    // 이미 실행 중인 프로젝트 목록 가져오기
    const busyProjects = this.scheduler.getBusyProjects();

    // DecisionEngine에서 검증된 태스크 목록 가져오기
    const decision = await this.engine.heartbeatMultiple(
      tasks,
      availableSlots,
      busyProjects
    );

    if (decision.action === 'skip' || decision.action === 'defer') {
      console.log(`[AutonomousRunner] Decision: ${decision.action} - ${decision.reason}`);
      return;
    }

    // 검증된 태스크들을 큐에 추가
    let enqueuedCount = 0;
    for (const { task } of decision.tasks) {
      // 이미 큐에 있거나 실행 중이면 스킵
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);

      // 프로젝트 경로 매핑 실패 시 스킵
      if (!projectPath) {
        console.error(`[AutonomousRunner] Skipping task "${task.title}" - project path not resolved`);
        continue;
      }

      // 프로젝트가 이미 작업 중이면 스킵 (이중 체크)
      if (this.scheduler.isProjectBusy(projectPath)) {
        console.log(`[AutonomousRunner] Project busy: ${projectPath}`);
        continue;
      }

      this.scheduler.enqueue(task, projectPath);
      enqueuedCount++;
    }

    console.log(`[AutonomousRunner] Enqueued ${enqueuedCount} tasks (skipped: ${decision.skippedCount})`);

    // 태스크 실행
    await this.runAvailableTasks();
  }

  /**
   * 결정 처리
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
   * 작업 실행
   */
  private async executeTask(task: TaskItem, workflow: any): Promise<void> {
    console.log(`[AutonomousRunner] executeTask called, pairMode=${this.config.pairMode}`);
    // 페어 모드면 페어 실행
    if (this.config.pairMode) {
      console.log('[AutonomousRunner] Calling executeTaskPairMode...');
      await this.executeTaskPairMode(task);
      console.log('[AutonomousRunner] executeTaskPairMode completed');
      return;
    }

    // 시작 보고
    const projectInfo = task.linearProject?.name
      ? `📁 **${task.linearProject.name}**\n`
      : '';
    const issueRef = task.issueIdentifier || task.issueId || 'N/A';

    const startEmbed = new EmbedBuilder()
      .setTitle('🚀 작업 시작')
      .setColor(0x00AE86)
      .addFields(
        { name: '작업', value: `${projectInfo}${task.title}`, inline: false },
        { name: 'Issue', value: issueRef, inline: true },
        { name: 'Priority', value: `P${task.priority}`, inline: true },
        { name: 'Steps', value: `${workflow.steps?.length || '?'}`, inline: true },
      )
      .setTimestamp();

    await reportToDiscord(startEmbed);

    // 파싱 결과가 있으면 표시
    if (task.issueId) {
      const parsed = await loadParsedTask(task.issueId);
      if (parsed) {
        const summary = formatParsedTaskSummary(parsed);
        await reportToDiscord(`📋 **분석 결과**\n${summary.slice(0, 1500)}`);
      }
    }

    // 실행
    const result = await this.engine.executeTask(task, workflow);
    this.state.lastExecution = result;

    // 결과 보고
    await this.reportExecutionResult(task, result);
  }

  /**
   * 페어 모드로 작업 실행 (Worker/Reviewer 루프)
   * 레거시 방식 - 병렬 처리 없이 단일 태스크만 처리
   */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    console.log('[AutonomousRunner] executeTaskPairMode started');

    // 프로젝트 경로 자동 탐색
    const projectPath = await this.resolveProjectPath(task);

    // 프로젝트 경로 매핑 실패 시 에러
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      await reportToDiscord(`❌ **프로젝트 매핑 실패**: ${task.title}\n프로젝트: ${task.linearProject?.name || 'unknown'}`);
      return;
    }

    console.log(`[AutonomousRunner] projectPath: ${projectPath}`);

    // 작업 분해 체크 (enableDecomposition 설정 시)
    if (this.config.enableDecomposition) {
      const threshold = this.config.decompositionThresholdMinutes ?? 30;
      const needsDecomp = planner.needsDecomposition(task, threshold);

      if (needsDecomp) {
        console.log(`[AutonomousRunner] Task "${task.title}" needs decomposition (>${threshold}min estimated)`);
        const decomposed = await this.decomposeTask(task, projectPath, threshold);
        if (decomposed) {
          // 분해 성공 - sub-tasks가 큐에 추가됨, 원본 태스크는 실행하지 않음
          return;
        }
        // 분해 실패 - 원본 태스크 그대로 실행
        console.log('[AutonomousRunner] Decomposition failed, executing original task');
      }
    }

    // 병렬 처리 모드면 스케줄러 사용
    if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1) {
      this.scheduler.enqueue(task, projectPath);
      await this.runAvailableTasks();
      return;
    }

    // 단일 실행 (레거시)
    const result = await this.executePipeline(task, projectPath);
    await reportToDiscord(formatPipelineResult(result));

    // Linear 이슈 상태 업데이트
    if (task.issueId) {
      try {
        if (result.success) {
          // 성공 시 Done으로 이동
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
          // 리뷰 거부 시 Blocked로 변경
          await linear.logBlocked(task.issueId, 'autonomous-runner',
            `리뷰 거부됨: ${result.reviewResult?.feedback || '상세 정보 없음'}`
          );
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Blocked (rejected)`);
        }
        // failed인 경우 In Progress 유지 (다음 heartbeat에서 재시도)
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
   * 수동 승인
   */
  async approve(): Promise<boolean> {
    if (!this.state.pendingApproval) {
      return false;
    }

    const task = this.state.pendingApproval;
    this.state.pendingApproval = undefined;

    // Decision Engine에서 워크플로우 가져오기
    const decision = await this.engine.heartbeat([task]);
    if (decision.workflow && decision.task) {
      await this.executeTask(decision.task, decision.workflow);
      return true;
    }

    return false;
  }

  /**
   * 수동 거부
   */
  reject(): boolean {
    if (!this.state.pendingApproval) {
      return false;
    }

    this.state.pendingApproval = undefined;
    return true;
  }

  /**
   * 즉시 실행 (수동 트리거)
   */
  async runNow(): Promise<void> {
    await this.heartbeat();
  }

  /**
   * 상태 조회
   */
  getState(): RunnerState {
    return { ...this.state };
  }

  /**
   * 통계 조회
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
   * 스케줄러 일시 정지
   */
  pauseScheduler(): void {
    this.scheduler.pause();
  }

  /**
   * 스케줄러 재개
   */
  resumeScheduler(): void {
    this.scheduler.resume();
  }

  /**
   * 대기 중인 태스크 목록
   */
  getQueuedTasks() {
    return this.scheduler.getQueuedTasks();
  }

  /**
   * 실행 중인 태스크 목록
   */
  getRunningTasks() {
    return this.scheduler.getRunningTasks();
  }
}

// ============================================
// Singleton & Convenience Functions
// ============================================

/**
 * Runner 인스턴스 가져오기
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
 * Runner 시작 (간편 함수)
 */
export async function startAutonomous(config: AutonomousConfig): Promise<AutonomousRunner> {
  const runner = getRunner(config);
  await runner.start();
  return runner;
}

/**
 * Runner 중지 (간편 함수)
 */
export function stopAutonomous(): void {
  if (runnerInstance) {
    runnerInstance.stop();
  }
}
