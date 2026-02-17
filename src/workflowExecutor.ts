// ============================================
// Claude Swarm - Workflow Executor
// DAG-based workflow execution engine
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import * as tmux from './tmux.js';
import {
  WorkflowConfig,
  WorkflowStep,
  WorkflowExecution,
  StepResult,
  topologicalSort,
  getParallelGroups,
  saveExecution,
  loadExecution,
  loadWorkflow,
  EXECUTION_DIR,
} from './workflow.js';
import { AgentBus, createBus, StepCompletedPayload } from './agentBus.js';
import { createCheckpoint, rollbackToCheckpoint, Checkpoint } from './rollback.js';
import { checkWorkAllowed } from './timeWindow.js';

// ============================================
// Types
// ============================================

export interface ExecutorOptions {
  /** Enable parallel execution */
  parallel?: boolean;
  /** Time window check */
  checkTimeWindow?: boolean;
  /** Enable rollback */
  enableRollback?: boolean;
  /** Execution timeout (seconds) */
  timeout?: number;
  /** Dry run (no actual execution) */
  dryRun?: boolean;
  /** Start step (start from a specific step) */
  startFrom?: string;
}

export interface ExecutorResult {
  execution: WorkflowExecution;
  success: boolean;
  failedStep?: string;
  rollbackPerformed?: boolean;
  duration: number;
}

// ============================================
// Workflow Executor
// ============================================

export class WorkflowExecutor {
  private workflow: WorkflowConfig;
  private options: ExecutorOptions;
  private bus: AgentBus;
  private execution: WorkflowExecution;
  private checkpoint: Checkpoint | null = null;
  private tmuxSession: string;

  constructor(workflow: WorkflowConfig, options: ExecutorOptions = {}) {
    this.workflow = workflow;
    this.options = {
      parallel: true,
      checkTimeWindow: true,
      enableRollback: true,
      timeout: 3600,  // 1 hour
      dryRun: false,
      ...options,
    };

    const executionId = `exec-${workflow.id}-${Date.now()}`;
    this.bus = createBus(executionId);
    this.tmuxSession = `workflow-${workflow.id}`;

    this.execution = {
      workflowId: workflow.id,
      executionId,
      status: 'running',
      startedAt: Date.now(),
      stepResults: {},
    };
  }

  /**
   * Execute workflow
   */
  async execute(): Promise<ExecutorResult> {
    console.log(`[Executor] Starting workflow: ${this.workflow.name}`);
    console.log(`[Executor] Execution ID: ${this.execution.executionId}`);

    const startTime = Date.now();

    try {
      // Time window check
      if (this.options.checkTimeWindow) {
        const timeCheck = checkWorkAllowed();
        if (!timeCheck.allowed) {
          console.log(`[Executor] Blocked by time window: ${timeCheck.reason}`);
          this.execution.status = 'aborted';
          return this.createResult(false, startTime);
        }
      }

      // Initialize bus
      await this.bus.init(this.workflow.id);

      // Create checkpoint
      if (this.options.enableRollback) {
        this.checkpoint = await createCheckpoint(
          this.execution.executionId,
          this.workflow.projectPath,
          `Workflow: ${this.workflow.name}`
        );
        this.execution.checkpoint = this.checkpoint.commitHash;
      }

      // Dry run
      if (this.options.dryRun) {
        console.log('[Executor] Dry run - showing execution plan:');
        this.showExecutionPlan();
        return this.createResult(true, startTime);
      }

      // Execute
      if (this.options.parallel) {
        await this.executeParallel();
      } else {
        await this.executeSequential();
      }

      // Success check
      const allCompleted = Object.values(this.execution.stepResults)
        .every(r => r.status === 'completed' || r.status === 'skipped');

      if (allCompleted) {
        this.execution.status = 'completed';
        console.log('[Executor] Workflow completed successfully');
      } else {
        this.execution.status = 'failed';
        const failedStep = Object.entries(this.execution.stepResults)
          .find(([_, r]) => r.status === 'failed')?.[0];
        return this.createResult(false, startTime, failedStep);
      }

      return this.createResult(true, startTime);

    } catch (error: any) {
      console.error('[Executor] Workflow failed:', error.message);
      this.execution.status = 'failed';

      // Attempt rollback
      let rollbackPerformed = false;
      if (this.options.enableRollback && this.checkpoint) {
        const shouldRollback = this.workflow.onFailure === 'rollback';
        if (shouldRollback) {
          console.log('[Executor] Performing rollback...');
          const rollbackResult = await rollbackToCheckpoint(this.checkpoint.id);
          rollbackPerformed = rollbackResult.success;
        }
      }

      return this.createResult(false, startTime, undefined, rollbackPerformed);

    } finally {
      // Save execution state
      this.execution.completedAt = Date.now();
      await saveExecution(this.execution);
      await this.bus.cleanup();
    }
  }

