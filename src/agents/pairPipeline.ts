// ============================================
// OpenSwarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================
import { EventEmitter } from 'node:events';
import { taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { PipelineStage, PipelineGuardsConfig, JobProfile } from '../core/types.js';
import { type CostInfo, aggregateCosts, formatCost } from '../support/costTracker.js';
import { broadcastEvent } from '../core/eventHub.js';
import { CONFIDENCE_THRESHOLDS } from './agentPair.js';
import * as agentPair from './agentPair.js';
import { runGuards } from './pipelineGuards.js';
import {
  type ReflectionSource,
  createReflectionState,
  recordReflection,
  shouldStopReflecting,
  buildReflectionFeedback,
  similarReviewFeedback,
  DEFAULT_MAX_REFLECTIONS,
} from './reflection.js';
import { buildRepeatEscalation, resolveWorkerStageOverrides } from './workerEscalation.js';
import { hasRepoSnapshot, scanAndCache } from '../knowledge/index.js';
import * as workerAgent from './worker.js';
import type { WorkerOptions } from './worker.js';
import { buildTaskPrefix } from './pipelineTaskPrefix.js';
import { emitWorkerFanoutGateDecision, evaluateWorkerFanoutGate, runWorkerWithOptionalFanout } from './workerFanoutGate.js';
import type {
  PipelineConfig,
  PipelineContext,
  PipelineResult,
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
import { isInfraError, isTimeoutError } from '../adapters/errorClassification.js';
import { resolveAdapterDefaultModel } from './stageModelResolver.js';
import { compatibleStageModel, effortForTask, modelForTask } from './pipelineRoleSelection.js';
import { captureVerifyInputFingerprint, loadTrustedVerifyPlan, runTesterWithVerification } from './deterministicTester.js';
import { captureSecurityAuditBaseline, collectIntroducedSecurityFindings, formatSecurityFinding, SecurityAuditInfrastructureError } from './securityAuditGate.js';
import { collectWorkerContext } from './workerContext.js';
import { isClassifiedStageError, rethrowClassified, extractClassifiedStageResult, PipelineCancelledError } from './stageErrorClassification.js';
import {
  isTesterCodeFile,
  isValidationRelevantFile,
  missingWorkerValidationIssues,
  testerWouldRunForWorkerResult,
} from './workerValidationEvidence.js';
export { PipelineCancelledError };
export type {
  PipelineConfig,
  PipelineContext,
  PipelineEventType,
  PipelineResult,
  PipelineRunMetadata,
  StageResult,
} from './pairPipelineTypes.js';
export { buildTaskPrefix } from './pipelineTaskPrefix.js';
export { stageTimeoutMs } from './stageTimeouts.js';
import { stageTimeoutMs } from './stageTimeouts.js';

export class PairPipeline extends EventEmitter {
  private config: PipelineConfig;
  private stuckDetector: StuckDetector;
  /** Set per run() — aborts the pipeline + in-flight adapter call on cancel/disable. */
  private abortSignal?: AbortSignal;
  /** Cache of adapter default models (heavy: OAuth + live catalog) keyed by adapter name. (INT-2393) */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();
  /** Throw if this run has been cancelled. Called at iteration/stage boundaries. */
  private throwIfAborted(): void {
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

  // ============================================
  // Main Execution
  // ============================================

  /**
   * Run pipeline
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure at any stage, returns to Worker (up to maxIterations)
   */
  async run(task: TaskItem, projectPath: string, opts?: { signal?: AbortSignal }): Promise<PipelineResult> {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const maxIterations = this.config.maxIterations ?? 3;
    this.abortSignal = opts?.signal;

    // Reset stuck detector (new pipeline run)
    this.stuckDetector.reset();

    // Ensure repo graph snapshot exists (first-time scan if needed)
    if (!hasRepoSnapshot(projectPath)) {
      safeConsole.log(`[Pipeline] No repo snapshot found, scanning ${projectPath}...`);
      try {
        await scanAndCache(projectPath);
      } catch (e) {
        safeConsole.warn(`[Pipeline] Repo scan failed (non-blocking):`, e);
      }
    }

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

    const taskPrefix = buildTaskPrefix(task, projectPath);
    const context: PipelineContext = {
      task,
      projectPath,
      session,
      config: this.config,
      currentIteration: 0,
      taskPrefix,
      reflection: createReflectionState(),
    };
    try {
      if (this.config.verify?.enabled) try {
        const plan = await loadTrustedVerifyPlan(projectPath, this.config.verify);
        context.trustedVerifyCommands = plan.commands; context.trustedVerifyPackageJsonByDirectory = plan.packageJsonByDirectory;
        context.trustedVerifyInputFingerprint = await captureVerifyInputFingerprint(projectPath);
      } catch (error) { context.trustedVerifyError = error; }
      if (this.config.securityAudit?.enabled) {
        context.securityBaseline = await captureSecurityAuditBaseline(projectPath, this.config.securityAudit);
        safeConsole.log(`[${context.taskPrefix}] CodeQL baseline: ${context.securityBaseline.status}, ${context.securityBaseline.findings.length} finding(s)`);
      }
      const iterationResult = await this.runFullIterationLoop(context, stages);

      if (!iterationResult.success) {
        return this.buildResult(context, stages, startTime);
      }
      // Run Documenter after all stages pass
      if (this.hasStage('documenter') && context.workerResult?.success) {
        if (this.config.skipDocumenterIfNoChange && !context.workerResult.filesChanged?.length) {
          safeConsole.log(`[${context.taskPrefix}] Skipping documenter: no files changed`);
        } else {
          await this.runPostSuccessStage('documenter', context, stages);
        }
      }

      // Auditor (post-success, non-blocking)
      if (this.hasStage('auditor') && context.workerResult?.success) {
        const auditorFiles = context.workerResult.filesChanged?.length ?? 0;
        if (auditorFiles < (this.config.skipAuditorUnderFileCount ?? 3)) {
          safeConsole.log(`[${context.taskPrefix}] Skipping auditor: ${auditorFiles} files changed`);
        } else {
          await this.runPostSuccessStage('auditor', context, stages);
        }
      }

      // Skill Documenter (post-success, non-blocking)
      if (this.hasStage('skill-documenter') && context.workerResult?.success) {
        await this.runPostSuccessStage('skill-documenter', context, stages);
      }

      // Success
      agentPair.updateSessionStatus(session.id, 'approved');
      return this.buildResult(context, stages, startTime);

    } catch (error) {
      // Cancellation (project disable / manual stop) is not a failure — surface it
      // as 'cancelled' so the scheduler doesn't count it failed or trigger a retry.
      const cancelled = error instanceof PipelineCancelledError || !!this.abortSignal?.aborted;
      // A 429/usage-limit propagates up here from any stage (worker/reviewer/…).
      // Surface it as its own finalStatus so the runner pauses until quota resets
      // instead of counting a failure and spamming Linear comments. (INT-1906)
      const rateLimited = !cancelled && error instanceof RateLimitError;
      // An infra/CLI failure (worker/reviewer never ran: non-zero exit, auth,
      // spawn, timeout) is not a task failure — surface it distinctly so the
      // runner does a backoff retry instead of counting it toward STUCK. (INT-2010)
      const infra = !cancelled && !rateLimited && (error instanceof SecurityAuditInfrastructureError || isInfraError(error));
      const classifiedStage = extractClassifiedStageResult(error); // INT-2424
      if (classifiedStage) stages.push(classifiedStage);
      if (cancelled) {
        safeConsole.log(`[${context.taskPrefix}] Pipeline cancelled`);
      } else if (rateLimited) {
        safeConsole.warn(`[${context.taskPrefix}] Pipeline rate-limited: ${(error as RateLimitError).message}`);
      } else if (infra) {
        safeConsole.warn(`[${context.taskPrefix}] Pipeline infra error (not counted toward STUCK): ${error instanceof Error ? error.message : String(error)}`);
      } else {
        safeConsole.error('[%s] Error:', context.taskPrefix, error);
      }
      agentPair.updateSessionStatus(session.id, 'failed');
      return {
        success: false,
        sessionId: session.id,
        stages,
        finalStatus: cancelled ? 'cancelled' : rateLimited ? 'rate_limited' : infra ? 'infra_error' : 'failed',
        failureSignal: isTimeoutError(error) ? 'timeout' : undefined,
        rateLimitResetsAt: rateLimited && (error as RateLimitError).resetsAt
          ? (error as RateLimitError).resetsAt! * 1000
          : undefined,
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
  /**
   * Worker에 주입할 코드 컨텍스트 수집
   * Draft 분석이 있으면 재사용, 없으면 직접 수집
   */
  /** Check if a stage is enabled. */
  private hasStage(stage: PipelineStage): boolean {
    return this.config.stages.includes(stage);
  }
  /** Post-success non-blocking stage: its failure (incl. rate-limit/infra) must
   *  NEVER revert the approved task; only cancellation propagates. (INT-2521) */
  private async runPostSuccessStage(stage: PipelineStage, context: PipelineContext, stages: StageResult[]): Promise<void> {
    try { stages.push(await this.runStage(stage, context)); }
    catch (err) {
      if (err instanceof PipelineCancelledError || this.abortSignal?.aborted) throw err;
      safeConsole.warn(`[${context.taskPrefix}] ${stage} skipped (non-blocking failure): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runTester(context: PipelineContext): Promise<TesterResult> {
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
        model: this.config.roles?.tester?.model, maxTurns: this.config.roles?.tester?.maxTurns,
        adapterName: this.config.roles?.tester?.adapter,
      }),
    });
    return testerResult;
  }

  /** Run a single stage. */
  private async runStage(
    stage: PipelineStage,
    context: PipelineContext,
    overrides?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high' }
  ): Promise<StageResult> {
    const startTime = Date.now();
    // Display model: explicit override → configured (jobProfile/role) → adapter
    // default (so the TUI/dashboard aren't blank when config omits it). (INT-2393)
    const stageModel = compatibleStageModel(this.config, stage, overrides?.model)
      ?? modelForTask(this.config, stage, context.task)
      ?? await resolveAdapterDefaultModel(this.config.roles?.[stage]?.adapter, this.defaultModelCache);
    const prefix = context.taskPrefix;
    const metadata = this.stageMetadata(context);
    safeConsole.log(`[${prefix}] Stage starting: ${stage}`);
    this.emit('stage:start', { stage, context, model: stageModel });
    broadcastEvent({ type: 'pipeline:stage', data: { taskId: taskEventKey(context.task), stage, status: 'start', model: stageModel, ...metadata } });

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
            projectPath: context.projectPath,
            previousFeedback: combinedFeedback,
            timeoutMs: stageTimeoutMs('worker', this.config.roles?.worker?.timeoutMs),
            // getModelForRole gives the matched jobProfile's model precedence (config's
            // light/heavy → gpt-5.5/5.4), falling back to roles.worker.model. Reading
            // roles.worker.model directly here silently dropped the jobProfile model, so a
            // codex worker fell through to the CLI's config.toml default (Codex-Spark). (INT-1599)
            model: compatibleStageModel(this.config, 'worker', overrides?.model)
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
            // Knowledge-graph scope is useful for scheduling conflicts, but it is
            // advisory and may be stale. Only an explicitly planner-declared
            // scope may reject real Git changes at the worker boundary.
            fileScope: context.task.fileScopeSource === 'inferred'
              ? undefined
              : context.task.fileScope,
            resumedTaskFiles: this.config.resumedTaskFiles,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: taskEventKey(context.task), stage: 'worker' },
            workerContext,
            signal: this.abortSignal,
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
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: stageTimeoutMs('reviewer', this.config.roles?.reviewer?.timeoutMs),
            // jobProfile model precedence (see worker stage above). (INT-1599)
            model: compatibleStageModel(this.config, 'reviewer', overrides?.model)
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
          };

          safeConsole.log(`[${prefix}] Running full review...`);
          result = await reviewerAgent.runReviewer(reviewerOptions);

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
            model: this.config.roles?.documenter?.model,
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
            model: this.config.roles?.auditor?.model,
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
            model: this.config.roles?.['skill-documenter']?.model,
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

  private stageMetadata(context: PipelineContext): PipelineRunMetadata {
    const configured = this.config.runMetadata ?? {};
    const projectPath = configured.projectPath ?? context.projectPath;
    return {
      repository: configured.repository ?? context.task.linearProject?.name ?? repoNameFromPath(projectPath),
      projectPath,
      worktree: configured.worktree ?? worktreeNameFromPath(projectPath),
      branch: configured.branch,
      issueIdentifier: configured.issueIdentifier ?? context.task.issueIdentifier ?? context.task.issueId,
      title: configured.title ?? context.task.title,
    };
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

  /**
   * Decide whether to stop the bounded self-repair loop after an objective
   * (lint/bs/test) failure. Aborts when the agent is stagnating (identical
   * errors twice in a row) or has spent its reflection budget — either way
   * further retries only burn tokens (the regression guard from the task spec).
   * Returns true when the caller should terminate the pipeline as failed.
   */
  private shouldAbortSelfRepair(
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
      safeConsole.log(`[${context.taskPrefix}] No worker stage configured`);
      return { success: false };
    }

    while (context.currentIteration < maxIterations) {
      this.throwIfAborted(); // bail before starting another iteration
      context.currentIteration++;

      // Stuck detection check (before iteration starts)
      const stuckCheck = this.stuckDetector.check();
      if (stuckCheck.isStuck) {
        context.stuckReason = stuckCheck.reason;
        safeConsole.error(`[${context.taskPrefix}] STUCK DETECTED: ${stuckCheck.reason}`);
        safeConsole.error(`[${context.taskPrefix}] Suggestion: ${stuckCheck.suggestion}`);
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
      broadcastEvent({ type: 'pipeline:iteration', data: { taskId: taskEventKey(context.task), iteration: context.currentIteration } });

      safeConsole.log(`[${context.taskPrefix}] Iteration ${context.currentIteration}/${maxIterations}`);

      // ========== WORKER (with escalation) ==========
      // Iteration-count escalation + one-shot signal escalation (INT-2475) —
      // policy lives in workerEscalation.ts; the signal takes precedence.
      const workerOverrides = resolveWorkerStageOverrides({
        workerCfg: this.config.roles?.worker,
        iteration: context.currentIteration,
        baseModel: modelForTask(this.config, 'worker', context.task),
        signalEscalation: context.workerEscalation,
        taskId: taskEventKey(context.task),
        taskPrefix: context.taskPrefix,
      });

      const fanoutDecision = evaluateWorkerFanoutGate({
        task: context.task,
        draftAnalysis: this.config.draftAnalysis,
        iteration: context.currentIteration,
        feedbackSource: context.feedbackSource,
        effort: effortForTask(this.config, context.task),
        config: this.config.roles?.worker?.fanout,
      });
      context.workerFanoutDecision = fanoutDecision;
      emitWorkerFanoutGateDecision({
        context,
        decision: fanoutDecision,
        verbose: this.config.verbose,
        emit: (event, payload) => this.emit(event, payload),
      });

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
        const failedWorker = workerResult.result as WorkerResult;
        const detail = failedWorker.error
          ?? failedWorker.haltReason
          ?? failedWorker.noChangesReason
          ?? failedWorker.summary;
        safeConsole.log(`[${context.taskPrefix}] Worker failed, retrying...${detail ? ` (${detail.slice(0, 500)})` : ''}`);
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
        safeConsole.log(`[${context.taskPrefix}] Running pipeline guards...`);
        const guardsResult = await runGuards(
          context.workerResult,
          context.projectPath,
          this.config.guards,
        );
        context.guardsResult = guardsResult;

        if (!guardsResult.allPassed) {
          // Blocking guard failed → bad edit. Skip the (expensive) reviewer and
          // drive a bounded self-repair retry with the exact errors preserved.
          const blocking = guardsResult.results.filter(r => !r.passed && r.blocking);
          const blockingIssues = blocking.flatMap(r => r.issues);
          safeConsole.log(`[${context.taskPrefix}] Blocking guard failed: ${blockingIssues.join('; ')}`);

          // qualityGate is the lint/type bad-edit check; bsDetector is code-smell.
          const source: ReflectionSource = blocking.some(r => r.guard === 'qualityGate') ? 'lint' : 'bs';
          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source,
            errors: blockingIssues,
          });

          context.reviewResult = {
            decision: 'revise',
            feedback: `Pipeline guard failed: ${blockingIssues.join('; ')}`,
            issues: blockingIssues,
            suggestions: ['Fix the issues flagged by quality guards'],
          };
          context.feedbackSource = 'objective';
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');

          if (this.shouldAbortSelfRepair(context, progressed, source)) {
            return { success: false };
          }
          continue;
        }

        // Log non-blocking guard warnings
        const warnings = guardsResult.results.filter(r => !r.passed && !r.blocking);
        if (warnings.length > 0) {
          safeConsole.log(`[${context.taskPrefix}] Guard warnings: ${warnings.map(w => w.guard).join(', ')}`);
          this.emit('log', {
            line: `⚠️ Guard warnings: ${warnings.flatMap(w => w.issues).join('; ')}`,
          });
        }
      }

      // CodeQL is a post-edit gate, not a tester-stage feature. Run it after a
      // successful worker pass so every pipeline shape — including
      // worker/reviewer-only configurations — must clear the same baseline-diff
      // check before an approval is possible.
      const introducedSecurityFindings = await collectIntroducedSecurityFindings(context);
      if (introducedSecurityFindings.length > 0) {
        const failures = introducedSecurityFindings.map(formatSecurityFinding);
        safeConsole.log(`[${context.taskPrefix}] New CodeQL findings, retrying...`);
        const { progressed } = recordReflection(context.reflection, {
          iteration: context.currentIteration,
          source: 'test',
          errors: failures,
        });
        context.reviewResult = {
          decision: 'revise',
          feedback: `New deterministic CodeQL findings:\n${failures.join('\n')}`,
          issues: failures,
          suggestions: ['Resolve every new CodeQL finding without suppressing its rule or weakening the audit.'],
        };
        context.feedbackSource = 'objective';
        agentPair.trackFailure(context.session.id);
        this.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'tester',
          context,
        });
        agentPair.updateSessionStatus(context.session.id, 'revising');

        if (this.shouldAbortSelfRepair(context, progressed, 'test')) {
          return { success: false };
        }
        continue;
      }

      // A code-changing worker that reports no commands is usually a low-accuracy
      // partial implementation: the reviewer then spends a full pass rediscovering
      // that nothing was built, tested, or smoke-checked. When there is no tester
      // stage to provide objective evidence, bounce it back immediately with a
      // ground-truth validation reflection.
      if (hasReviewer && context.workerResult && !testerWouldRunForWorkerResult(
        context.workerResult,
        hasTester,
        this.config.skipTesterIfNoCodeChange ?? true, this.config.verify?.enabled === true,
      )) {
        const validationIssues = missingWorkerValidationIssues(context.workerResult);
        if (validationIssues.length > 0) {
          // Missing validation evidence is a nudge, not a verdict, and it must
          // cost AT MOST ONE iteration. A per-iteration bounce consumed the whole
          // budget when the worker kept editing DIFFERENT files without running a
          // check (each bounce "progresses", so the stagnation-defer never trips)
          // → widespread Max-iteration STUCKs. Nudge once, then DEFER to the
          // reviewer (the real quality gate) for the rest of the session. (INT-2485)
          if (!context.validationNudged) {
            context.validationNudged = true;
            recordReflection(context.reflection, {
              iteration: context.currentIteration,
              source: 'validation',
              errors: validationIssues,
            });
            safeConsole.log(`[${context.taskPrefix}] Missing worker validation evidence: ${validationIssues.join('; ')}`);
            context.reviewResult = {
              decision: 'revise',
              feedback: `Worker validation evidence missing: ${validationIssues.join('; ')}`,
              issues: validationIssues,
              suggestions: ['Run a relevant validation command before asking for review'],
            };
            context.feedbackSource = 'objective';
            agentPair.trackFailure(context.session.id);
            this.emit('iteration:fail', {
              iteration: context.currentIteration,
              stage: 'worker',
              context,
            });
            agentPair.updateSessionStatus(context.session.id, 'revising');
            continue;
          }
          safeConsole.log(`[${context.taskPrefix}] Validation evidence still missing — deferring to reviewer (already nudged once)`);
          this.emit('log', { line: '⚠️ Validation evidence missing; deferring to reviewer' });
        }
      }

      // ========== HALT CHECK (confidence too low) ==========
      if (context.workerResult) {
        const confidence = agentPair.calculateConfidence(context.workerResult);
        // A degenerate no-op HALTs INDEPENDENTLY of self-reported confidence — a
        // worker can claim 90% while changing nothing, so it must not slip past. (INT-2521)
        const degenerate = agentPair.isDegenerateWorkerResult(context.workerResult);
        if (degenerate || confidence < CONFIDENCE_THRESHOLDS.HALT) {
          const haltReason = degenerate ? 'Worker produced no changes'
            : (context.workerResult.haltReason || `Low confidence: ${confidence}%`);
          safeConsole.warn(`[${context.taskPrefix}] HALT triggered: confidence=${confidence}%, degenerate=${degenerate}, reason=${haltReason}`);
          this.emit('halt', { confidence, haltReason, sessionId: context.session.id, iteration: context.currentIteration, context });
          // Degenerate no-op → escalate the next attempt (stronger effort/model) vs the same empty run to STUCK. (INT-2521)
          if (degenerate && !context.workerEscalation) {
            context.workerEscalation = buildRepeatEscalation({
              workerCfg: this.config.roles?.worker,
              currentIteration: context.currentIteration,
              currentModel: modelForTask(this.config, 'worker', context.task),
              currentEffort: effortForTask(this.config, context.task),
            });
          }
          context.reviewResult = {
            decision: 'revise',
            feedback: degenerate
              ? 'Your previous attempt produced ZERO file changes and ran no commands — you did not implement anything. Read the relevant files and make concrete edits now.'
              : `[HALT] Confidence too low (${confidence}%). ${haltReason}`,
            issues: [degenerate ? 'Worker produced no changes' : haltReason],
            suggestions: ['Review task requirements', 'Provide additional context', 'Break into sub-tasks'],
          };
          context.feedbackSource = 'review';
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', { iteration: context.currentIteration, stage: 'worker', context });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
      }

      // ========== TESTER (before reviewer — INT-1703) ==========
      // Run the tester first so the reviewer judges code + test outcomes
      // together, and so a failing test drives INT-1679 self-repair WITHOUT
      // spending a reviewer pass. Runs exactly once per iteration.
      if (hasTester) {
        // Skip tester if no code files changed (configurable, default true)
        const skipIfNoCode = this.config.skipTesterIfNoCodeChange ?? true;
        const changedFiles = context.workerResult?.filesChanged || [];
        const hasCodeChange = changedFiles.some(file => (this.config.verify?.enabled || this.config.securityAudit?.enabled)
          ? isValidationRelevantFile(file)
          : isTesterCodeFile(file));
        if (skipIfNoCode && !hasCodeChange) {
          safeConsole.log(`[${context.taskPrefix}] Skipping tester: no code files changed (${changedFiles.length} files: ${changedFiles.join(', ') || 'none'})`);
        } else {
        const testerResult = await this.runStage('tester', context);
        stages.push(testerResult);

        const hasNewSecurityFindings = (context.newSecurityFindings?.length ?? 0) > 0;
        const reviewerShouldJudgeFailure = context.testerResult?.deterministic === true && !hasNewSecurityFindings;
        if (!testerResult.success && !this.config.continueOnTestFail && !reviewerShouldJudgeFailure) {
          // Test failure is objective ground truth → record into the reflection
          // trail and drive a bounded self-repair retry (INT-1679).
          safeConsole.log(`[${context.taskPrefix}] Tester failed, retrying...`);
          agentPair.trackFailure(context.session.id); // Track for fresh context decision

          const failedTests = context.testerResult?.failedTests ?? [];
          const testErrors = failedTests.length > 0
            ? failedTests
            : [context.testerResult?.error || `Tests failed (${context.testerResult?.testsFailed ?? 0} failing)`];
          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source: 'test',
            errors: testErrors,
          });

          if (context.testerResult) {
            context.reviewResult = {
              decision: 'revise',
              feedback: testerAgent.buildTestFixPrompt(context.testerResult),
              issues: context.testerResult.failedTests,
              suggestions: context.testerResult.suggestions,
            };
          }
          context.feedbackSource = 'objective';

          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'tester',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');

          if (this.shouldAbortSelfRepair(context, progressed, 'test')) {
            return { success: false };
          }
          continue;
        }
        } // end else (has code change)
      }

      // ========== REVIEWER ==========
      if (hasReviewer) {
        agentPair.updateSessionStatus(context.session.id, 'reviewing');

        // Reviewer escalation: 로컬 모델이 N회 이상 REVISE → 상위 모델로 spot check
        const reviewerCfg = this.config.roles?.reviewer;
        const reviewerEscalateModel = reviewerCfg?.escalateModel;
        const reviewerEscalateThreshold = reviewerCfg?.escalateAfterIteration ?? 3;
        const shouldEscalateReviewer = context.currentIteration >= reviewerEscalateThreshold && !!reviewerEscalateModel;

        const reviewerOverrides = shouldEscalateReviewer
          ? { model: reviewerEscalateModel }
          : undefined;

        if (shouldEscalateReviewer && reviewerEscalateModel) {
          safeConsole.log(`[${context.taskPrefix}] Reviewer escalation → ${reviewerEscalateModel} (iteration ${context.currentIteration})`);
          this.emit('log', {
            line: `🔍 Reviewer spot check: escalating to ${reviewerEscalateModel}`,
          });
        }

        const reviewerResult = await this.runStage('reviewer', context, reviewerOverrides);
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
          // reject = terminate immediately (keep the real feedback for the retry)
          context.lastReviseFeedback = (reviewerResult.result as ReviewResult).feedback ?? context.lastReviseFeedback;
          safeConsole.log(`[${context.taskPrefix}] Reviewer rejected`);
          agentPair.updateSessionStatus(context.session.id, 'rejected');
          return { success: false };
        }

        if (decision === 'revise') {
          const reviseFeedback = (reviewerResult.result as ReviewResult).feedback ?? '';

          // The reflection stagnation detector only counts OBJECTIVE sources, so
          // a reviewer that keeps saying the same thing never trips it — failing
          // sessions used to burn every remaining iteration on feedback the
          // worker demonstrably isn't absorbing (measured: 146 max-iteration
          // exhaustions vs 21 objective aborts). Two consecutive near-identical
          // revise feedbacks → first ESCALATE the worker once (higher model
          // and/or effort — the current tier has proven it can't absorb this
          // feedback, INT-2475); if it repeats even after escalation, end the
          // session — the runner persists the feedback and the NEXT attempt
          // starts with it injected (INT-2474).
          if (
            context.lastReviseFeedback
            && similarReviewFeedback(context.lastReviseFeedback, reviseFeedback)
          ) {
            const escalation = !context.workerEscalation
              ? buildRepeatEscalation({
                  workerCfg: this.config.roles?.worker,
                  currentIteration: context.currentIteration,
                  currentModel: modelForTask(this.config, 'worker', context.task),
                  currentEffort: effortForTask(this.config, context.task),
                })
              : undefined;
            if (escalation) {
              context.workerEscalation = escalation;
              const target = [
                escalation.model ? `model→${escalation.model}` : '',
                escalation.reasoningEffort ? `effort→${escalation.reasoningEffort}` : '',
              ].filter(Boolean).join(', ');
              safeConsole.log(`[${context.taskPrefix}] Reviewer repeated the same feedback — escalating worker (${target})`);
              this.emit('log', { line: `⬆️ Worker escalation on repeated review feedback (${target})` });
              broadcastEvent({ type: 'pipeline:escalation', data: {
                taskId: taskEventKey(context.task),
                iteration: context.currentIteration,
                reason: 'repeated-review-feedback',
                toModel: escalation.model,
                toEffort: escalation.reasoningEffort,
              } });
            } else {
              const reason = context.workerEscalation
                ? 'reviewer repeated the same revise feedback even after worker escalation'
                : 'reviewer repeated the same revise feedback — no escalation tier available';
              safeConsole.log(`[${context.taskPrefix}] Aborting session early: ${reason}`);
              this.emit('log', { line: `🛑 ${reason}` });
              this.emit('iteration:fail', {
                iteration: context.currentIteration,
                stage: 'reviewer',
                context,
              });
              agentPair.updateSessionStatus(context.session.id, 'failed');
              return { success: false };
            }
          }
          context.lastReviseFeedback = reviseFeedback;

          // revise = next iteration. Reviewer feedback is subjective → it travels
          // through the reviewer channel and is dropped on a fresh-context reset.
          safeConsole.log(`[${context.taskPrefix}] Reviewer requested revision`);
          context.feedbackSource = 'review';
          agentPair.trackFailure(context.session.id); // Track for fresh context decision
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'reviewer',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        agentPair.resetFailureStreak(context.session.id); // Reset on approval
      }

      if (context.testerResult?.deterministic === true
        && context.testerResult.success === false
        && (this.config.verify?.blockOnNewFailures === true || (context.newSecurityFindings?.length ?? 0) > 0)) {
        safeConsole.log(`[${context.taskPrefix}] Deterministic verification has a blocking new failure`);
        this.emit('iteration:fail', { iteration: context.currentIteration, stage: 'tester', context });
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }
      safeConsole.log(`[${context.taskPrefix}] Iteration ${context.currentIteration} completed successfully`);
      this.emit('iteration:complete', {
        iteration: context.currentIteration,
        context,
      });
      return { success: true };
    }

    safeConsole.log(`[${context.taskPrefix}] Max iterations (${maxIterations}) exceeded`);
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return { success: false };
  }

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
      safeConsole.log(`[${context.taskPrefix}] Total cost: ${formatCost(totalCost)}`);
      broadcastEvent({ type: 'task:cost', data: { taskId: taskEventKey(context.task), cost: totalCost } });
    }
    const result: PipelineResult = {
      success,
      sessionId: context.session.id,
      stages,
      finalStatus,
      failureSignal: context.stuckReason ? 'stuck'
        : context.guardsResult?.results.some(r => r.blocking && !r.passed) || context.testerResult?.success === false ? 'gate-fail' : undefined,
      stuckReason: context.stuckReason,
      totalDuration: Date.now() - startTime,
      iterations: context.currentIteration,
      workerResult: context.workerResult,
      reviewResult: context.reviewResult,
      lastReviewFeedback: context.lastReviseFeedback,
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

// Factory Functions

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
  jobProfiles?: JobProfile[],
  draftAnalysis?: PipelineConfig['draftAnalysis'],
  maxReflections?: number,
  runMetadata?: PipelineRunMetadata,
  verify?: PipelineConfig['verify'],
  resumedTaskFiles?: string[],
  securityAudit?: PipelineConfig['securityAudit'],
): PairPipeline {
  const stages: PipelineStage[] = [];

  if (roles?.worker?.enabled !== false) {
    stages.push('worker');
  }
  if (roles?.reviewer?.enabled !== false) {
    stages.push('reviewer');
  }
  if (roles?.tester?.enabled || verify?.enabled || securityAudit?.enabled) {
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
    maxReflections,
    roles,
    guards,
    jobProfiles,
    draftAnalysis,
    runMetadata,
    verify,
    securityAudit,
    resumedTaskFiles,
  });
}

function repoNameFromPath(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const normalized = projectPath.replace(/\/+$/, '').replace(/\/worktree\/[^/]+$/, '');
  return normalized.split('/').pop();
}

function worktreeNameFromPath(projectPath?: string): string | undefined {
  return projectPath?.match(/\/worktree\/([^/]+)\/?$/)?.[1];
}

// Helpers

/**
 * Extract a worker-readable summary of what the agent did during a stage so
 * the dashboard can display "wrote 4 files / approved / reviewed N issues"
 * instead of just "stage=worker status=complete".
 *
 * Returns a plain object suitable for inclusion in the SSE `pipeline:stage`
 * broadcast payload. Fields are optional — missing ones are simply omitted.
 */
function summarizeStageResult(
  stage: PipelineStage,
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult,
): Record<string, unknown> {
  // Cap arrays/strings before broadcasting so a chatty agent cannot blow up
  // the SSE channel with a 10MB stage event.
  const MAX_FILES = 12;
  const MAX_COMMANDS = 8;
  const SUMMARY_CAP = 240;
  const FEEDBACK_CAP = 480;
  const cap = (s: string | undefined, n: number): string | undefined =>
    s == null ? undefined : (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  switch (stage) {
    case 'worker': {
      const r = result as WorkerResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.filesChanged?.length ?? 0,
        commands: Array.isArray(r.commands) ? r.commands.slice(0, MAX_COMMANDS) : undefined,
        commandsCount: r.commands?.length ?? 0,
        confidencePercent: r.confidencePercent,
        haltReason: r.haltReason,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'reviewer': {
      const r = result as ReviewResult;
      return {
        decision: r.decision,
        feedback: cap(r.feedback, FEEDBACK_CAP),
        issuesCount: r.issues?.length ?? 0,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        suggestionsCount: r.suggestions?.length ?? 0,
      };
    }

    case 'tester': {
      const r = result as TesterResult;
      return {
        passed: r.testsPassed,
        failed: r.testsFailed,
        coverage: r.coverage,
        failedTests: Array.isArray(r.failedTests) ? r.failedTests.slice(0, MAX_FILES) : undefined,
        deterministic: r.deterministic,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'documenter': {
      const r = result as DocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        changelogEntry: cap(r.changelogEntry, SUMMARY_CAP),
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'auditor': {
      const r = result as AuditorResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        bsScore: r.bsScore,
        criticalCount: r.criticalCount,
        warningCount: r.warningCount,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        issuesCount: r.issues?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'skill-documenter': {
      const r = result as SkillDocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    default:
      return {};
  }
}

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
