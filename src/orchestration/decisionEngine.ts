// ============================================
// OpenSwarm - Decision Engine
// Autonomous action scope control and task decision
// ============================================

import { isAbsolute, relative, resolve } from 'path';
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
import { getTaskReadiness } from '../taskState/store.js';
import {
  applyDurablePriorityCouncilRanking,
  resolvePriorityCouncilRepositoryScopes,
} from './priorityCouncilRanking.js';

// Types

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
  issueUrl?: string;       // Canonical Linear card URL
  linearState?: string;    // Linear issue state (e.g., 'Todo', 'Backlog', 'In Progress')
  labels?: string[];       // Linear label names (e.g., 'swarm:stuck') — used to gate re-selection
  parentId?: string;       // Parent issue ID (for decomposed sub-tasks)
  topoRank?: number;       // Planner topological rank within a decomposed tree
  workflowId?: string;     // Mapped workflow
  createdAt: number;
  /** Last issue-tracker activity, as epoch milliseconds. */
  trackerUpdatedAt?: number;
  dueDate?: number;
  blockedBy?: string[];    // Other task IDs
  fileScope?: string[];    // Files/modules this task modifies (planner-declared) — for parallel conflict detection
  /** Whether fileScope came from an explicit planner declaration or KG inference. */
  fileScopeSource?: 'declared' | 'inferred';
  impactAnalysis?: ImpactAnalysis;  // Knowledge graph impact analysis
  estimatedMinutes?: number;
  priorAttemptFeedback?: string;  // Last failure/rejection feedback from a previous session — injected into the worker's first iteration (INT-2474)
  /** Durable resolved ask_human decisions; newer and authoritative over stale task prose. */
  authoritativeOperatorFeedback?: string;
  /**
   * The user explicitly chose this issue (POST /api/work, `openswarm work`)
   * rather than the heartbeat selecting it. Durable admission reopens
   * terminal (DONE/CANCELLED/DECOMPOSED) ledger records for these regardless
   * of the autonomous Todo-only reopen rule. (INT-3388)
   */
  explicitDispatch?: boolean;
}

/**
 * INT-1810 R2: a parent/EPIC (umbrella) issue is not executable work — it's a container for
 * sub-issues. `parentIds` is the set of issueIds that any fetched task points to via parentId,
 * so a fetched issue that IS such a parent is an umbrella. EPICs are also tagged in the title.
 */
/**
 * The ONE key every hub event about a task uses (`taskId` on log /
 * pipeline:stage / task:queued|started|completed / task:cost / process:*).
 * For Linear tasks `issueId === id`; TaskItem permits them to differ, and a
 * mixed-key task splits across cockpit sessions and leaks its transcript
 * buffer (INT-3402). Human-readable labels (issueIdentifier) ride in event
 * payloads, never in the key.
 */
export function taskEventKey(task: Pick<TaskItem, 'id' | 'issueId'>): string {
  return task.issueId || task.id;
}

export function isUmbrellaIssue(task: TaskItem, parentIds: Set<string>): boolean {
  const isEpicTitle = /\[\s*epic\s*\]/i.test(task.title) || /^\s*epic[:\s]/i.test(task.title);
  const isParent = !!task.issueId && parentIds.has(task.issueId);
  return isEpicTitle || isParent;
}

/**
 * Count, per task, how many OTHER fetched tasks (transitively) depend on it — its
 * "downstream" / unblock weight, derived from the `blockedBy` graph (INT-1809
 * wires blockedBy from Linear relations + description text). The readiness gate
 * already prevents a dependent from running before its blocker; this metric lets
 * the priority sort *prefer the unblockers* among ready tasks, so dependency
 * chains drain instead of leaf tasks being picked first. Cycle-safe; a task with
 * no dependents scores 0 (then ordering falls back to plain priority).
 */
