// ============================================
// Claude Swarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
// ============================================

import { Cron } from 'croner';
import {
  DecisionEngine,
  DecisionResult,
  TaskItem,
  linearIssueToTask,
  getDecisionEngine,
} from './decisionEngine.js';
import { runWorkflowConfig, ExecutorResult } from './workflowExecutor.js';
import { checkWorkAllowed, getTimeWindowSummary } from './timeWindow.js';
import { parseTask, formatParsedTaskSummary, loadParsedTask } from './taskParser.js';
import { saveCognitiveMemory } from './memory.js';
import { EmbedBuilder } from 'discord.js';

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
// Discord Reporter
// ============================================

type DiscordSendFn = (content: string | { embeds: EmbedBuilder[] }) => Promise<void>;

let discordSend: DiscordSendFn | null = null;

/**
 * Discord 보고 함수 등록
 */
export function setDiscordReporter(sendFn: DiscordSendFn): void {
  discordSend = sendFn;
  console.log('[AutonomousRunner] Discord reporter registered');
}

/**
 * Discord로 메시지 보내기
 */
async function reportToDiscord(message: string | EmbedBuilder): Promise<void> {
  if (!discordSend) {
    console.log('[AutonomousRunner] No Discord reporter, logging instead:',
      typeof message === 'string' ? message : message.data.title);
    return;
  }

  try {
    if (typeof message === 'string') {
      await discordSend(message);
    } else {
      await discordSend({ embeds: [message] });
    }
  } catch (error) {
    console.error('[AutonomousRunner] Discord report failed:', error);
  }
}

// ============================================
// Linear Integration
// ============================================

type LinearFetchFn = () => Promise<TaskItem[]>;

let linearFetch: LinearFetchFn | null = null;

/**
 * Linear 이슈 조회 함수 등록
 */
export function setLinearFetcher(fetchFn: LinearFetchFn): void {
  linearFetch = fetchFn;
  console.log('[AutonomousRunner] Linear fetcher registered');
}

/**
 * Linear에서 할당된 이슈 가져오기
 */
async function fetchLinearTasks(): Promise<TaskItem[]> {
  if (!linearFetch) {
    console.log('[AutonomousRunner] No Linear fetcher registered');
    return [];
  }

  try {
    return await linearFetch();
  } catch (error) {
    console.error('[AutonomousRunner] Linear fetch failed:', error);
    return [];
  }
}

// ============================================
// Autonomous Runner
// ============================================

let runnerInstance: AutonomousRunner | null = null;

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
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

      // 3. Decision Engine 실행
      const decision = await this.engine.heartbeat(tasks);
      this.state.lastDecision = decision;

      // 4. 결정에 따른 처리
      await this.handleDecision(decision);

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
   * 결정 처리
   */
  private async handleDecision(decision: DecisionResult): Promise<void> {
    switch (decision.action) {
      case 'execute':
        if (decision.task && decision.workflow) {
          await this.executeTask(decision.task, decision.workflow);
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
    // 시작 보고
    const startEmbed = new EmbedBuilder()
      .setTitle('🚀 작업 시작')
      .setColor(0x00AE86)
      .addFields(
        { name: '작업', value: task.title, inline: false },
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
   * 승인 요청
   */
  private async requestApproval(decision: DecisionResult): Promise<void> {
    if (!decision.task) return;

    const embed = new EmbedBuilder()
      .setTitle('⏳ 승인 대기')
      .setColor(0xFFA500)
      .setDescription(`다음 작업을 실행할까요?\n\n**${decision.task.title}**`)
      .addFields(
        { name: 'Issue', value: decision.task.issueId || 'N/A', inline: true },
        { name: 'Priority', value: `P${decision.task.priority}`, inline: true },
        { name: '사유', value: decision.reason, inline: false },
      )
      .setFooter({ text: '!approve 또는 !reject 로 응답' })
      .setTimestamp();

    await reportToDiscord(embed);

    // 파싱 결과도 같이 표시
    if (decision.task.issueId) {
      const parsed = await loadParsedTask(decision.task.issueId);
      if (parsed) {
        const summary = formatParsedTaskSummary(parsed);
        await reportToDiscord(`\`\`\`\n${summary.slice(0, 1800)}\n\`\`\``);
      }
    }
  }

  /**
   * 실행 결과 보고
   */
  private async reportExecutionResult(task: TaskItem, result: ExecutorResult): Promise<void> {
    const duration = (result.duration / 1000).toFixed(1);
    const stepCount = Object.keys(result.execution.stepResults).length;
    const completedCount = Object.values(result.execution.stepResults)
      .filter(r => r.status === 'completed').length;

    if (result.success) {
      const embed = new EmbedBuilder()
        .setTitle('✅ 작업 완료')
        .setColor(0x00FF00)
        .addFields(
          { name: '작업', value: task.title, inline: false },
          { name: '소요 시간', value: `${duration}s`, inline: true },
          { name: '완료 Step', value: `${completedCount}/${stepCount}`, inline: true },
        )
        .setTimestamp();

      await reportToDiscord(embed);

      // Memory에 성공 기록
      await saveCognitiveMemory('strategy',
        `Autonomous execution succeeded: "${task.title}"`,
        { confidence: 0.8, derivedFrom: task.issueId }
      );

    } else {
      const embed = new EmbedBuilder()
        .setTitle('❌ 작업 실패')
        .setColor(0xFF0000)
        .addFields(
          { name: '작업', value: task.title, inline: false },
          { name: '실패 Step', value: result.failedStep || 'Unknown', inline: true },
          { name: 'Rollback', value: result.rollbackPerformed ? '✅' : '❌', inline: true },
        )
        .setTimestamp();

      await reportToDiscord(embed);

      // 상세 에러 정보
      const failedStepResult = result.execution.stepResults[result.failedStep || ''];
      if (failedStepResult?.error) {
        await reportToDiscord(`\`\`\`\n${failedStepResult.error.slice(0, 1500)}\n\`\`\``);
      }
    }
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
  } {
    return {
      isRunning: this.state.isRunning,
      lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(),
      pendingApproval: !!this.state.pendingApproval,
    };
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
