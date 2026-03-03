// ============================================
// OpenSwarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================

import { EventEmitter } from 'node:events';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { WorkerResult, ReviewResult, PairSession } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { PipelineStage, RoleConfig, PipelineGuardsConfig } from '../core/types.js';
import { type CostInfo, aggregateCosts, formatCost } from '../support/costTracker.js';

import { broadcastEvent } from '../core/eventHub.js';
import { CONFIDENCE_THRESHOLDS } from './agentPair.js';
import * as agentPair from './agentPair.js';
import { runGuards, type GuardsRunResult } from './pipelineGuards.js';
import * as workerAgent from './worker.js';
import * as reviewerAgent from './reviewer.js';
import * as testerAgent from './tester.js';
import * as documenterAgent from './documenter.js';
import * as auditorAgent from './auditor.js';
import * as skillDocumenterAgent from './skillDocumenter.js';
import { StuckDetector, createStuckDetector } from '../support/stuckDetector.js';

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
    auditor?: RoleConfig;
    'skill-documenter'?: RoleConfig;
  };
  /** Pipeline guards configuration */
  guards?: Partial<PipelineGuardsConfig>;
}

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult | { success: false; error: string };
  duration: number;
  /** Stage start time (epoch ms) */
  startedAt: number;
  /** Stage completion time (epoch ms) */
  completedAt: number;
}

export interface PipelineResult {
  success: boolean;
  sessionId: string;
  stages: StageResult[];
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed';
  totalDuration: number;
  /** Total number of completed iterations */
  iterations: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  /** Task context (for reporting) */
  taskContext?: {
    issueIdentifier?: string;
    projectName?: string;
    projectPath?: string;
    taskTitle?: string;
  };
  /** PR URL (auto-created PR in worktree mode) */
  prUrl?: string;
  /** Total cost across all stages */
  totalCost?: CostInfo;
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
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  guardsResult?: GuardsRunResult;
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
  | 'pipeline:fail'
  | 'halt';

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

      // Auditor (post-success, non-blocking)
      if (this.hasStage('auditor') && context.workerResult?.success) {
        const auditorResult = await this.runStage('auditor', context);
        stages.push(auditorResult);
        // Auditor failure does not affect overall success
      }

