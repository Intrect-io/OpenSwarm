// ============================================
// OpenSwarm - Decision Engine
// Autonomous action scope control and task decision
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import {
  WorkflowConfig,
  ExecutorResult,
  loadWorkflow,
  listWorkflows,
  createCIPipelineTemplate,
} from './workflow.js';
import { parseTask, saveParsedTask, loadParsedTask, formatParsedTaskSummary } from './taskParser.js';
import { checkWorkAllowed } from '../support/timeWindow.js';
import { saveCognitiveMemory } from '../memory/index.js';
import { analyzeIssue } from '../knowledge/index.js';
import type { ImpactAnalysis } from '../knowledge/index.js';

// ============================================
// Types
// ============================================

/**
 * Task source
 */
export type TaskSource = 'linear' | 'local' | 'discovered' | 'github_pr' | 'github_pr_review';

/**
 * Linear project info (summary)
 */
export interface LinearProject {
  id: string;
  name: string;
}

/**
 * Task item
 */
export interface TaskItem {
  id: string;
  source: TaskSource;
  title: string;
  description?: string;
  priority: number;        // 1=Urgent, 2=High, 3=Normal, 4=Low
  projectPath?: string;    // Local filesystem path
  linearProject?: LinearProject;  // Linear project info
  issueId?: string;        // Linear issue ID
  issueIdentifier?: string; // Linear issue identifier (e.g., LIN-123)
  linearState?: string;    // Linear issue state (e.g., 'Todo', 'Backlog', 'In Progress')
  parentId?: string;       // Parent issue ID (for decomposed sub-tasks)
  workflowId?: string;     // Mapped workflow
  createdAt: number;
  dueDate?: number;
  blockedBy?: string[];    // Other task IDs
  impactAnalysis?: ImpactAnalysis;  // Knowledge graph impact analysis
}

/**
 * Decision result
 */
export interface DecisionResult {
  action: 'execute' | 'skip' | 'defer' | 'add_to_backlog';
  task?: TaskItem;
  reason: string;
  workflow?: WorkflowConfig;
}

/**
 * Multiple task decision result (for parallel processing)
 */
export interface DecisionResultMultiple {
  action: 'execute' | 'skip' | 'defer';
  tasks: Array<{ task: TaskItem; workflow: WorkflowConfig }>;
  reason: string;
  skippedCount: number;
}

/**
 * Discovered task (for backlog addition)
 */
export interface DiscoveredTask {
  title: string;
  description: string;
  source: string;          // Where it was discovered
  suggestedPriority: number;
  projectPath?: string;
}

/**
 * Decision Engine configuration
 */
export interface DecisionEngineConfig {
  /** Allowed project path list */
  allowedProjects: string[];

  /** Linear team ID */
  linearTeamId?: string;

  /** Allow auto-execution */
  autoExecute: boolean;

  /** Maximum consecutive tasks */
  maxConsecutiveTasks: number;

  /** Cooldown between tasks (seconds) */
  cooldownSeconds: number;

  /** Dry run mode */
  dryRun: boolean;
}

// ============================================
// Constants
// ============================================

const ENGINE_STATE_FILE = resolve(homedir(), '.openswarm/decision-engine-state.json');
const DISCOVERED_TASKS_FILE = resolve(homedir(), '.openswarm/discovered-tasks.json');

