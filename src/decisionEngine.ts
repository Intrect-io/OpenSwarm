// ============================================
// Claude Swarm - Decision Engine
// 자율 행동 범위 제한 및 작업 결정
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import {
  WorkflowConfig,
  loadWorkflow,
  listWorkflows,
  createCIPipelineTemplate,
} from './workflow.js';
import { parseTask, saveParsedTask, loadParsedTask, formatParsedTaskSummary } from './taskParser.js';
import { runWorkflowConfig, ExecutorResult } from './workflowExecutor.js';
import { checkWorkAllowed } from './timeWindow.js';
import { searchMemory, saveCognitiveMemory } from './memory.js';

// ============================================
// Types
// ============================================

/**
 * 작업 소스
 */
export type TaskSource = 'linear' | 'local' | 'discovered';

/**
 * Linear 프로젝트 정보 (간략)
 */
export interface LinearProject {
  id: string;
  name: string;
}

/**
 * 작업 아이템
 */
export interface TaskItem {
  id: string;
  source: TaskSource;
  title: string;
  description?: string;
  priority: number;        // 1=Urgent, 2=High, 3=Normal, 4=Low
  projectPath?: string;    // 로컬 파일시스템 경로
  linearProject?: LinearProject;  // Linear 프로젝트 정보
  issueId?: string;        // Linear issue ID
  issueIdentifier?: string; // Linear issue identifier (예: LIN-123)
  workflowId?: string;     // 매핑된 워크플로우
  createdAt: number;
  dueDate?: number;
  blockedBy?: string[];    // 다른 task IDs
}

/**
 * 결정 결과
 */
export interface DecisionResult {
  action: 'execute' | 'skip' | 'defer' | 'add_to_backlog';
  task?: TaskItem;
  reason: string;
  workflow?: WorkflowConfig;
}

/**
 * 발견된 작업 (Backlog 추가용)
 */
export interface DiscoveredTask {
  title: string;
  description: string;
  source: string;          // 어디서 발견했는지
  suggestedPriority: number;
  projectPath?: string;
}

/**
 * Decision Engine 설정
 */
export interface DecisionEngineConfig {
  /** 허용된 프로젝트 경로 목록 */
  allowedProjects: string[];

  /** Linear 팀 ID */
  linearTeamId?: string;

  /** 자동 실행 허용 */
  autoExecute: boolean;

  /** 최대 연속 작업 수 */
  maxConsecutiveTasks: number;

  /** 작업 간 쿨다운 (초) */
  cooldownSeconds: number;

  /** Dry run 모드 */
  dryRun: boolean;
}

// ============================================
// Constants
// ============================================

const ENGINE_STATE_FILE = resolve(homedir(), '.claude-swarm/decision-engine-state.json');
const DISCOVERED_TASKS_FILE = resolve(homedir(), '.claude-swarm/discovered-tasks.json');

const DEFAULT_CONFIG: DecisionEngineConfig = {
  allowedProjects: [],
  autoExecute: false,       // 기본은 수동 승인
  maxConsecutiveTasks: 3,
  cooldownSeconds: 300,     // 5분
  dryRun: false,
};

// ============================================
// Engine State
// ============================================

interface EngineState {
  lastRunAt: number;
  consecutiveTasksRun: number;
  lastTaskId?: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
}

async function loadState(): Promise<EngineState> {
  try {
    const content = await fs.readFile(ENGINE_STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      lastRunAt: 0,
      consecutiveTasksRun: 0,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    };
  }
}

