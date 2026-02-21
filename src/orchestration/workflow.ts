// ============================================
// Claude Swarm - DAG Workflow Engine
// Agent task dependency management and execution
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import * as yaml from 'yaml';

// ============================================
// Types & Interfaces
// ============================================

/**
 * Failure handling strategy
 */
export type FailureStrategy = 'rollback' | 'retry' | 'skip' | 'abort' | 'notify';

/**
 * Step execution status
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Workflow step definition
 */
export interface WorkflowStep {
  /** Step unique ID */
  id: string;

  /** Step name (for display) */
  name: string;

  /** Prompt or command to execute */
  prompt: string;

  /** Dependent step ID list */
  dependsOn?: string[];

  /** Failure strategy (default: abort) */
  onFailure?: FailureStrategy;

  /** Retry count (for retry strategy) */
  retryCount?: number;

  /** Timeout (seconds) */
  timeout?: number;

  /** Conditional execution (based on previous step results) */
  condition?: string;

  /** Per-step environment variables */
  env?: Record<string, string>;
}

/**
 * Workflow definition
 */
export interface WorkflowConfig {
  /** Workflow unique ID */
  id: string;

  /** Workflow name */
  name: string;

  /** Description */
  description?: string;

  /** Target project path */
  projectPath: string;

  /** Step list */
  steps: WorkflowStep[];

  /** Global failure strategy */
  onFailure?: FailureStrategy;

  /** Trigger conditions */
  trigger?: {
    /** Cron expression */
    schedule?: string;
    /** On Linear issue status change */
    onIssueStatus?: string[];
    /** Manual execution only */
    manual?: boolean;
  };

  /** Linear issue integration */
  linearIssue?: string;
}

/**
 * Step execution result
 */
export interface StepResult {
  stepId: string;
  status: StepStatus;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  changedFiles?: string[];
}

/**
 * Workflow execution state
 */
export interface WorkflowExecution {
  workflowId: string;
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  completedAt?: number;
  stepResults: Record<string, StepResult>;
  checkpoint?: string;  // git commit hash for rollback
}

/**
 * Executor result (formerly in workflowExecutor.ts)
 */
export interface ExecutorResult {
  execution: WorkflowExecution;
  success: boolean;
  failedStep?: string;
  rollbackPerformed?: boolean;
  duration: number;
}

// ============================================
// DAG Utilities
// ============================================

/**
 * Topological Sort (Kahn's Algorithm)
 * Sort steps in dependency order
 */
export function topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  const stepMap = new Map<string, WorkflowStep>();

  // Initialize graph
  for (const step of steps) {
    stepMap.set(step.id, step);
    graph.set(step.id, new Set());
    inDegree.set(step.id, 0);
  }

  // Add edges (dependencies)
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!graph.has(dep)) {
          throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
        graph.get(dep)!.add(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }
  }

  // Kahn's Algorithm
  const queue: string[] = [];
  const result: WorkflowStep[] = [];

  // Add nodes with in-degree 0 to queue
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(stepMap.get(current)!);

    for (const neighbor of graph.get(current)!) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Cycle detection
  if (result.length !== steps.length) {
    throw new Error('Workflow contains circular dependencies');
  }

  return result;
}

/**
 * Find currently executable steps (all dependencies completed)
 */
