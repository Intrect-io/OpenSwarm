// ============================================
// Claude Swarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================

import { EventEmitter } from 'node:events';
import type { TaskItem } from './decisionEngine.js';
import type { WorkerResult, ReviewResult, PairSession } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { PipelineStage, RoleConfig } from './types.js';

import * as agentPair from './agentPair.js';
import * as workerAgent from './worker.js';
import * as reviewerAgent from './reviewer.js';
import * as testerAgent from './tester.js';
import * as documenterAgent from './documenter.js';
import { StuckDetector, createStuckDetector } from './stuckDetector.js';

// ============================================
// Types
// ============================================

export interface PipelineConfig {
  /** List of active stages (executed in order) */
  stages: PipelineStage[];
  /** Whether to continue on test failure */
  continueOnTestFail?: boolean;
  /** Skip Documenter if no changes */
  skipDocumenterIfNoChange?: boolean;
  /** Max total iterations (one cycle = Worker → Reviewer → Tester) */
  maxIterations?: number;
  /** Per-role configuration */
  roles?: {
    worker?: RoleConfig;
    reviewer?: RoleConfig;
    tester?: RoleConfig;
    documenter?: RoleConfig;
  };
}

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult;
  duration: number;
}

export interface PipelineResult {
  success: boolean;
  sessionId: string;
  stages: StageResult[];
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled';
  totalDuration: number;
  /** Total number of completed iterations */
  iterations: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  /** Task context (for reporting) */
  taskContext?: {
    issueIdentifier?: string;
    projectName?: string;
    projectPath?: string;
    taskTitle?: string;
  };
}

export interface PipelineContext {
  task: TaskItem;
  projectPath: string;
  session: PairSession;
  config: PipelineConfig;
  /** Current iteration number (1-based) */
  currentIteration: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
}

// ============================================
// Pipeline Events
// ============================================

export type PipelineEventType =
  | 'stage:start'
  | 'stage:complete'
  | 'stage:fail'
  | 'iteration:start'
  | 'iteration:complete'
  | 'iteration:fail'
  | 'pipeline:complete'
  | 'pipeline:fail';

// ============================================
// Pair Pipeline
// ============================================

export class PairPipeline extends EventEmitter {
  private config: PipelineConfig;
  private stuckDetector: StuckDetector;

  constructor(config: PipelineConfig) {
    super();
    this.config = {
      continueOnTestFail: false,
      skipDocumenterIfNoChange: true,
      maxIterations: 3,
      ...config,
    };
    // Initialize stuck detector
    this.stuckDetector = createStuckDetector({
      sameErrorRepeat: 2,
      revisionLoop: 4,
    });
  }

  // ============================================
  // Main Execution
  // ============================================

  /**
   * Run pipeline
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure at any stage, returns to Worker (up to maxIterations)
   */
  async run(task: TaskItem, projectPath: string): Promise<PipelineResult> {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const maxIterations = this.config.maxIterations ?? 3;

    // Reset stuck detector (new pipeline run)
    this.stuckDetector.reset();

    // Create session
    const session = agentPair.createPairSession({
      taskId: task.issueIdentifier || task.issueId || task.id,
      taskTitle: task.title,
      taskDescription: task.description || '',
      projectPath,
      maxAttempts: maxIterations,
      models: {
        worker: this.config.roles?.worker?.model,
        reviewer: this.config.roles?.reviewer?.model,
      },
    });

    const context: PipelineContext = {
      task,
      projectPath,
      session,
      config: this.config,
      currentIteration: 0,
    };

    try {
      // Full iteration loop: Worker → Reviewer → Tester
      const iterationResult = await this.runFullIterationLoop(context, stages);

      if (!iterationResult.success) {
        return this.buildResult(context, stages, startTime);
      }

      // Run Documenter after all stages pass
      if (this.hasStage('documenter') && context.workerResult?.success) {
        if (
          this.config.skipDocumenterIfNoChange &&
          (!context.workerResult.filesChanged || context.workerResult.filesChanged.length === 0)
        ) {
          console.log('[Pipeline] Skipping documenter: no files changed');
        } else {
          const documenterResult = await this.runStage('documenter', context);
          stages.push(documenterResult);
          // Documenter failure does not cause overall failure
        }
      }

      // Success
      agentPair.updateSessionStatus(session.id, 'approved');
      return this.buildResult(context, stages, startTime);

    } catch (error) {
      console.error('[Pipeline] Error:', error);
      agentPair.updateSessionStatus(session.id, 'failed');
      return {
        success: false,
        sessionId: session.id,
        stages,
        finalStatus: 'failed',
        totalDuration: Date.now() - startTime,
        iterations: context.currentIteration,
        workerResult: context.workerResult,
        reviewResult: context.reviewResult,
        testerResult: context.testerResult,
        documenterResult: context.documenterResult,
        taskContext: {
          issueIdentifier: context.task.issueIdentifier || context.task.issueId,
          projectName: context.task.linearProject?.name,
          projectPath: context.projectPath,
          taskTitle: context.task.title,
        },
      };
    }
  }