async function saveState(state: EngineState): Promise<void> {
  await fs.mkdir(resolve(homedir(), '.claude-swarm'), { recursive: true });
  await fs.writeFile(ENGINE_STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================
// Decision Engine
// ============================================

export class DecisionEngine {
  private config: DecisionEngineConfig;
  private state: EngineState = {
    lastRunAt: 0,
    consecutiveTasksRun: 0,
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
  };

  constructor(config: Partial<DecisionEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 초기화
   */
  async init(): Promise<void> {
    this.state = await loadState();
    console.log('[DecisionEngine] Initialized');
  }

  /**
   * Heartbeat 실행 - 메인 진입점
   */
  async heartbeat(tasks: TaskItem[]): Promise<DecisionResult> {
    console.log('[DecisionEngine] Heartbeat triggered');

    // 1. 시간 윈도우 체크
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      return {
        action: 'skip',
        reason: `Time window blocked: ${timeCheck.reason}`,
      };
    }

    // 2. 쿨다운 체크
    const now = Date.now();
    const timeSinceLastRun = (now - this.state.lastRunAt) / 1000;
    if (timeSinceLastRun < this.config.cooldownSeconds) {
      return {
        action: 'defer',
        reason: `Cooldown: ${Math.ceil(this.config.cooldownSeconds - timeSinceLastRun)}s remaining`,
      };
    }

    // 3. 연속 작업 제한 체크
    if (this.state.consecutiveTasksRun >= this.config.maxConsecutiveTasks) {
      console.log('[DecisionEngine] Max consecutive tasks reached, resetting');
      this.state.consecutiveTasksRun = 0;
      await saveState(this.state);
      return {
        action: 'defer',
        reason: 'Max consecutive tasks reached, taking a break',
      };
    }

    // 4. 작업 가능한 태스크 필터링
    const executableTasks = this.filterExecutableTasks(tasks);
    if (executableTasks.length === 0) {
      return {
        action: 'skip',
        reason: 'No executable tasks in backlog',
      };
    }

    // 5. 우선순위 정렬
    const sorted = this.prioritizeTasks(executableTasks);
    const selectedTask = sorted[0];

    // 6. 범위 검증 (CRITICAL)
    const scopeCheck = this.validateScope(selectedTask);
    if (!scopeCheck.valid) {
      return {
        action: 'skip',
        reason: `Scope violation: ${scopeCheck.reason}`,
      };
    }

    // 7. 워크플로우 매핑
    const workflow = await this.taskToWorkflow(selectedTask);
    if (!workflow) {
      return {
        action: 'skip',
        task: selectedTask,
        reason: 'No matching workflow for task',
      };
    }

    // 8. 결정 반환
    return {
      action: this.config.autoExecute ? 'execute' : 'defer',
      task: selectedTask,
      workflow,
      reason: this.config.autoExecute
        ? `Auto-executing: ${selectedTask.title}`
        : `Ready to execute (requires approval): ${selectedTask.title}`,
    };
  }

  /**
   * 작업 실행
   */
  async executeTask(task: TaskItem, workflow: WorkflowConfig): Promise<ExecutorResult> {
    console.log(`[DecisionEngine] Executing task: ${task.title}`);

    // 상태 업데이트
    this.state.lastRunAt = Date.now();
    this.state.consecutiveTasksRun++;
    this.state.lastTaskId = task.id;
    await saveState(this.state);

    // 워크플로우 실행
    const result = await runWorkflowConfig(workflow, {
      enableRollback: true,
      checkTimeWindow: true,
      dryRun: this.config.dryRun,
    });

    // 결과 기록
    if (result.success) {
      this.state.totalTasksCompleted++;
      await saveCognitiveMemory('strategy',
        `Task "${task.title}" completed successfully with workflow "${workflow.name}"`,
        { confidence: 0.8, derivedFrom: task.id }
      );
    } else {
      this.state.totalTasksFailed++;
      this.state.consecutiveTasksRun = 0; // 실패 시 리셋
      await saveCognitiveMemory('belief',
        `Task "${task.title}" failed: ${result.failedStep || 'unknown reason'}`,
        { confidence: 0.6, derivedFrom: task.id }
      );
    }
    await saveState(this.state);

    return result;
  }

  /**
   * 실행 가능한 태스크 필터링
   */
  private filterExecutableTasks(tasks: TaskItem[]): TaskItem[] {
    return tasks.filter(task => {
      // 허용된 프로젝트인지 확인
      if (task.projectPath && this.config.allowedProjects.length > 0) {
        const allowed = this.config.allowedProjects.some(p =>
          task.projectPath!.includes(p) || p.includes(task.projectPath!)
        );
        if (!allowed) return false;
      }

      // 차단된 작업인지 확인
      if (task.blockedBy && task.blockedBy.length > 0) {
        // blockedBy에 있는 작업이 모두 완료되었는지 확인 필요
        // 현재는 간단히 blocked 있으면 제외
        return false;
      }

      return true;
    });
  }

  /**
   * 우선순위 정렬
   */
  private prioritizeTasks(tasks: TaskItem[]): TaskItem[] {
    return [...tasks].sort((a, b) => {
      // 1. Priority (낮을수록 높은 우선순위)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // 2. Due date (빠를수록 높은 우선순위)
      if (a.dueDate && b.dueDate) {
        return a.dueDate - b.dueDate;
      }
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;

      // 3. Created at (오래된 것 먼저)
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * 범위 검증 (CRITICAL - Scope Creep 방지)
   */
  private validateScope(task: TaskItem): { valid: boolean; reason?: string } {
    // 1. Backlog에서 온 작업만 허용
    if (task.source !== 'linear' && task.source !== 'local') {
      return {
        valid: false,
        reason: `Task source "${task.source}" not allowed. Only backlog items permitted.`,
      };
    }

    // 2. 명시적 issue ID 또는 workflow ID 필요
    if (!task.issueId && !task.workflowId) {
      return {
        valid: false,
        reason: 'Task must have explicit issueId or workflowId',
      };
    }

    // 3. 프로젝트 경로 검증
    if (task.projectPath) {
      const expanded = task.projectPath.replace('~', homedir());
      if (this.config.allowedProjects.length > 0) {
        const allowed = this.config.allowedProjects.some(p => {
          const expandedAllowed = p.replace('~', homedir());
          return expanded.startsWith(expandedAllowed) || expandedAllowed.startsWith(expanded);
        });
        if (!allowed) {
          return {
            valid: false,
            reason: `Project path "${task.projectPath}" not in allowed list`,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Task를 Workflow로 변환 (자동 파싱 포함)
   */
  private async taskToWorkflow(task: TaskItem): Promise<WorkflowConfig | null> {
    // 1. 명시적 workflow ID가 있으면 로드
    if (task.workflowId) {
      return loadWorkflow(task.workflowId);
    }

    // 2. 기존 워크플로우 중 매칭되는 것 찾기
    const workflows = await listWorkflows();
    const matching = workflows.find(w =>
      w.projectPath === task.projectPath ||
      w.linearIssue === task.issueId
    );
    if (matching) return matching;

    // 3. 이미 파싱된 결과가 있으면 사용
    if (task.issueId) {
      const existingParsed = await loadParsedTask(task.issueId);
      if (existingParsed) {
        console.log(`[DecisionEngine] Using cached parsed workflow for ${task.issueId}`);
        return existingParsed.workflow;
      }
    }

    // 4. 이슈 자동 파싱하여 워크플로우 생성
    if (task.title && task.issueId) {
      console.log(`[DecisionEngine] Auto-parsing task: ${task.title}`);
      const parsed = parseTask({
        id: task.issueId,
        title: task.title,
        description: task.description,
        projectPath: task.projectPath,
      });

      // 파싱 결과 저장
      await saveParsedTask(parsed);

      // 복잡한 작업이면 경고 로그
      if (parsed.analysis.requiresHumanReview) {
        console.log(`[DecisionEngine] ⚠️ Complex task detected (${parsed.analysis.complexity})`);
        console.log(`[DecisionEngine] Risks: ${parsed.analysis.risks.join(', ') || 'none'}`);
      }

      console.log(`[DecisionEngine] Generated ${parsed.subtasks.length} subtasks:`);
      for (const st of parsed.subtasks) {
        console.log(`  ${st.order}. ${st.title}`);
      }

      return parsed.workflow;
    }

    // 5. 폴백: 기본 CI 파이프라인
    if (task.projectPath) {
      return createCIPipelineTemplate(task.projectPath);
    }

    return null;
  }

  /**
   * 파싱 결과 요약 가져오기 (Linear 코멘트용)
   */
  async getTaskParseSummary(issueId: string): Promise<string | null> {
    const parsed = await loadParsedTask(issueId);
    if (!parsed) return null;
    return formatParsedTaskSummary(parsed);
  }

  /**
   * 발견된 작업을 Backlog에 추가 (실행하지 않음)
   */
  async addToBacklog(discovered: DiscoveredTask): Promise<void> {
    console.log(`[DecisionEngine] Adding to backlog: ${discovered.title}`);

    // 로컬 파일에 저장 (나중에 Linear로 동기화)
    let discoveredTasks: DiscoveredTask[] = [];
    try {
      const content = await fs.readFile(DISCOVERED_TASKS_FILE, 'utf-8');
      discoveredTasks = JSON.parse(content);
    } catch {
      discoveredTasks = [];
    }

    discoveredTasks.push({
      ...discovered,
    });

    await fs.writeFile(DISCOVERED_TASKS_FILE, JSON.stringify(discoveredTasks, null, 2));

    // 메모리에도 기록
    await saveCognitiveMemory('belief',
      `Discovered potential task: "${discovered.title}" from ${discovered.source}`,
      { confidence: 0.5, derivedFrom: 'discovery' }
    );
  }

  /**
   * 발견된 작업 목록 조회
   */
  async getDiscoveredTasks(): Promise<DiscoveredTask[]> {
    try {
      const content = await fs.readFile(DISCOVERED_TASKS_FILE, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * 통계 조회
   */
  getStats(): {
    totalCompleted: number;
    totalFailed: number;
    consecutiveRun: number;
    lastRunAt: number;
  } {
    return {
      totalCompleted: this.state.totalTasksCompleted,
      totalFailed: this.state.totalTasksFailed,
      consecutiveRun: this.state.consecutiveTasksRun,
      lastRunAt: this.state.lastRunAt,
    };
  }
}

// ============================================
// Singleton & Convenience Functions
// ============================================

let engineInstance: DecisionEngine | null = null;

/**
 * Decision Engine 인스턴스 가져오기
 */
export function getDecisionEngine(config?: Partial<DecisionEngineConfig>): DecisionEngine {
  if (!engineInstance || config) {
    engineInstance = new DecisionEngine(config);
  }
  return engineInstance;
}

/**
 * Heartbeat 실행 (간편 함수)
 */
export async function runHeartbeat(
  tasks: TaskItem[],
  config?: Partial<DecisionEngineConfig>
): Promise<DecisionResult> {
  const engine = getDecisionEngine(config);
  await engine.init();
  return engine.heartbeat(tasks);
}

/**
 * Linear 이슈를 TaskItem으로 변환
 */
export function linearIssueToTask(issue: {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  dueDate?: string;
  project?: { id: string; name: string };
}): TaskItem {
  return {
    id: issue.id,
    source: 'linear',
    title: issue.title,
    description: issue.description,
    priority: issue.priority || 3,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    linearProject: issue.project ? {
      id: issue.project.id,
      name: issue.project.name,
    } : undefined,
    createdAt: Date.now(),
    dueDate: issue.dueDate ? new Date(issue.dueDate).getTime() : undefined,
  };
}