  /**
   * Sequential execution
   */
  private async executeSequential(): Promise<void> {
    const sortedSteps = topologicalSort(this.workflow.steps);
    let startFound = !this.options.startFrom;

    for (const step of sortedSteps) {
      // Handle startFrom
      if (!startFound) {
        if (step.id === this.options.startFrom) {
          startFound = true;
        } else {
          this.execution.stepResults[step.id] = {
            stepId: step.id,
            status: 'skipped',
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          continue;
        }
      }

      const result = await this.executeStep(step);

      if (result.status === 'failed') {
        const strategy = step.onFailure || this.workflow.onFailure || 'abort';
        if (strategy === 'abort') {
          throw new Error(`Step "${step.id}" failed, aborting workflow`);
        } else if (strategy === 'rollback') {
          throw new Error(`Step "${step.id}" failed, triggering rollback`);
        }
        // skip, notify: continue execution
      }
    }
  }

  /**
   * Parallel execution
   */
  private async executeParallel(): Promise<void> {
    const groups = getParallelGroups(this.workflow.steps);
    let startFound = !this.options.startFrom;

    for (const group of groups) {
      // Handle startFrom
      if (!startFound) {
        const hasStart = group.some(s => s.id === this.options.startFrom);
        if (hasStart) {
          startFound = true;
        } else {
          // Skip entire group
          for (const step of group) {
            this.execution.stepResults[step.id] = {
              stepId: step.id,
              status: 'skipped',
              startedAt: Date.now(),
              completedAt: Date.now(),
            };
          }
          continue;
        }
      }

      console.log(`[Executor] Running parallel group: ${group.map(s => s.id).join(', ')}`);

      // Execute steps in group in parallel
      const results = await Promise.all(
        group.map(step => this.executeStep(step))
      );

      // Failure check
      const failed = results.find(r => r.status === 'failed');
      if (failed) {
        const failedStep = group.find(s => s.id === failed.stepId);
        const strategy = failedStep?.onFailure || this.workflow.onFailure || 'abort';

        if (strategy === 'abort' || strategy === 'rollback') {
          throw new Error(`Step "${failed.stepId}" failed`);
        }
      }
    }
  }

  /**
   * Execute single step
   */
  private async executeStep(step: WorkflowStep): Promise<StepResult> {
    console.log(`[Executor] Running step: ${step.name} (${step.id})`);

    const result: StepResult = {
      stepId: step.id,
      status: 'running',
      startedAt: Date.now(),
    };
    this.execution.stepResults[step.id] = result;

    // Condition check
    if (step.condition) {
      const conditionMet = await this.evaluateCondition(step.condition);
      if (!conditionMet) {
        console.log(`[Executor] Step "${step.id}" skipped: condition not met`);
        result.status = 'skipped';
        result.completedAt = Date.now();
        return result;
      }
    }

    try {
      // Create previous step context
      const context = await this.bus.createStepContext(step.id, step.dependsOn);

      // Build prompt
      const fullPrompt = this.buildPrompt(step, context);

      // Run Claude
      const output = await this.runClaude(step, fullPrompt);

      // Save result
      result.status = 'completed';
      result.output = output;
      result.completedAt = Date.now();

      // Notify bus of completion
      await this.bus.publish('step_completed', step.id, {
        stepId: step.id,
        success: true,
        output,
        changedFiles: [],  // TODO: git diff로 추출
        duration: result.completedAt - result.startedAt,
      } as StepCompletedPayload);

      console.log(`[Executor] Step "${step.id}" completed`);

    } catch (error: any) {
      result.status = 'failed';
      result.error = error.message;
      result.completedAt = Date.now();

      await this.bus.publish('error', step.id, error.message);
      console.error(`[Executor] Step "${step.id}" failed: ${error.message}`);

      // Retry
      if (step.onFailure === 'retry' && step.retryCount) {
        for (let i = 0; i < step.retryCount; i++) {
          console.log(`[Executor] Retrying step "${step.id}" (${i + 1}/${step.retryCount})`);
          try {
            const context = await this.bus.createStepContext(step.id, step.dependsOn);
            const fullPrompt = this.buildPrompt(step, context);
            const output = await this.runClaude(step, fullPrompt);

            result.status = 'completed';
            result.output = output;
            result.error = undefined;
            result.completedAt = Date.now();
            break;
          } catch (retryError: any) {
            result.error = retryError.message;
          }
        }
      }
    }

    this.execution.stepResults[step.id] = result;
    return result;
  }

  /**
   * Build prompt
   */
  private buildPrompt(step: WorkflowStep, context: string): string {
    const parts: string[] = [];

    // Workflow info
    parts.push(`# Workflow: ${this.workflow.name}`);
    parts.push(`## Step: ${step.name}`);
    parts.push('');

    // Context
    if (context) {
      parts.push(context);
      parts.push('');
    }

    // Actual prompt
    parts.push('## Task');
    parts.push(step.prompt);
    parts.push('');

    // Guidelines
    parts.push('## Guidelines');
    parts.push('- Complete the task described above');
    parts.push('- Report any errors or issues encountered');
    parts.push('- List any files you modified');

    return parts.join('\n');
  }

  /**
   * Run Claude
   */
  private async runClaude(step: WorkflowStep, prompt: string): Promise<string> {
    const expandedPath = this.workflow.projectPath.replace('~', homedir());
    const promptFile = resolve(EXECUTION_DIR, `prompt-${step.id}-${Date.now()}.txt`);

    // Save prompt file
    await fs.mkdir(EXECUTION_DIR, { recursive: true });
    await fs.writeFile(promptFile, prompt);

    // Prepare tmux pane
    const paneTarget = await this.getOrCreatePane(step.id);

    // Claude execution command
    const command = `bash -c 'cd "${expandedPath}" && claude -p "$(cat ${promptFile})" --dangerously-skip-permissions 2>&1 | tee /tmp/claude-step-${step.id}.log'`;

    await tmux.sendKeysToPane(paneTarget, command);

    // Wait for completion (simple polling)
    const timeout = (step.timeout || this.options.timeout || 3600) * 1000;
    const startTime = Date.now();
    const logFile = `/tmp/claude-step-${step.id}.log`;

    while (Date.now() - startTime < timeout) {
      await this.sleep(5000);

      // Check log file
      try {
        const log = await fs.readFile(logFile, 'utf-8');
        // Check Claude completion signal (prompt return, etc.)
        if (log.includes('claude-swarm') || log.includes('$')) {
          // Simple heuristic - needs more sophisticated completion detection
          if (log.length > 100) {
            return log;
          }
        }
      } catch {
        // File not yet created
      }
    }

    throw new Error(`Step "${step.id}" timed out after ${timeout / 1000}s`);
  }

  /**
   * Create or retrieve tmux pane
   */
  private async getOrCreatePane(_stepId: string): Promise<string> {
    // Check if session exists
    const sessionExists = await tmux.sessionExists(this.tmuxSession);

    if (!sessionExists) {
      await tmux.createSession(this.tmuxSession, this.workflow.projectPath);
    }

    // Create pane for step (new pane per step)
    const panes = await tmux.listPanes(this.tmuxSession);
    const paneIndex = panes.length;

    // Create new pane if not the first one
    if (paneIndex > 0) {
      await tmux.createPane(this.tmuxSession, this.workflow.projectPath);
    }

    return `${this.tmuxSession}:0.${paneIndex}`;
  }

  /**
   * Evaluate condition
   */
  private async evaluateCondition(condition: string): Promise<boolean> {
    // Simple condition evaluation (extensible)
    // e.g.: "step.lint.success", "context.changedFiles.length > 0"

    if (condition.startsWith('step.')) {
      const parts = condition.split('.');
      const stepId = parts[1];
      const prop = parts[2];

      const result = this.execution.stepResults[stepId];
      if (!result) return false;

      if (prop === 'success') return result.status === 'completed';
      if (prop === 'failed') return result.status === 'failed';
    }

    // Default: true
    return true;
  }

  /**
   * Show execution plan (dry run)
   */
  private showExecutionPlan(): void {
    const groups = getParallelGroups(this.workflow.steps);

    console.log('\nExecution Plan:');
    console.log('================');

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.length === 1) {
        console.log(`${i + 1}. ${group[0].name} (${group[0].id})`);
      } else {
        console.log(`${i + 1}. [Parallel]`);
        for (const step of group) {
          console.log(`   - ${step.name} (${step.id})`);
        }
      }
    }