      // Skill Documenter (post-success, non-blocking)
      if (this.hasStage('skill-documenter') && context.workerResult?.success) {
        const sdResult = await this.runStage('skill-documenter', context);
        stages.push(sdResult);
        // Skill Documenter failure does not affect overall success
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
    context: PipelineContext,
    overrides?: { model?: string }
  ): Promise<StageResult> {
    const startTime = Date.now();
    const stageModel = overrides?.model ?? this.config.roles?.[stage]?.model;
    this.emit('stage:start', { stage, context });
    broadcastEvent({ type: 'pipeline:stage', data: { taskId: context.task.id, stage, status: 'start', model: stageModel } });

    try {
      let result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult;

      switch (stage) {
        case 'worker': {
          agentPair.updateSessionStatus(context.session.id, 'working');
          const taskId = context.task.id;
          const onLog = (line: string) =>
            broadcastEvent({ type: 'log', data: { taskId, stage: 'worker', line } });

          // Check if fresh context should be used (after N failures)
          const useFreshContext = agentPair.shouldUseFreshContext(context.session.id);
          if (useFreshContext) {
            console.log('[Pipeline] Using fresh context for worker (retry with clean slate)');
            agentPair.consumeFreshContext(context.session.id);
            onLog('🔄 Using fresh context (previous attempts failed)');
          }

          result = await workerAgent.runWorker({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            projectPath: context.projectPath,
            previousFeedback: useFreshContext
              ? undefined // Fresh context: no previous feedback
              : (context.reviewResult
                  ? reviewerAgent.buildRevisionPrompt(context.reviewResult)
                  : undefined),
            timeoutMs: this.config.roles?.worker?.timeoutMs ?? 0,
            model: overrides?.model ?? this.config.roles?.worker?.model,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: context.task.id, stage: 'worker' },
          });
          agentPair.saveWorkerResult(context.session.id, result as WorkerResult);
          context.workerResult = result as WorkerResult;

          // Track confidence and check for degradation
          const attempt = context.session.worker.attempts;
          agentPair.updateConfidenceTracker(context.session.id, result as WorkerResult, attempt);

          // Check if confidence intervention is needed
          if (agentPair.needsConfidenceIntervention(context.session.id)) {
            console.warn('[Pipeline] Confidence intervention needed - early review triggered');
            const summary = agentPair.getConfidenceSummary(context.session.id);
            this.emit('log', { line: `⚠️ Low confidence detected: ${summary}` });
            // Continue to review, but reviewer should be aware of low confidence
          }

          break;
        }

        case 'reviewer':
          agentPair.updateSessionStatus(context.session.id, 'reviewing');
          if (!context.workerResult) {
            throw new Error('Worker result required for reviewer');
          }

          // Pre-check disabled - Haiku format compliance issues causing false rejections
          // Proceed directly to full Sonnet review for reliability
          console.log('[Pipeline] Running full review (Sonnet)...');
          result = await reviewerAgent.runReviewer({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.reviewer?.timeoutMs ?? 0,
            model: this.config.roles?.reviewer?.model,
            processContext: { taskId: context.task.id, stage: 'reviewer' },
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

        case 'auditor':
          if (!context.workerResult) {
            throw new Error('Worker result required for auditor');
          }
          result = await auditorAgent.runAuditor({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.auditor?.timeoutMs ?? 0,
            model: this.config.roles?.auditor?.model,
          });
          context.auditorResult = result as AuditorResult;
          break;

        case 'skill-documenter':
          if (!context.workerResult) {
            throw new Error('Worker result required for skill-documenter');
          }
          result = await skillDocumenterAgent.runSkillDocumenter({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.['skill-documenter']?.timeoutMs ?? 0,
            model: this.config.roles?.['skill-documenter']?.model,
          });
          context.skillDocumenterResult = result as SkillDocumenterResult;
          break;

        default:
          throw new Error(`Unknown stage: ${stage}`);
      }

      const completedAt = Date.now();
      const stageResult: StageResult = {
        stage,
        success: this.isStageSuccess(stage, result),
        result,
        duration: completedAt - startTime,
        startedAt: startTime,
        completedAt,
      };

      console.log(`[Pipeline] ${stage} completed at ${formatTimestamp(completedAt)} (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:complete', { stage, result: stageResult, context });
      const costInfo = (result as { costInfo?: CostInfo }).costInfo;
      broadcastEvent({ type: 'pipeline:stage', data: {
        taskId: context.task.id, stage, status: 'complete',
        model: costInfo?.model,
        inputTokens: costInfo?.inputTokens,
        outputTokens: costInfo?.outputTokens,
        costUsd: costInfo?.costUsd,
      } });
      return stageResult;

    } catch (error) {
      const completedAt = Date.now();
      const stageResult: StageResult = {
        stage,
        success: false,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        duration: completedAt - startTime,
        startedAt: startTime,
        completedAt,
      };

      console.log(`[Pipeline] ${stage} failed at ${formatTimestamp(completedAt)} (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:fail', { stage, result: stageResult, context, error });
      broadcastEvent({ type: 'pipeline:stage', data: { taskId: context.task.id, stage, status: 'fail' } });
      return stageResult;
    }
  }

  /**
   * Determine stage success
   */
  private isStageSuccess(
    stage: PipelineStage,
    result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult
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

      case 'auditor':
        return (result as AuditorResult).success;

      case 'skill-documenter':
        return (result as SkillDocumenterResult).success;

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
      broadcastEvent({ type: 'pipeline:iteration', data: { taskId: context.task.id, iteration: context.currentIteration } });

      console.log(`[Pipeline] Iteration ${context.currentIteration}/${maxIterations}`);

      // ========== WORKER (with escalation) ==========
      const workerCfg = this.config.roles?.worker;
      const escalateThreshold = workerCfg?.escalateAfterIteration ?? 3;
      const shouldEscalate = context.currentIteration >= escalateThreshold && !!workerCfg?.escalateModel;
      const workerOverrides = shouldEscalate ? { model: workerCfg!.escalateModel! } : undefined;

      if (shouldEscalate) {
        console.log(`[Pipeline] Escalating worker model → ${workerCfg!.escalateModel} (iteration ${context.currentIteration})`);
        broadcastEvent({ type: 'pipeline:escalation', data: {
          taskId: context.task.id,
          iteration: context.currentIteration,
          fromModel: workerCfg?.model,
          toModel: workerCfg!.escalateModel!,
        } });
      }

      agentPair.updateSessionStatus(context.session.id, 'working');
      const workerResult = await this.runStage('worker', context, workerOverrides);
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
        agentPair.trackFailure(context.session.id); // Track for fresh context decision
        this.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'worker',
          context,
        });
        continue; // Next iteration
      }

      // ========== PIPELINE GUARDS (post-worker, pre-reviewer) ==========
      if (this.config.guards && context.workerResult) {
        console.log('[Pipeline] Running pipeline guards...');
        const guardsResult = await runGuards(
          context.workerResult,
          context.projectPath,
          this.config.guards,
        );
        context.guardsResult = guardsResult;

        if (!guardsResult.allPassed) {
          // Blocking guard failed → inject revise, skip reviewer
          console.log(`[Pipeline] Blocking guard failed: ${guardsResult.combinedIssues.join('; ')}`);
          context.reviewResult = {
            decision: 'revise',
            feedback: `Pipeline guard failed: ${guardsResult.combinedIssues.join('; ')}`,
            issues: guardsResult.combinedIssues,
            suggestions: ['Fix the issues flagged by quality guards'],
          };
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        // Log non-blocking guard warnings
        const warnings = guardsResult.results.filter(r => !r.passed && !r.blocking);
        if (warnings.length > 0) {
          console.log(`[Pipeline] Guard warnings: ${warnings.map(w => w.guard).join(', ')}`);
          this.emit('log', {
            line: `⚠️ Guard warnings: ${warnings.flatMap(w => w.issues).join('; ')}`,
          });
        }
      }

      // ========== HALT CHECK (confidence too low) ==========
      if (context.workerResult) {
        const confidence = agentPair.calculateConfidence(context.workerResult);
        if (confidence < CONFIDENCE_THRESHOLDS.HALT) {
          const haltReason = context.workerResult.haltReason
            || `Low confidence: ${confidence}%`;
          console.warn(`[Pipeline] HALT triggered: confidence=${confidence}%, reason=${haltReason}`);

          this.emit('halt', {
            confidence,
            haltReason,
            sessionId: context.session.id,
            iteration: context.currentIteration,
            context,
          });

          // Inject revise to retry
          context.reviewResult = {
            decision: 'revise',
            feedback: `[HALT] Confidence too low (${confidence}%). ${haltReason}`,
            issues: [haltReason],
            suggestions: ['Review task requirements', 'Provide additional context', 'Break into sub-tasks'],
          };
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
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
          agentPair.trackFailure(context.session.id); // Track for fresh context decision
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'reviewer',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        // approve → proceed to Tester
        agentPair.resetFailureStreak(context.session.id); // Reset on approval
      }

      // ========== TESTER ==========
      if (hasTester) {
        const testerResult = await this.runStage('tester', context);
        stages.push(testerResult);

        if (!testerResult.success && !this.config.continueOnTestFail) {
          // Test failed → set feedback then next iteration
          console.log('[Pipeline] Tester failed, retrying...');
          agentPair.trackFailure(context.session.id); // Track for fresh context decision

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
    // Use context.session directly — do NOT re-fetch from store.
    // updateSessionStatus('approved') archives the session (deletes from Map),
    // so getPairSession() would return undefined → finalStatus = 'failed'.
    const session = context.session;
    const finalStatus = session.status as PipelineResult['finalStatus'] || 'failed';
    const success = finalStatus === 'approved';

    // Aggregate costs from all stages
    const stageCosts: (CostInfo | undefined)[] = [];
    if (context.workerResult?.costInfo) stageCosts.push(context.workerResult.costInfo);
    if (context.reviewResult?.costInfo) stageCosts.push(context.reviewResult.costInfo);
    if (context.testerResult?.costInfo) stageCosts.push(context.testerResult.costInfo);
    if (context.documenterResult?.costInfo) stageCosts.push(context.documenterResult.costInfo);
    if (context.auditorResult?.costInfo) stageCosts.push(context.auditorResult.costInfo);
    if (context.skillDocumenterResult?.costInfo) stageCosts.push(context.skillDocumenterResult.costInfo);
    const totalCost = stageCosts.length > 0 ? aggregateCosts(stageCosts) : undefined;

    if (totalCost) {
      console.log(`[Pipeline] Total cost: ${formatCost(totalCost)}`);
      broadcastEvent({ type: 'task:cost', data: { taskId: context.task.id, cost: totalCost } });
    }

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
      auditorResult: context.auditorResult,
      skillDocumenterResult: context.skillDocumenterResult,
      taskContext: {
        issueIdentifier: context.task.issueIdentifier || context.task.issueId,
        projectName: context.task.linearProject?.name,
        projectPath: context.projectPath,
        taskTitle: context.task.title,
      },
      totalCost,
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
  maxIterations = 3,
  guards?: Partial<PipelineGuardsConfig>,
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
  if (roles?.auditor?.enabled) {
    stages.push('auditor');
  }
  if (roles?.['skill-documenter']?.enabled) {
    stages.push('skill-documenter');
  }

  return new PairPipeline({
    stages,
    maxIterations,
    roles,
    guards,
  });
}

// ============================================
// Helpers
// ============================================

/** Format epoch ms to HH:MM:SS local time string */
function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS
}

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