const DEFAULT_CONFIG: DecisionEngineConfig = {
  allowedProjects: [],
  autoExecute: false,       // Default is manual approval
  maxConsecutiveTasks: 3,
  cooldownSeconds: 300,     // 5 minutes
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
  await fs.mkdir(resolve(homedir(), '.openswarm'), { recursive: true });
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
   * Initialize
   */
  async init(): Promise<void> {
    this.state = await loadState();
    console.log('[DecisionEngine] Initialized');
  }

  /**
   * Heartbeat execution - main entry point
   */
  async heartbeat(tasks: TaskItem[]): Promise<DecisionResult> {
    console.log('[DecisionEngine] Heartbeat triggered');

    // 1. Time window check
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      return {
        action: 'skip',
        reason: `Time window blocked: ${timeCheck.reason}`,
      };
    }

    // 2. Cooldown check
    const now = Date.now();
    const timeSinceLastRun = (now - this.state.lastRunAt) / 1000;
    if (timeSinceLastRun < this.config.cooldownSeconds) {
      return {
        action: 'defer',
        reason: `Cooldown: ${Math.ceil(this.config.cooldownSeconds - timeSinceLastRun)}s remaining`,
      };
    }

    // 3. Consecutive task limit check
    if (this.state.consecutiveTasksRun >= this.config.maxConsecutiveTasks) {
      console.log('[DecisionEngine] Max consecutive tasks reached, resetting');
      this.state.consecutiveTasksRun = 0;
      await saveState(this.state);
      return {
        action: 'defer',
        reason: 'Max consecutive tasks reached, taking a break',
      };
    }

    // 4. Filter executable tasks
    const executableTasks = this.filterExecutableTasks(tasks);
    if (executableTasks.length === 0) {
      return {
        action: 'skip',
        reason: 'No executable tasks in backlog',
      };
    }

    // 5. Priority sorting
    const sorted = this.prioritizeTasks(executableTasks);
    const selectedTask = sorted[0];

    // 6. Scope validation (CRITICAL)
    const scopeCheck = this.validateScope(selectedTask);
    if (!scopeCheck.valid) {
      return {
        action: 'skip',
        reason: `Scope violation: ${scopeCheck.reason}`,
      };
    }

    // 7. Workflow mapping
    console.log(`[DecisionEngine] Mapping task to workflow: ${selectedTask.id}`);
    const workflow = await this.taskToWorkflow(selectedTask);
    console.log(`[DecisionEngine] Workflow mapped: ${workflow ? 'yes' : 'no'}`);
    if (!workflow) {
      return {
        action: 'skip',
        task: selectedTask,
        reason: 'No matching workflow for task',
      };
    }

    // 8. Return decision
    console.log(`[DecisionEngine] Returning decision: autoExecute=${this.config.autoExecute}`);
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
   * Heartbeat execution - returns multiple tasks (for parallel processing)
   * @param tasks - Candidate task list
   * @param maxTasks - Maximum number of tasks to return
   * @param _excludeProjects - Project paths to exclude (already running projects)
   */
  async heartbeatMultiple(
    tasks: TaskItem[],
    maxTasks: number = 3,
    _excludeProjects: string[] = []
  ): Promise<DecisionResultMultiple> {
    console.log(`[DecisionEngine] Heartbeat multiple triggered (max: ${maxTasks})`);

    // 1. Time window check
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      return {
        action: 'skip',
        tasks: [],
        reason: `Time window blocked: ${timeCheck.reason}`,
        skippedCount: tasks.length,
      };
    }

    // 2. Cooldown check
    const now = Date.now();
    const timeSinceLastRun = (now - this.state.lastRunAt) / 1000;
    if (timeSinceLastRun < this.config.cooldownSeconds) {
      return {
        action: 'defer',
        tasks: [],
        reason: `Cooldown: ${Math.ceil(this.config.cooldownSeconds - timeSinceLastRun)}s remaining`,
        skippedCount: tasks.length,
      };
    }

    // 3. Consecutive task limit check
    if (this.state.consecutiveTasksRun >= this.config.maxConsecutiveTasks) {
      console.log('[DecisionEngine] Max consecutive tasks reached, resetting');
      this.state.consecutiveTasksRun = 0;
      await saveState(this.state);
      return {
        action: 'defer',
        tasks: [],
        reason: 'Max consecutive tasks reached, taking a break',
        skippedCount: tasks.length,
      };
    }

    // 4. Filter executable tasks
    const executableTasks = this.filterExecutableTasks(tasks);
    if (executableTasks.length === 0) {
      return {
        action: 'skip',
        tasks: [],
        reason: 'No executable tasks in backlog',
        skippedCount: tasks.length,
      };
    }

    // 5. Priority sorting
    const sorted = this.prioritizeTasks(executableTasks);

    // 6. Select multiple tasks (max maxTasks, blocker-based filtering only)
    const selectedTasks: Array<{ task: TaskItem; workflow: WorkflowConfig }> = [];
    let skippedCount = 0;

    for (const task of sorted) {
      if (selectedTasks.length >= maxTasks) break;

      // Scope validation
      const scopeCheck = this.validateScope(task);
      if (!scopeCheck.valid) {
        skippedCount++;
        continue;
      }

      // Workflow mapping
      const workflow = await this.taskToWorkflow(task);
      if (!workflow) {
        skippedCount++;
        continue;
      }

      selectedTasks.push({ task, workflow });
    }

    if (selectedTasks.length === 0) {
      return {
        action: 'skip',
        tasks: [],
        reason: 'No tasks passed validation/workflow mapping',
        skippedCount: sorted.length,
      };
    }

    console.log(`[DecisionEngine] Selected ${selectedTasks.length} tasks for parallel execution`);
    return {
      action: this.config.autoExecute ? 'execute' : 'defer',
      tasks: selectedTasks,
      reason: this.config.autoExecute
        ? `Auto-executing ${selectedTasks.length} tasks`
        : `Ready to execute ${selectedTasks.length} tasks (requires approval)`,
      skippedCount,
    };
  }

  /**
   * Execute task
   */
  async executeTask(task: TaskItem, _workflow: WorkflowConfig): Promise<ExecutorResult> {
    console.log(`[DecisionEngine] Executing task: ${task.title}`);

    // Update state
    this.state.lastRunAt = Date.now();
    this.state.consecutiveTasksRun++;
    this.state.lastTaskId = task.id;
    await saveState(this.state);

    // Legacy tmux-based workflow executor removed — use pair pipeline instead
    throw new Error('Legacy workflow executor has been removed. Use pair mode (pairMode: true) for task execution.');
  }

  /**
   * Update allowed projects at runtime
   */
  updateAllowedProjects(paths: string[]): void {
    this.config.allowedProjects = paths;
  }

  /**
   * Filter executable tasks
   */
  private filterExecutableTasks(tasks: TaskItem[]): TaskItem[] {
    return tasks.filter(task => {
      // Check if project is allowed
      if (task.projectPath && this.config.allowedProjects.length > 0) {
        const allowed = this.config.allowedProjects.some(p =>
          task.projectPath!.includes(p) || p.includes(task.projectPath!)
        );
        if (!allowed) return false;
      }

      // Check if task is blocked
      if (task.blockedBy && task.blockedBy.length > 0) {
        // Need to check if all blockedBy tasks are completed
        // Currently simply exclude if blocked
        return false;
      }

      return true;
    });
  }

  /**
   * Priority sorting
   */
  private prioritizeTasks(tasks: TaskItem[]): TaskItem[] {
    return [...tasks].sort((a, b) => {
      // 1. Priority (lower value = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // 2. Due date (earlier = higher priority)
      if (a.dueDate && b.dueDate) {
        return a.dueDate - b.dueDate;
      }
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;

      // 3. Created at (older first)
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Scope validation (CRITICAL - prevent scope creep)
   */
  private validateScope(task: TaskItem): { valid: boolean; reason?: string } {
    // 1. Only allow tasks from backlog
    if (task.source !== 'linear' && task.source !== 'local') {
      return {
        valid: false,
        reason: `Task source "${task.source}" not allowed. Only backlog items permitted.`,
      };
    }

    // 2. Require explicit issue ID or workflow ID
    if (!task.issueId && !task.workflowId) {
      return {
        valid: false,
        reason: 'Task must have explicit issueId or workflowId',
      };
    }

    // 3. Project path validation
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
   * Convert Task to Workflow (includes auto-parsing)
   */
  private async taskToWorkflow(task: TaskItem): Promise<WorkflowConfig | null> {
    // 1. Load if explicit workflow ID exists
    if (task.workflowId) {
      return loadWorkflow(task.workflowId);
    }

    // 2. Find matching workflow among existing ones
    const workflows = await listWorkflows();
    const matching = workflows.find(w =>
      w.projectPath === task.projectPath ||
      w.linearIssue === task.issueId
    );
    if (matching) return matching;

    // 3. Use cached parsed result if available
    if (task.issueId) {
      const existingParsed = await loadParsedTask(task.issueId);
      if (existingParsed) {
        console.log(`[DecisionEngine] Using cached parsed workflow for ${task.issueId}`);
        return existingParsed.workflow;
      }
    }

    // 4. Auto-parse issue to generate workflow
    if (task.title && task.issueId) {
      console.log(`[DecisionEngine] Auto-parsing task: ${task.title}`);

      // Impact analysis (knowledge graph) — non-blocking, best-effort
      if (task.projectPath) {
        try {
          const impact = await analyzeIssue(task.projectPath, task.title, task.description);
          if (impact) {
            task.impactAnalysis = impact;
            console.log(`[DecisionEngine] Impact: scope=${impact.estimatedScope}, direct=${impact.directModules.length}, deps=${impact.dependentModules.length}, tests=${impact.testFiles.length}`);
          }
        } catch (err) {
          console.warn(`[DecisionEngine] Impact analysis failed (non-critical):`, err);
        }
      }

      const parsed = parseTask({
        id: task.issueId,
        title: task.title,
        description: task.description,
        projectPath: task.projectPath,
        impactScope: task.impactAnalysis?.estimatedScope,
        affectedModuleCount: task.impactAnalysis
          ? task.impactAnalysis.directModules.length + task.impactAnalysis.dependentModules.length
          : undefined,
      });

      // Save parsed result
      await saveParsedTask(parsed);

      // Log warning if complex task
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

    // 5. Fallback: default CI pipeline
    if (task.projectPath) {
      return createCIPipelineTemplate(task.projectPath);
    }

    return null;
  }

  /**
   * Get parsed task summary (for Linear comments)
   */
  async getTaskParseSummary(issueId: string): Promise<string | null> {
    const parsed = await loadParsedTask(issueId);
    if (!parsed) return null;
    return formatParsedTaskSummary(parsed);
  }

  /**
   * Add discovered task to backlog (does not execute)
   */
  async addToBacklog(discovered: DiscoveredTask): Promise<void> {
    console.log(`[DecisionEngine] Adding to backlog: ${discovered.title}`);

    // Save to local file (sync to Linear later)
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

    // Also record in memory
    try {
      await saveCognitiveMemory('belief',
        `Discovered potential task: "${discovered.title}" from ${discovered.source}`,
        { confidence: 0.5, derivedFrom: 'discovery' }
      );
    } catch (memErr) {
      console.warn(`[DecisionEngine] Memory save failed (non-critical):`, memErr);
    }
  }

  /**
   * Get discovered task list
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
   * Get statistics
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
 * Get Decision Engine instance
 */
export function getDecisionEngine(config?: Partial<DecisionEngineConfig>): DecisionEngine {
  if (!engineInstance || config) {
    engineInstance = new DecisionEngine(config);
  }
  return engineInstance;
}

/**
 * Run heartbeat (convenience function)
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
 * Convert Linear issue to TaskItem
 */
export function linearIssueToTask(issue: {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  dueDate?: string;
  state?: string;
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
    linearState: issue.state,
    linearProject: issue.project ? {
      id: issue.project.id,
      name: issue.project.name,
    } : undefined,
    createdAt: Date.now(),
    dueDate: issue.dueDate ? new Date(issue.dueDate).getTime() : undefined,
  };
}