    console.log('\nDependency Graph:');
    for (const step of this.workflow.steps) {
      if (step.dependsOn && step.dependsOn.length > 0) {
        console.log(`  ${step.id} ← ${step.dependsOn.join(', ')}`);
      }
    }
  }

  /**
   * Create result
   */
  private createResult(
    success: boolean,
    startTime: number,
    failedStep?: string,
    rollbackPerformed?: boolean
  ): ExecutorResult {
    return {
      execution: this.execution,
      success,
      failedStep,
      rollbackPerformed,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Run workflow (convenience function)
 */
export async function runWorkflow(
  workflowId: string,
  options?: ExecutorOptions
): Promise<ExecutorResult> {
  const workflow = await loadWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const executor = new WorkflowExecutor(workflow, options);
  return executor.execute();
}

/**
 * Run workflow directly from config
 */
export async function runWorkflowConfig(
  workflow: WorkflowConfig,
  options?: ExecutorOptions
): Promise<ExecutorResult> {
  const executor = new WorkflowExecutor(workflow, options);
  return executor.execute();
}

/**
 * Get execution status
 */
export async function getExecutionStatus(executionId: string): Promise<WorkflowExecution | null> {
  return loadExecution(executionId);
}

/**
 * List recent executions
 */
export async function listRecentExecutions(limit: number = 10): Promise<WorkflowExecution[]> {
  try {
    await fs.mkdir(EXECUTION_DIR, { recursive: true });
    const files = await fs.readdir(EXECUTION_DIR);
    const executions: WorkflowExecution[] = [];

    for (const file of files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit)) {
      const content = await fs.readFile(resolve(EXECUTION_DIR, file), 'utf-8');
      executions.push(JSON.parse(content));
    }

    return executions;
  } catch {
    return [];
  }
}
