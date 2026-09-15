// ============================================
// OpenSwarm - Pair Pipeline (stages)
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================
import { EventEmitter } from 'node:events';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { enforcedFileScope } from '../orchestration/writeScope.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import { summarizeStageResult } from './stageSummary.js';
import type { PipelineStage } from '../core/types.js';
import { type CostInfo, formatCost } from '../support/costTracker.js';
import { broadcastEvent } from '../core/eventHub.js';
import { t } from '../locale/index.js';
import * as agentPair from './agentPair.js';
import {
  type ReflectionSource,
  buildReflectionFeedback,
  shouldStopReflecting,
  DEFAULT_MAX_REFLECTIONS,
} from './reflection.js';
import * as workerAgent from './worker.js';
import type { WorkerOptions } from './worker.js';
import { runWorkerWithOptionalFanout } from './workerFanoutGate.js';
import type {
  PipelineConfig,
  PipelineContext,
  PipelineRunMetadata,
  StageResult,
} from './pairPipelineTypes.js';
import * as reviewerAgent from './reviewer.js';
import * as testerAgent from './tester.js';
import * as documenterAgent from './documenter.js';
import * as auditorAgent from './auditor.js';
import * as skillDocumenterAgent from './skillDocumenter.js';
import { StuckDetector, createStuckDetector } from '../support/stuckDetector.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { safeConsole } from '../support/safeLog.js';
import { resolveAdapterDefaultModel } from './stageModelResolver.js';
import { compatibleStageModel, effortForTask, modelForTask } from './pipelineRoleSelection.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import { runTesterWithVerification } from './deterministicTester.js';
import { collectWorkerContext } from './workerContext.js';
import { repoNameFromPath, worktreeNameFromPath } from './repoPathNames.js';
import { assignedAgentName, coordinationContextFor, publishStageFailureToBoard, publishStageOutcomeToBoard, publishStageToBoard, stageCorrelationId } from './pipelineCoordination.js';
import { isClassifiedStageError, rethrowClassified, PipelineCancelledError } from './stageErrorClassification.js';
import { stageTimeoutMs } from './stageTimeouts.js';

/**
 * Stage-execution half of PairPipeline (the run loop lives in pairPipeline.ts).
 * PairPipeline extends this class; the shared fields and stage helpers are
 * `protected` so the subclass can read and drive them.
 */
export class PairPipelineStages extends EventEmitter {

  protected config: PipelineConfig;
  protected stuckDetector: StuckDetector;
  /** Set per run() — aborts the pipeline + in-flight adapter call on cancel/disable. */
  protected abortSignal?: AbortSignal;
  /** Cache of adapter default models (heavy: OAuth + live catalog) keyed by adapter name. (INT-2393) */
  protected defaultModelCache = new Map<string, Promise<string | undefined>>();
  /** Throw if this run has been cancelled. Called at iteration/stage boundaries. */
  protected throwIfAborted(): void {
    if (this.abortSignal?.aborted) throw new PipelineCancelledError();
  }

  constructor(config: PipelineConfig) {
    super();
    this.config = {
      continueOnTestFail: false,
      skipDocumenterIfNoChange: true,
      maxIterations: 3,
      maxReflections: DEFAULT_MAX_REFLECTIONS,
      ...config,
    };
    // Initialize stuck detector. sameErrorRepeat 3 (was 2): with errors now
    // normalized before comparison, 2 identical-after-normalization occurrences
    // were still occasionally transient (e.g. flaky network in both runs) —
    // require a third strike before declaring a loop. (INT-2507)
    this.stuckDetector = createStuckDetector({
      sameErrorRepeat: 3,
      revisionLoop: 4,
    });
  }