export function getExecutableSteps(
  steps: WorkflowStep[],
  results: Record<string, StepResult>
): WorkflowStep[] {
  return steps.filter(step => {
    // Already executed
    if (results[step.id]) return false;

    // Check dependencies
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        const depResult = results[depId];
        if (!depResult || depResult.status !== 'completed') {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * Find parallelizable step groups
 */
export function getParallelGroups(steps: WorkflowStep[]): WorkflowStep[][] {
  const sorted = topologicalSort(steps);
  const groups: WorkflowStep[][] = [];
  const completed = new Set<string>();

  while (completed.size < sorted.length) {
    const group: WorkflowStep[] = [];

    for (const step of sorted) {
      if (completed.has(step.id)) continue;

      // All dependencies completed?
      const depsCompleted = !step.dependsOn ||
        step.dependsOn.every(dep => completed.has(dep));

      if (depsCompleted) {
        group.push(step);
      }
    }

    if (group.length === 0) break;

    groups.push(group);
    group.forEach(s => completed.add(s.id));
  }

  return groups;
}

// ============================================
// Workflow Storage
// ============================================

const WORKFLOW_DIR = resolve(homedir(), '.claude-swarm/workflows');
const EXECUTION_DIR = resolve(homedir(), '.claude-swarm/executions');

/**
 * Save workflow
 */
export async function saveWorkflow(workflow: WorkflowConfig): Promise<void> {
  await fs.mkdir(WORKFLOW_DIR, { recursive: true });
  const filePath = resolve(WORKFLOW_DIR, `${workflow.id}.yaml`);
  await fs.writeFile(filePath, yaml.stringify(workflow), 'utf-8');
  console.log(`[Workflow] Saved: ${workflow.name} (${workflow.id})`);
}

/**
 * Load workflow
 */
export async function loadWorkflow(workflowId: string): Promise<WorkflowConfig | null> {
  try {
    const filePath = resolve(WORKFLOW_DIR, `${workflowId}.yaml`);
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content) as WorkflowConfig;
  } catch {
    return null;
  }
}

/**
 * List all workflows
 */
export async function listWorkflows(): Promise<WorkflowConfig[]> {
  try {
    await fs.mkdir(WORKFLOW_DIR, { recursive: true });
    const files = await fs.readdir(WORKFLOW_DIR);
    const workflows: WorkflowConfig[] = [];

    for (const file of files) {
      if (file.endsWith('.yaml')) {
        const content = await fs.readFile(resolve(WORKFLOW_DIR, file), 'utf-8');
        workflows.push(yaml.parse(content));
      }
    }

    return workflows;
  } catch {
    return [];
  }
}

/**
 * Save execution state
 */
export async function saveExecution(execution: WorkflowExecution): Promise<void> {
  await fs.mkdir(EXECUTION_DIR, { recursive: true });
  const filePath = resolve(EXECUTION_DIR, `${execution.executionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(execution, null, 2), 'utf-8');
}

/**
 * Load execution state
 */
export async function loadExecution(executionId: string): Promise<WorkflowExecution | null> {
  try {
    const filePath = resolve(EXECUTION_DIR, `${executionId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ============================================
// Workflow Templates
// ============================================

/**
 * CI pipeline template
 */
export function createCIPipelineTemplate(projectPath: string): WorkflowConfig {
  return {
    id: `ci-pipeline-${Date.now()}`,
    name: 'CI Pipeline',
    description: 'Lint → Test → Build → PR',
    projectPath,
    onFailure: 'rollback',
    steps: [
      {
        id: 'lint',
        name: 'Lint & Format',
        prompt: 'Run linting and fix any issues. Report what was fixed.',
        onFailure: 'abort',
      },
      {
        id: 'test',
        name: 'Run Tests',
        prompt: 'Run all tests and report results. Fix any failing tests if possible.',
        dependsOn: ['lint'],
        onFailure: 'abort',
      },
      {
        id: 'build',
        name: 'Build Check',
        prompt: 'Run build and verify it succeeds. Fix any build errors.',
        dependsOn: ['test'],
        onFailure: 'abort',
      },
      {
        id: 'pr',
        name: 'Create PR',
        prompt: 'Create a pull request with all changes made. Include a summary of fixes.',
        dependsOn: ['build'],
        onFailure: 'notify',
      },
    ],
  };
}

/**
 * Code review pipeline template
 */
export function createReviewPipelineTemplate(projectPath: string, prNumber: string): WorkflowConfig {
  return {
    id: `review-pipeline-${Date.now()}`,
    name: 'Code Review Pipeline',
    description: 'Security → Quality → Tests → Approve',
    projectPath,
    onFailure: 'notify',
    steps: [
      {
        id: 'security',
        name: 'Security Review',
        prompt: `Review PR #${prNumber} for security vulnerabilities. Check for injection, auth issues, data exposure.`,
      },
      {
        id: 'quality',
        name: 'Code Quality',
        prompt: `Review PR #${prNumber} for code quality. Check naming, structure, SOLID principles.`,
      },
      {
        id: 'tests',
        name: 'Test Coverage',
        prompt: `Check if PR #${prNumber} has adequate test coverage. Suggest missing tests.`,
        dependsOn: ['security', 'quality'],  // Execute after parallel steps
      },
      {
        id: 'summary',
        name: 'Review Summary',
        prompt: 'Compile all review findings and create a summary comment on the PR.',
        dependsOn: ['tests'],
      },
    ],
  };
}

// ============================================
// Workflow Validation
// ============================================

/**
 * Validate workflow
 */
export function validateWorkflow(workflow: WorkflowConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Basic field validation
  if (!workflow.id) errors.push('Workflow ID is required');
  if (!workflow.name) errors.push('Workflow name is required');
  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow must have at least one step');
  }

  // Step validation
  const stepIds = new Set<string>();
  for (const step of workflow.steps || []) {
    if (!step.id) {
      errors.push('Each step must have an ID');
      continue;
    }

    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.prompt) {
      errors.push(`Step "${step.id}" must have a prompt`);
    }

    // Dependency validation
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep) && !workflow.steps.some(s => s.id === dep)) {
          errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
      }
    }
  }

  // Circular dependency check
  if (workflow.steps && workflow.steps.length > 0) {
    try {
      topologicalSort(workflow.steps);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// Exports
// ============================================

export {
  WORKFLOW_DIR,
  EXECUTION_DIR,
};