  // ============================================
  // Stage Execution
  // ============================================

  /**
   * Check if a stage is enabled
   */
  private hasStage(stage: PipelineStage): boolean {
    return this.config.stages.includes(stage);
  }

  /**
   * Run a single stage
   */
  private async runStage(
    stage: PipelineStage,
    context: PipelineContext
  ): Promise<StageResult> {
    const startTime = Date.now();
    this.emit('stage:start', { stage, context });

    try {
      let result: WorkerResult | ReviewResult | TesterResult | DocumenterResult;

      switch (stage) {
        case 'worker':
          agentPair.updateSessionStatus(context.session.id, 'working');
          result = await workerAgent.runWorker({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            projectPath: context.projectPath,
            previousFeedback: context.reviewResult
              ? reviewerAgent.buildRevisionPrompt(context.reviewResult)
              : undefined,
            timeoutMs: this.config.roles?.worker?.timeoutMs ?? 0,
            model: this.config.roles?.worker?.model,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
          });
          agentPair.saveWorkerResult(context.session.id, result as WorkerResult);
          context.workerResult = result as WorkerResult;
          break;

        case 'reviewer':
          agentPair.updateSessionStatus(context.session.id, 'reviewing');
          if (!context.workerResult) {
            throw new Error('Worker result required for reviewer');
          }
          result = await reviewerAgent.runReviewer({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.reviewer?.timeoutMs ?? 0,
            model: this.config.roles?.reviewer?.model,
          });
          agentPair.saveReviewerResult(context.session.id, result as ReviewResult);
          context.reviewResult = result as ReviewResult;
          break;

        case 'tester':
          if (!context.workerResult) {
            throw new Error('Worker result required for tester');
          }
          result = await testerAgent.runTester({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.tester?.timeoutMs ?? 0,
            model: this.config.roles?.tester?.model,
          });
          context.testerResult = result as TesterResult;
          break;

        case 'documenter':
          if (!context.workerResult) {
            throw new Error('Worker result required for documenter');
          }
          result = await documenterAgent.runDocumenter({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.documenter?.timeoutMs ?? 0,
            model: this.config.roles?.documenter?.model,
          });
          context.documenterResult = result as DocumenterResult;
          break;

        default:
          throw new Error(`Unknown stage: ${stage}`);
      }

      const stageResult: StageResult = {
        stage,
        success: this.isStageSuccess(stage, result),
        result,
        duration: Date.now() - startTime,
      };

      this.emit('stage:complete', { stage, result: stageResult, context });
      return stageResult;

    } catch (error) {
      const stageResult: StageResult = {
        stage,
        success: false,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } as any,
        duration: Date.now() - startTime,
      };

      this.emit('stage:fail', { stage, result: stageResult, context, error });
      return stageResult;
    }
  }

  /**
   * Determine stage success
   */
  private isStageSuccess(
    stage: PipelineStage,
    result: WorkerResult | ReviewResult | TesterResult | DocumenterResult
  ): boolean {
    switch (stage) {
      case 'worker':
        return (result as WorkerResult).success;

      case 'reviewer':
        return (result as ReviewResult).decision === 'approve';

      case 'tester':
        return (result as TesterResult).success;

      case 'documenter':
        return (result as DocumenterResult).success;

      default:
        return false;
    }
  }

  // ============================================
  // Full Iteration Loop
  // ============================================

  /**
   * Full iteration loop
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure (revise) at any stage, restart from Worker in next iteration
   * reject = immediate termination
   */
  private async runFullIterationLoop(
    context: PipelineContext,
    stages: StageResult[]
  ): Promise<{ success: boolean }> {
    const maxIterations = this.config.maxIterations ?? 3;
    const hasWorker = this.hasStage('worker');
    const hasReviewer = this.hasStage('reviewer');
    const hasTester = this.hasStage('tester');

    // No point without a worker
    if (!hasWorker) {
      console.log('[Pipeline] No worker stage configured');
      return { success: false };
    }

    while (context.currentIteration < maxIterations) {
      context.currentIteration++;

      // Stuck detection check (before iteration starts)
      const stuckCheck = this.stuckDetector.check();
      if (stuckCheck.isStuck) {
        console.error(`[Pipeline] STUCK DETECTED: ${stuckCheck.reason}`);
        console.error(`[Pipeline] Suggestion: ${stuckCheck.suggestion}`);
        this.emit('stuck', {
          reason: stuckCheck.reason,
          suggestion: stuckCheck.suggestion,
          context,
        });
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }

      this.emit('iteration:start', {
        iteration: context.currentIteration,
        maxIterations,
        context,
      });

      console.log(`[Pipeline] Iteration ${context.currentIteration}/${maxIterations}`);

      // ========== WORKER ==========
      agentPair.updateSessionStatus(context.session.id, 'working');
      const workerResult = await this.runStage('worker', context);
      stages.push(workerResult);

      // Record Worker result in stuck detector
      this.stuckDetector.addEntry({
        stage: 'worker',
        success: workerResult.success,
        output: (workerResult.result as WorkerResult).summary,
        error: (workerResult.result as WorkerResult).error,
        timestamp: Date.now(),
      });

      if (!workerResult.success) {
        console.log('[Pipeline] Worker failed, retrying...');
        this.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'worker',
          context,
        });
        continue; // Next iteration
      }

      // ========== REVIEWER ==========
      if (hasReviewer) {
        agentPair.updateSessionStatus(context.session.id, 'reviewing');
        const reviewerResult = await this.runStage('reviewer', context);
        stages.push(reviewerResult);

        const decision = (reviewerResult.result as ReviewResult).decision;

        // Record Reviewer result in stuck detector
        this.stuckDetector.addEntry({
          stage: 'reviewer',
          success: reviewerResult.success,
          decision: decision,
          output: (reviewerResult.result as ReviewResult).feedback,
          timestamp: Date.now(),
        });

        if (decision === 'reject') {
          // reject = terminate immediately
          console.log('[Pipeline] Reviewer rejected');
          agentPair.updateSessionStatus(context.session.id, 'rejected');
          return { success: false };
        }

        if (decision === 'revise') {
          // revise = next iteration
          console.log('[Pipeline] Reviewer requested revision');
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'reviewer',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        // approve → proceed to Tester
      }

      // ========== TESTER ==========
      if (hasTester) {
        const testerResult = await this.runStage('tester', context);
        stages.push(testerResult);

        if (!testerResult.success && !this.config.continueOnTestFail) {
          // Test failed → set feedback then next iteration
          console.log('[Pipeline] Tester failed, retrying...');

          if (context.testerResult) {
            context.reviewResult = {
              decision: 'revise',
              feedback: testerAgent.buildTestFixPrompt(context.testerResult),
              issues: context.testerResult.failedTests,
              suggestions: context.testerResult.suggestions,
            };
          }

          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'tester',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
      }

      // ========== ALL PASSED ==========
      console.log(`[Pipeline] Iteration ${context.currentIteration} completed successfully`);
      this.emit('iteration:complete', {
        iteration: context.currentIteration,
        context,
      });
      return { success: true };
    }

    // maxIterations exceeded
    console.log(`[Pipeline] Max iterations (${maxIterations}) exceeded`);
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return { success: false };
  }

  // ============================================
  // Result Building
  // ============================================

  /**
   * Build pipeline result
   */
  private buildResult(
    context: PipelineContext,
    stages: StageResult[],
    startTime: number
  ): PipelineResult {
    const session = agentPair.getPairSession(context.session.id);
    const finalStatus = session?.status as PipelineResult['finalStatus'] || 'failed';
    const success = finalStatus === 'approved';

    const result: PipelineResult = {
      success,
      sessionId: context.session.id,
      stages,
      finalStatus,
      totalDuration: Date.now() - startTime,
      iterations: context.currentIteration,
      workerResult: context.workerResult,
      reviewResult: context.reviewResult,
      testerResult: context.testerResult,
      documenterResult: context.documenterResult,
      taskContext: {
        issueIdentifier: context.task.issueIdentifier || context.task.issueId,
        projectName: context.task.linearProject?.name,
        projectPath: context.projectPath,
        taskTitle: context.task.title,
      },
    };

    if (success) {
      this.emit('pipeline:complete', result);
    } else {
      this.emit('pipeline:fail', result);
    }

    return result;
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create default pipeline (Worker + Reviewer)
 */
export function createDefaultPipeline(maxIterations = 3): PairPipeline {
  return new PairPipeline({
    stages: ['worker', 'reviewer'],
    maxIterations,
  });
}

/**
 * Create full pipeline (Worker + Reviewer + Tester + Documenter)
 */
export function createFullPipeline(
  config?: Partial<PipelineConfig>
): PairPipeline {
  return new PairPipeline({
    stages: ['worker', 'reviewer', 'tester', 'documenter'],
    maxIterations: 3,
    continueOnTestFail: false,
    skipDocumenterIfNoChange: true,
    ...config,
  });
}

/**
 * Create pipeline from configuration
 */
export function createPipelineFromConfig(
  roles: PipelineConfig['roles'],
  maxIterations = 3
): PairPipeline {
  const stages: PipelineStage[] = [];

  if (roles?.worker?.enabled !== false) {
    stages.push('worker');
  }
  if (roles?.reviewer?.enabled !== false) {
    stages.push('reviewer');
  }
  if (roles?.tester?.enabled) {
    stages.push('tester');
  }
  if (roles?.documenter?.enabled) {
    stages.push('documenter');
  }

  return new PairPipeline({
    stages,
    maxIterations,
    roles,
  });
}

// ============================================
// Formatting
// ============================================

/**
 * Format pipeline result as a Discord message
 */
export function formatPipelineResult(result: PipelineResult): string {
  const statusEmoji = {
    approved: '✅',
    rejected: '❌',
    failed: '💥',
    cancelled: '🚫',
  }[result.finalStatus];

  const lines: string[] = [];

  // Task context header
  if (result.taskContext) {
    const ctx = result.taskContext;
    const parts: string[] = [];
    // projectName fallback: extract from projectPath if not provided
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');
    if (displayName) parts.push(`📁 ${displayName}`);
    if (ctx.issueIdentifier) parts.push(`🔖 ${ctx.issueIdentifier}`);
    if (ctx.projectPath) parts.push(`\`${ctx.projectPath.split('/').slice(-2).join('/')}\``);
    if (parts.length > 0) {
      lines.push(parts.join(' | '));
    }
    if (ctx.taskTitle) {
      lines.push(`📋 ${ctx.taskTitle}`);
    }
    lines.push('');
  }

  lines.push(`${statusEmoji} **파이프라인 ${result.finalStatus.toUpperCase()}**`);
  lines.push('');
  lines.push(`**세션:** \`${result.sessionId}\``);
  lines.push(`**Iterations:** ${result.iterations}`);
  lines.push(`**소요 시간:** ${(result.totalDuration / 1000).toFixed(1)}s`);

  lines.push('');
  lines.push('**스테이지:**');
  for (const stage of result.stages) {
    const emoji = stage.success ? '✅' : '❌';
    const duration = (stage.duration / 1000).toFixed(1);
    lines.push(`  ${emoji} ${stage.stage} (${duration}s)`);
  }

  return lines.join('\n');
}