  /**
   * Worker에 주입할 코드 컨텍스트 수집
   * Draft 분석이 있으면 재사용, 없으면 직접 수집
   */
  /** Check if a stage is enabled. */
  protected hasStage(stage: PipelineStage): boolean {
    return this.config.stages.includes(stage);
  }
  /** Post-success non-blocking stage: its failure (incl. rate-limit/infra) must
   *  NEVER revert the approved task; only cancellation propagates. (INT-2521) */
  protected async runPostSuccessStage(stage: PipelineStage, context: PipelineContext, stages: StageResult[]): Promise<void> {
    try { stages.push(await this.runStage(stage, context)); }
    catch (err) {
      if (err instanceof PipelineCancelledError || this.abortSignal?.aborted) throw err;
      safeConsole.warn(`[${context.taskPrefix}] ${stage} skipped (non-blocking failure): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected async runTester(context: PipelineContext): Promise<TesterResult> {
    if (!context.workerResult) throw new Error('Worker result required for tester');
    if (context.trustedVerifyError) throw context.trustedVerifyError;
    const testerResult = await runTesterWithVerification({
      projectPath: context.projectPath,
      verify: this.config.verify,
      trustedCommands: context.trustedVerifyCommands, trustedPackageJsonByDirectory: context.trustedVerifyPackageJsonByDirectory,
      trustedInputFingerprint: context.trustedVerifyInputFingerprint,
      onInfra: (error) => safeConsole.warn(`[${context.taskPrefix}] Deterministic verify unavailable; falling back to LLM tester: ${error instanceof Error ? error.message : String(error)}`),
      fallback: () => testerAgent.runTester({
        taskTitle: context.task.title, taskDescription: context.task.description || '',
        workerResult: context.workerResult!, projectPath: context.projectPath,
        timeoutMs: stageTimeoutMs('tester', this.config.roles?.tester?.timeoutMs),
        model: compatibleStageModel(this.config, 'tester', this.config.roles?.tester?.model), maxTurns: this.config.roles?.tester?.maxTurns,
        adapterName: this.config.roles?.tester?.adapter,
      }),
    });
    return testerResult;
  }

  /** Run a single stage. */
  protected async runStage(
    stage: PipelineStage,
    context: PipelineContext,
    overrides?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high'; modelRole?: ModelRole }
  ): Promise<StageResult> {
    const startTime = Date.now();
    // Display model: explicit override → configured (jobProfile/role) → adapter
    // default (so the TUI/dashboard aren't blank when config omits it). (INT-2393)
    const stageModel = compatibleStageModel(this.config, stage, overrides?.model, overrides?.modelRole ?? stage)
      ?? modelForTask(this.config, stage, context.task)
      ?? await resolveAdapterDefaultModel(this.config.roles?.[stage]?.adapter, this.defaultModelCache);
    const prefix = context.taskPrefix;
    const metadata = this.stageMetadata(context);
    safeConsole.log(`[${prefix}] Stage starting: ${stage}`);
    this.emit('stage:start', { stage, context, model: stageModel });
    broadcastEvent({ type: 'pipeline:stage', data: { taskId: taskEventKey(context.task), stage, status: 'start', model: stageModel, ...metadata } });
    // One exchange id for this stage attempt, captured before anything can
    // move the iteration counter (AGT-4018).
    const exchangeId = stageCorrelationId(context, stage);
    void publishStageToBoard(context, stage, 'running', t('coordination.stage.takingOn', { title: context.task.title }), {
      model: stageModel,
      correlationId: exchangeId,
      recipientRole: stage === 'reviewer' ? 'worker' : (stage === 'worker' ? 'reviewer' : undefined),
    });

    if (this.config.verbose) {
      this.emit('log', { line: `[verbose] Stage: ${stage} | model: ${stageModel ?? 'default'} | iteration: ${context.currentIteration}` });
    }
    try {
      let result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult;

      switch (stage) {
        case 'worker': {
          agentPair.updateSessionStatus(context.session.id, 'working');
          const taskId = taskEventKey(context.task);
          const onLog = (line: string) =>
            broadcastEvent({ type: 'log', data: { taskId, stage: 'worker', line: `[${prefix}] ${line}` } });

          // Check if fresh context should be used (after N failures)
          const useFreshContext = agentPair.shouldUseFreshContext(context.session.id);
          if (useFreshContext) {
            safeConsole.log(`[${prefix}] Using fresh context for worker (retry with clean slate)`);
            agentPair.consumeFreshContext(context.session.id);
            onLog('🔄 Using fresh context (previous attempts failed)');
          }

          // 코드 컨텍스트 수집 (첫 시도 정확도 향상 목적)
          const workerContext = await collectWorkerContext(context, this.config.draftAnalysis);
          if (workerContext && this.config.verbose) {
            const modCount = (workerContext.impactAnalysis?.directModules.length ?? 0)
              + (workerContext.impactAnalysis?.dependentModules.length ?? 0);
            const briefCount = workerContext.registryBriefs?.length ?? 0;
            this.emit('log', { line: `[verbose] Worker context: ${modCount} affected modules, ${briefCount} file briefs` });
          }

          // Self-repair feedback: objective lint/test errors (reflection trail)
          // are always carried forward — ground truth that survives a fresh-context
          // reset. The reviewer's revision prompt is ALSO preserved across fresh
          // context (INT-1705): it carries the task requirement (e.g. "wire it into
          // the heartbeat / add the call site"), not chat pollution — dropping it
          // made the worker repeat the same partial impl forever. Fresh context
          // still clears the worker's own chat history; only the reviewer's task
          // signal is kept.
          const reflectionPart = buildReflectionFeedback(context.reflection);
          const includeReview =
            context.feedbackSource === 'review' && !!context.reviewResult;
          const reviewPart = includeReview
            ? reviewerAgent.buildRevisionPrompt(context.reviewResult!)
            : undefined;
          // Cross-SESSION feedback: a re-picked task that failed/was rejected
          // before carries the last reviewer feedback (persisted in task state).
          // Without this the new session starts blind and repeats the exact
          // mistake the reviewer already called out (INT-2474). First iteration
          // only — later iterations have fresher in-session feedback above.
          const priorSessionPart =
            context.currentIteration === 1 && context.task.priorAttemptFeedback
              ? '## Previous attempt failed (feedback from an earlier session)\n'
                + 'A prior run of this task did not pass. Address these points first and do not repeat them:\n'
                + context.task.priorAttemptFeedback
              : undefined;
          const combinedFeedback =
            [priorSessionPart, reflectionPart, reviewPart].filter(Boolean).join('\n\n') || undefined;

          const workerOptions: WorkerOptions = {
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            authoritativeOperatorFeedback: context.task.authoritativeOperatorFeedback,
            projectPath: context.projectPath,
            previousFeedback: combinedFeedback,
            timeoutMs: stageTimeoutMs('worker', this.config.roles?.worker?.timeoutMs),
            // getModelForRole gives the matched jobProfile's model precedence (config's
            // light/heavy → gpt-5.5/5.4), falling back to roles.worker.model. Reading
            // roles.worker.model directly here silently dropped the jobProfile model, so a
            // codex worker fell through to the CLI's config.toml default (Codex-Spark). (INT-1599)
            // `overrides.modelRole` (not the stage) so an escalation resolves as
            // an escalation. This call — not the `stageModel` above, which is the
            // display value — is the one that reaches the agent. (AGT-4273)
            model: compatibleStageModel(this.config, 'worker', overrides?.model, overrides?.modelRole ?? 'worker')
              ?? modelForTask(this.config, 'worker', context.task),
            maxTurns: this.config.roles?.worker?.maxTurns,
            adapterName: this.config.roles?.worker?.adapter,
            reasoningEffort: overrides?.reasoningEffort ?? effortForTask(this.config, context.task),
            bashTimeoutMs: await workerAgent.resolveWorkerBashTimeout(context.projectPath, overrides?.reasoningEffort ?? effortForTask(this.config, context.task)), // INT-2415
            // No-edit guard (re-applied from stranded feat/v0.7.0 commit 2eea3bc):
            // reasoning workers frequently end with analysis only and never call
            // edit_file. Without this the guard defaults to 0 (disabled) — measured:
            // codex spark AND gpt-5.5 both read 30-37× and shipped 0 edits. Push the
            // worker to actually edit before concluding.
            nudgeMaxOnNoEdit: 3,
            // Only a scope meant as the edit target is enforced; see
            // enforcedFileScope for which provenances qualify and why.
            fileScope: enforcedFileScope(context.task),
            resumedTaskFiles: this.config.resumedTaskFiles,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: taskEventKey(context.task), stage: 'worker' },
            workerContext,
            signal: this.abortSignal,
            instructionCapsule: this.config.instructionCapsule,
            mcpTools: this.config.roleMcpTools?.worker,
            adapterRouting: this.config.adapterRouting,
            coordinationContext: coordinationContextFor(context, 'worker'),
          };

          result = await runWorkerWithOptionalFanout({
            projectPath: context.projectPath,
            workerOptions,
            fanoutDecision: context.workerFanoutDecision,
            fanoutConfig: this.config.roles?.worker?.fanout,
            guards: this.config.guards,
            onLog,
            runWorker: workerAgent.runWorker,
          });
          // The assigned handle replaces whatever the model called itself, so
          // every reader of `codename` — the Linear comment among them — names
          // the agent the way the board does. (AGT-4064)
          (result as { codename?: string }).codename = assignedAgentName(context, 'worker');
          agentPair.saveWorkerResult(context.session.id, result as WorkerResult);
          context.workerResult = result as WorkerResult;

          // Verbose: emit detailed worker result info
          if (this.config.verbose) {
            const wr = result as WorkerResult;
            if (wr.filesChanged?.length) {
              this.emit('log', { line: `[verbose] Files changed: ${wr.filesChanged.join(', ')}` });
            }
            if (wr.commands?.length) {
              this.emit('log', { line: `[verbose] Commands executed: ${wr.commands.join('; ')}` });
            }
            if (wr.confidencePercent != null) {
              this.emit('log', { line: `[verbose] Worker confidence: ${wr.confidencePercent}%` });
            }
            if (wr.haltReason) {
              this.emit('log', { line: `[verbose] Worker halt reason: ${wr.haltReason}` });
            }
          }

          // Track confidence and check for degradation
          const attempt = context.session.worker.attempts;
          agentPair.updateConfidenceTracker(context.session.id, result as WorkerResult, attempt);

          // Check if confidence intervention is needed
          if (agentPair.needsConfidenceIntervention(context.session.id)) {
            safeConsole.warn(`[${prefix}] Confidence intervention needed - early review triggered`);
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
          // Proceed directly to full review for reliability.
          // NOTE: the old "high worker confidence → fewer reviewer turns" shortcut was
          // removed (INT-1914): worker confidence is self-reported, so a confidently
          // scaffolded task was getting LESS review — exactly the wrong incentive. The
          // completion-criteria hard gate is the real check now.
          const reviewerMaxTurns = this.config.roles?.reviewer?.maxTurns;
          const reviewerOptions = {
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            authoritativeOperatorFeedback: context.task.authoritativeOperatorFeedback,
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: stageTimeoutMs('reviewer', this.config.roles?.reviewer?.timeoutMs),
            // jobProfile model precedence (see worker stage above). (INT-1599)
            // `overrides.modelRole` (not the stage) so an escalation resolves as
            // an escalation. This call — not the `stageModel` above, which is the
            // display value — is the one that reaches the agent. (AGT-4273)
            model: compatibleStageModel(this.config, 'reviewer', overrides?.model, overrides?.modelRole ?? 'reviewer')
              ?? modelForTask(this.config, 'reviewer', context.task),
            maxTurns: reviewerMaxTurns,
            adapterName: this.config.roles?.reviewer?.adapter,
            reasoningEffort: effortForTask(this.config, context.task),
            completionCriteria: this.config.draftAnalysis?.completionCriteria,
            verificationEvidence: context.testerResult?.verificationEvidence,
            // Surface non-blocking guard warnings (dead-module, reformat/scope)
            // so the reviewer verifies them instead of them dying in a log. (INT-2388)
            guardWarnings: context.guardsResult?.results
              .filter(r => !r.passed && !r.blocking)
              .flatMap(r => r.issues),
            processContext: { taskId: taskEventKey(context.task), stage: 'reviewer' },
            // runReviewer has always accepted onLog; nothing passed one, so the
            // reviewer's turns never reached the dashboard/desktop console the
            // way the worker's do. (INT-3397)
            onLog: (line: string) =>
              broadcastEvent({
                type: 'log',
                data: { taskId: taskEventKey(context.task), stage: 'reviewer', line: `[${prefix}] ${line}` },
              }),
            signal: this.abortSignal,
            instructionCapsule: this.config.instructionCapsule,
            mcpTools: this.config.roleMcpTools?.reviewer,
            coordinationContext: coordinationContextFor(context, 'reviewer'),
          };

          safeConsole.log(`[${prefix}] Running full review...`);
          result = await reviewerAgent.runReviewer(reviewerOptions);

          (result as { codename?: string }).codename = assignedAgentName(context, 'reviewer');
          agentPair.saveReviewerResult(context.session.id, result as ReviewResult);
          context.reviewResult = result as ReviewResult;

          // Verbose: emit reviewer decision details
          if (this.config.verbose) {
            const rr = result as ReviewResult;
            this.emit('log', { line: `[verbose] Reviewer decision: ${rr.decision}` });
            if (rr.feedback) {
              const lines = rr.feedback.split('\n').slice(0, 10);
              for (const line of lines) {
                this.emit('log', { line: `[verbose]   ${line}` });
              }
            }
          }
          break;

        case 'tester':
          result = await this.runTester(context);
          context.testerResult = result as TesterResult;

          // Verbose: emit tester details
          if (this.config.verbose) {
            const tr = result as TesterResult;
            this.emit('log', { line: `[verbose] Tests passed: ${tr.testsPassed}, failed: ${tr.testsFailed}${tr.coverage != null ? `, coverage: ${tr.coverage}%` : ''}${tr.deterministic ? ' (deterministic)' : ''}` });
          }
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
            timeoutMs: stageTimeoutMs('documenter', this.config.roles?.documenter?.timeoutMs),
            model: compatibleStageModel(this.config, 'documenter', this.config.roles?.documenter?.model),
            maxTurns: this.config.roles?.documenter?.maxTurns,
            adapterName: this.config.roles?.documenter?.adapter,
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
            timeoutMs: stageTimeoutMs('auditor', this.config.roles?.auditor?.timeoutMs),
            model: compatibleStageModel(this.config, 'auditor', this.config.roles?.auditor?.model),
            maxTurns: this.config.roles?.auditor?.maxTurns,
            adapterName: this.config.roles?.auditor?.adapter,
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
            timeoutMs: stageTimeoutMs('skill-documenter', this.config.roles?.['skill-documenter']?.timeoutMs),
            model: compatibleStageModel(this.config, 'skill-documenter', this.config.roles?.['skill-documenter']?.model),
            maxTurns: this.config.roles?.['skill-documenter']?.maxTurns,
            adapterName: this.config.roles?.['skill-documenter']?.adapter,
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

      safeConsole.log(`[${prefix}] ${stage} completed (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:complete', { stage, result: stageResult, context });
      publishStageOutcomeToBoard(context, stage, {
        success: stageResult.success,
        durationMs: stageResult.duration,
        result,
      }, exchangeId);
      const costInfo = (result as { costInfo?: CostInfo }).costInfo;

      if (this.config.verbose) {
        // formatCost omits the misleading "$0.0000" for zero-cost (subscription) providers (INT-2508)
        this.emit('log', { line: `[verbose] Stage ${stage} completed in ${(stageResult.duration / 1000).toFixed(1)}s${costInfo ? ` | cost: ${formatCost(costInfo)}` : ''}` });
      }
      broadcastEvent({ type: 'pipeline:stage', data: {
        taskId: taskEventKey(context.task), stage, status: 'complete',
        ...metadata,
        model: costInfo?.model ?? stageModel,
        inputTokens: costInfo?.inputTokens,
        outputTokens: costInfo?.outputTokens,
        costUsd: costInfo?.costUsd,
        durationMs: stageResult.duration,
        ...summarizeStageResult(stage, result),
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

      safeConsole.log(`[${prefix}] ${stage} failed (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:fail', { stage, result: stageResult, context, error });
      publishStageFailureToBoard(context, stage, stageResult.duration, error, exchangeId);
      broadcastEvent({ type: 'pipeline:stage', data: {
        taskId: taskEventKey(context.task), stage, status: 'fail',
        ...metadata,
        model: stageModel,
        durationMs: stageResult.duration,
        rateLimitResetsAt: error instanceof RateLimitError && error.resetsAt ? error.resetsAt * 1000 : undefined,
        error: error instanceof Error ? error.message : String(error),
      } });
      if (isClassifiedStageError(error)) rethrowClassified(error, stageResult); // INT-2424
      return stageResult;
    }
  }

  protected stageMetadata(context: PipelineContext): PipelineRunMetadata {
    const configured = this.config.runMetadata ?? {};
    const projectPath = configured.projectPath ?? context.projectPath;
    return {
      repository: configured.repository ?? context.task.linearProject?.name ?? repoNameFromPath(projectPath),
      projectPath,
      coordinationRepository: configured.coordinationRepository,
      repoKey: configured.repoKey,
      worktree: configured.worktree ?? worktreeNameFromPath(projectPath),
      branch: configured.branch,
      issueIdentifier: configured.issueIdentifier ?? context.task.issueIdentifier ?? context.task.issueId,
      title: configured.title ?? context.task.title,
    };
  }

  /**
   * Determine stage success
   */
  protected isStageSuccess(
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

  /**
   * Decide whether to stop the bounded self-repair loop after an objective
   * (lint/bs/test) failure. Aborts when the agent is stagnating (identical
   * errors twice in a row) or has spent its reflection budget — either way
   * further retries only burn tokens (the regression guard from the task spec).
   * Returns true when the caller should terminate the pipeline as failed.
   */
  protected shouldAbortSelfRepair(
    context: PipelineContext,
    progressed: boolean,
    source: ReflectionSource,
  ): boolean {
    const max = this.config.maxReflections ?? DEFAULT_MAX_REFLECTIONS;
    const budgetSpent = shouldStopReflecting(context.reflection, max);
    if (progressed && !budgetSpent) return false;

    const reason = !progressed
      ? `self-repair stagnated: identical ${source} errors repeated`
      : `self-repair budget exhausted (${context.reflection.reflectionCount}/${max} objective failures)`;
    safeConsole.warn(`[${context.taskPrefix}] Aborting self-repair — ${reason}`);
    this.emit('log', { line: `🛑 ${reason}` });
    this.emit('reflection:abort', {
      reason,
      source,
      reflectionCount: context.reflection.reflectionCount,
      context,
    });
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return true;
  }
}