export function computeDownstreamCounts(tasks: TaskItem[]): Map<string, number> {
  const idOf = (t: TaskItem) => t.issueId || t.id;
  const inSet = new Set(tasks.map(idOf));
  // blocker id → dependents that list it in blockedBy (reverse edges, in-set only)
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const blocker of t.blockedBy ?? []) {
      if (!inSet.has(blocker)) continue;
      const arr = dependents.get(blocker);
      if (arr) arr.push(idOf(t));
      else dependents.set(blocker, [idOf(t)]);
    }
  }
  const memo = new Map<string, Set<string>>();
  const descendants = (id: string, stack: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (stack.has(id)) return new Set(); // cycle guard
    stack.add(id);
    const out = new Set<string>();
    for (const d of dependents.get(id) ?? []) {
      out.add(d);
      for (const x of descendants(d, stack)) out.add(x);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(idOf(t), descendants(idOf(t), new Set()).size);
  return counts;
}

/** Linear states from which the heartbeat will (re)select an issue for work. */
const RECOVERABLE_STATES = new Set(['Todo', 'In Progress', 'In Review']);

export type StuckDecision = 'recover' | 'skip-stuck' | 'pass';

/**
 * Decide how the heartbeat filter should treat a task with respect to the stuck
 * marker (INT-1908). Pure — the caller applies the side effects (clearing failure
 * counters, stripping the stuck label).
 *
 * - `recover`: the issue sits in an active state AND carries the stuck label or a
 *   failure history → the user deliberately pulled it back, so retry it.
 * - `skip-stuck`: the issue carries the stuck label but is parked (e.g. Backlog) →
 *   retries are exhausted, skip it. This is durable across restarts because the
 *   label lives on the Linear issue, not in the in-memory failure counters.
 * - `pass`: not stuck — fall through to the normal completed/failed/backoff checks.
 */
export function classifyStuck(opts: {
  isStuck: boolean;
  linearState?: string;
  hasFailureHistory: boolean;
}): StuckDecision {
  const recoverable = RECOVERABLE_STATES.has(opts.linearState || '');
  if (recoverable && (opts.isStuck || opts.hasFailureHistory)) return 'recover';
  if (opts.isStuck) return 'skip-stuck';
  return 'pass';
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

  /** Dry run mode */
  dryRun: boolean;

  /**
   * Treat Linear "Backlog" as an actionable work queue (legacy behavior). When
   * false (default), Backlog is "parked": only Todo/In Progress/In Review are
   * actionable, so moving an issue to Backlog stops the daemon picking it up.
   */
  includeBacklog?: boolean;

  /**
   * Allow selecting multiple tasks from the same project in one cycle
   * (round-robin fill: every pass adds at most one task per project, so no
   * project can monopolize the slots). Wire this from
   * `allowSameProjectConcurrent && worktreeMode` — the scheduler only runs
   * same-project tasks concurrently under worktree isolation, and the
   * heartbeat's knowledge-graph conflict detection defers file-overlapping
   * tasks within a project. Default false (one task per project per cycle).
   * (INT-2318)
   */
  sameProjectParallel?: boolean;
}

// Constants

const ENGINE_STATE_FILE = resolve(homedir(), '.openswarm/decision-engine-state.json');
const DISCOVERED_TASKS_FILE = resolve(homedir(), '.openswarm/discovered-tasks.json');

const DEFAULT_CONFIG: DecisionEngineConfig = {
  allowedProjects: [],
  autoExecute: false,       // Default is manual approval
  dryRun: false,
  includeBacklog: false,    // Backlog is parked, not a queue (R5)
};

function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

function normalizeProjectPath(input: string): string {
  return resolve(expandHomePath(input));
}

/**
 * Compose the membership test dispatch applies to a RESOLVED project path, for
 * consumers scoping ledger rows (which store resolved paths).
 *
 * Regime selection only — this function holds NO path logic. Both gates arrive
 * bound from the runner, which compares in the same normalized path space the
 * ledger stores rows in (taskScheduler's normalizeProjectPath, realpath
 * included). Re-deriving membership from path lists drifted from dispatch three
 * review rounds running, and a re-derivation through decisionEngine's own
 * resolve-only normalizer counted every row under a symlinked configured path
 * as out of scope (tier-2 review, C1).
 *
 * - Selection filter active → the enabled-selection gate, and only it. The
 *   configured allow-list gates pre-resolution task metadata, and the daemon's
 *   task source never sets `task.projectPath`, so it does not constrain
 *   resolved paths in this regime.
 * - No selection, allow-list configured → the allow-list gate. It is the
 *   operator's declared scope; without it this regime reads the raw table —
 *   the stale-row inflation this exists to stop. resolveProjectPath can emit a
 *   path outside the allow-list only via its `$HOME/dev/<name>` fallback, and
 *   such rows land in `outOfScope` rather than vanishing.
 * - Neither → `undefined`: everything is dispatchable, read the raw table.
 * (AGT-4127)
 */
/**
 * Prefix-closed membership over ALREADY-normalized paths: `path` is in when it
 * equals a root or lies under one. Deliberately free of any normalization —
 * the caller normalizes both sides in whatever space its storage uses, so this
 * helper cannot smuggle in a second path-space opinion (the defect class from
 * AGT-4127's tier-2 review, C1).
 */
export function pathIsUnderAny(path: string, roots: readonly string[]): boolean {
  // taskScheduler.normalizeProjectPath canonicalizes separators to '/' on
  // every platform before either operand reaches this helper. Do not use the
  // host separator here: Windows ledger rows are deliberately forward-slashed.
  // Avoid doubling the separator for '/' or an already-slashed drive root.
  // (PR #477 review)
  return roots.some((root) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/'));
}

export function composeDispatchScope(
  applyEnabledFilter: boolean,
  enabledGate: (projectPath: string) => boolean,
  allowedGate: ((projectPath: string) => boolean) | undefined,
): ((projectPath: string) => boolean) | undefined {
  if (applyEnabledFilter) return enabledGate;
  return allowedGate;
}

export function isAllowedProjectPath(projectPath: string, allowedProjects: string[]): boolean {
  const normalizedProjectPath = normalizeProjectPath(projectPath);

  return allowedProjects.some(allowedProject => {
    const normalizedAllowedProject = normalizeProjectPath(allowedProject);
    const rel = relative(normalizedAllowedProject, normalizedProjectPath);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * Linear states the daemon will NOT act on. Backlog is "parked" (opt back in via
 * DecisionEngineConfig.includeBacklog); Done/Canceled are terminal.
 */
const NON_ACTIONABLE_LINEAR_STATES = new Set(['Backlog', 'Done', 'Canceled', 'Cancelled']);

/**
 * R5: whether the daemon should act on an issue in the given Linear state. Only
 * Todo/In Progress/In Review (and unknown states, conservatively) are actionable;
 * Backlog is parked and Done/Canceled are terminal. `includeBacklog` opts back
 * into the legacy "Backlog is a work queue" behavior.
 */
export function isActionableLinearState(linearState: string | undefined, includeBacklog = false): boolean {
  if (!linearState) return true; // unknown state → don't gate (conservative)
  if (!NON_ACTIONABLE_LINEAR_STATES.has(linearState)) return true;
  return linearState === 'Backlog' && includeBacklog === true;
}

/**
 * Select up to `maxTasks` from the priority-sorted list, round-robin across
 * projects: every pass adds at most one task per project, so no project can
 * monopolize the slots and all bots stay active. With `sameProjectParallel`
 * (scheduler worktree isolation + KG conflict detection downstream) later
 * passes fill the remaining slots with additional tasks from the same
 * projects; without it, selection stops after the first pass (one task per
 * project per cycle). Tasks failing `validate`/`toWorkflow` are counted as
 * skipped and never retried in later passes. Pure orchestration (deps
 * injected) — unit-tested directly. (INT-2318)
 */
export async function selectTasksRoundRobin(
  sorted: TaskItem[],
  maxTasks: number,
  sameProjectParallel: boolean,
  validate: (task: TaskItem) => boolean,
  toWorkflow: (task: TaskItem) => Promise<WorkflowConfig | null>,
): Promise<{ selected: Array<{ task: TaskItem; workflow: WorkflowConfig }>; skippedCount: number }> {
  const selected: Array<{ task: TaskItem; workflow: WorkflowConfig }> = [];
  const seenIds = new Set<string>();
  let skippedCount = 0;

  const maxPasses = sameProjectParallel ? Math.max(1, maxTasks) : 1;
  for (let pass = 0; pass < maxPasses && selected.length < maxTasks; pass++) {
    const projectsThisPass = new Set<string>();
    let addedThisPass = 0;

    for (const task of sorted) {
      if (selected.length >= maxTasks) break;
      if (seenIds.has(task.id)) continue;

      const projectKey = task.linearProject?.id || task.projectPath || task.id;
      if (projectsThisPass.has(projectKey)) {
        continue; // already picked a task for this project this pass
      }

      if (!validate(task)) {
        skippedCount++;
        seenIds.add(task.id);
        continue;
      }

      const workflow = await toWorkflow(task);
      if (!workflow) {
        skippedCount++;
        seenIds.add(task.id);
        continue;
      }

      selected.push({ task, workflow });
      seenIds.add(task.id);
      projectsThisPass.add(projectKey);
      addedThisPass++;
    }

    if (addedThisPass === 0) break; // nothing left to pick
  }

  return { selected, skippedCount };
}

// Engine State

interface EngineState {
  lastTaskId?: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
}

async function loadState(): Promise<EngineState> {
  try {
    const content = await fs.readFile(ENGINE_STATE_FILE, 'utf-8');
    const saved = JSON.parse(content) as Partial<EngineState>;
    return {
      lastTaskId: saved.lastTaskId,
      totalTasksCompleted: saved.totalTasksCompleted ?? 0,
      totalTasksFailed: saved.totalTasksFailed ?? 0,
    };
  } catch {
    return {
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    };
  }
}

// Decision Engine

export class DecisionEngine {
  private config: DecisionEngineConfig;
  private state: EngineState = {
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

    // 2. Filter executable tasks
    const executableTasks = this.filterExecutableTasks(tasks);
    if (executableTasks.length === 0) {
      return {
        action: 'skip',
        reason: 'No executable tasks in backlog',
      };
    }

    // 5. Priority sorting — dependency-aware (unblockers first), computed over the
    // full fetched set so blocked dependents still count toward a blocker's weight.
    const downstream = computeDownstreamCounts(tasks);
    const baseline = this.prioritizeTasks(executableTasks, downstream);
    const councilScopes = await resolvePriorityCouncilRepositoryScopes(executableTasks, this.config.allowedProjects);
    const councilRanking = applyDurablePriorityCouncilRanking(
      executableTasks, baseline, downstream, councilScopes,
    );
    const sorted = councilRanking.tasks;
    if (councilRanking.applied) {
      console.log(`[DecisionEngine] Applied advisory priority council ${councilRanking.councilId}`);
    }
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
   * @param excludeProjects - Project paths or Linear project IDs to exclude (already running projects)
   */
  async heartbeatMultiple(
    tasks: TaskItem[],
    maxTasks: number = 3,
    excludeProjects: string[] = []
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

    // 2. Filter executable tasks
    const excludedProjects = new Set(excludeProjects.filter(Boolean));
    const executableTasks = this.filterExecutableTasks(tasks).filter(task => {
      return !(
        (task.projectPath && excludedProjects.has(task.projectPath)) ||
        (task.linearProject?.id && excludedProjects.has(task.linearProject.id))
      );
    });
    if (executableTasks.length === 0) {
      return {
        action: 'skip',
        tasks: [],
        reason: 'No executable tasks in backlog',
        skippedCount: tasks.length,
      };
    }

    // 5. Priority sorting — dependency-aware (unblockers first), computed over the
    // full fetched set so blocked dependents still count toward a blocker's weight.
    const downstream = computeDownstreamCounts(tasks);
    const baseline = this.prioritizeTasks(executableTasks, downstream);
    const councilScopes = await resolvePriorityCouncilRepositoryScopes(executableTasks, this.config.allowedProjects);
    const councilRanking = applyDurablePriorityCouncilRanking(
      executableTasks, baseline, downstream, councilScopes,
    );
    const sorted = councilRanking.tasks;
    if (councilRanking.applied) {
      console.log(`[DecisionEngine] Applied advisory priority council ${councilRanking.councilId}`);
    }

    // 6. Select multiple tasks (round-robin across projects — see
    // selectTasksRoundRobin). (INT-2318)
    const { selected: selectedTasks, skippedCount } = await selectTasksRoundRobin(
      sorted,
      maxTasks,
      !!this.config.sameProjectParallel,
      (task) => this.validateScope(task).valid,
      (task) => this.taskToWorkflow(task),
    );

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
    // INT-1810 R2: parent/EPIC (umbrella) issues are not executable work. A parent is any issue
    // another fetched issue points to via parentId; an EPIC is tagged in the title. Without this,
    // INT-1702 (tracking, decomposed into sub-issues) and KT-300 ([EPIC] …) were picked as work.
    const parentIds = new Set(tasks.map(t => t.parentId).filter((id): id is string => !!id));

    return tasks.filter(task => {
      // Check if project is allowed
      if (task.projectPath && this.config.allowedProjects.length > 0) {
        if (!isAllowedProjectPath(task.projectPath, this.config.allowedProjects)) {
          console.log(`[DecisionEngine] Filtered out ${task.issueIdentifier}: project not allowed (${task.projectPath})`);
          return false;
        }
      }

      // R2: skip umbrella issues (EPIC by title, or parent of another fetched issue).
      if (isUmbrellaIssue(task, parentIds)) {
        console.log(`[DecisionEngine] Filtered out ${task.issueIdentifier}: parent/EPIC issue is not executable`);
        return false;
      }

      // R5: Linear is the source of truth for whether work is wanted. Backlog is
      // "parked" (not a queue) and Done/Canceled are terminal — only actionable
      // states proceed. Moving an issue to Backlog stops the daemon picking it up.
      if (!isActionableLinearState(task.linearState, this.config.includeBacklog)) {
        console.log(`[DecisionEngine] Filtered out ${task.issueIdentifier}: Linear state "${task.linearState}" is not actionable (parked)`);
        return false;
      }

      const readiness = getTaskReadiness(task);
      if (!readiness.ready) {
        console.log(`[DecisionEngine] Filtered out ${task.issueIdentifier}: ${readiness.reason || 'not ready'} (blocked by: ${readiness.blockedBy.join(', ') || 'none'})`);
        return false;
      }

      return true;
    });
  }

  /**
   * Priority sorting
   */
  private prioritizeTasks(tasks: TaskItem[], downstream?: Map<string, number>): TaskItem[] {
    const dsOf = (t: TaskItem) => downstream?.get(t.issueId || t.id) ?? 0;
    return [...tasks].sort((a, b) => {
      // 0. Dependency order: prefer tasks that unblock the most pending work, so
      // chains drain instead of leaf tasks first. When nothing depends on either
      // (the common case), both score 0 and this is a no-op → plain priority order.
      const dsA = dsOf(a);
      const dsB = dsOf(b);
      if (dsA !== dsB) {
        return dsB - dsA;
      }

      const topoA = a.topoRank ?? Number.MAX_SAFE_INTEGER;
      const topoB = b.topoRank ?? Number.MAX_SAFE_INTEGER;
      if (topoA !== topoB) {
        return topoA - topoB;
      }

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
      if (this.config.allowedProjects.length > 0) {
        if (!isAllowedProjectPath(task.projectPath, this.config.allowedProjects)) {
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
  } {
    return {
      totalCompleted: this.state.totalTasksCompleted,
      totalFailed: this.state.totalTasksFailed,
    };
  }
}

// Singleton & Convenience Functions

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
  url?: string;
  description?: string;
  priority: number;
  dueDate?: string;
  state?: string;
  labels?: string[];
  project?: { id: string; name: string };
  parentId?: string;
  blockedBy?: string[];
  topoRank?: number;
  updatedAt?: string;
}): TaskItem {
  return {
    id: issue.id,
    source: 'linear',
    title: issue.title,
    description: issue.description,
    priority: issue.priority || 3,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    linearState: issue.state,
    labels: issue.labels,
    parentId: issue.parentId,
    blockedBy: issue.blockedBy,
    topoRank: issue.topoRank,
    linearProject: issue.project ? {
      id: issue.project.id,
      name: issue.project.name,
    } : undefined,
    createdAt: Date.now(),
    trackerUpdatedAt: issue.updatedAt ? new Date(issue.updatedAt).getTime() : undefined,
    dueDate: issue.dueDate ? new Date(issue.dueDate).getTime() : undefined,
  };
}
