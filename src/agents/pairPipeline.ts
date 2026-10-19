import { LoopRecovery, RecoveryParkError } from './loopRecovery.js';
import { RECOVERY_ADVISOR_PARK_REASON } from '../automation/loopRecoveryTypes.js';
import { runFullIterationLoop } from './pairIterationLoop.js';
// ============================================
// OpenSwarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { taskAttributionKey, taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import { rejectedWorkerPaths } from '../support/rejectedWorkerPaths.js';
import { scratchNotesSection, workerScratchpadRunId } from './workerScratchpad.js';
import { createSnapshotState } from './iterationSnapshot.js';
import { enforcedFileScope } from '../orchestration/writeScope.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import { summarizeStageResult } from './stageSummary.js';
import { composePipelineResult, pipelineCosts } from './pairPipelineResult.js';
import type { PipelineStage, PipelineGuardsConfig, JobProfile } from '../core/types.js';
import { type CostInfo, formatCost } from '../support/costTracker.js';
import { broadcastEvent } from '../core/eventHub.js';
import { t } from '../locale/index.js';
import * as agentPair from './agentPair.js';
import {
  type ReflectionSource,
  createReflectionState,
  shouldStopReflecting,
  buildReflectionFeedback,
  DEFAULT_MAX_REFLECTIONS,
} from './reflection.js';
import { hasRepoSnapshot, scanAndCache } from '../knowledge/index.js';
import * as workerAgent from './worker.js';
import type { WorkerOptions } from './worker.js';
import { buildTaskPrefix } from './pipelineTaskPrefix.js';
import { runWorkerWithOptionalFanout } from './workerFanoutGate.js';
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
import { UNBOUNDED_TURNS } from '../adapters/agenticLoop.js';
import { safeConsole } from '../support/safeLog.js';
import { existsSync } from 'node:fs';
import { isInfraError, isTimeoutError } from '../adapters/errorClassification.js';
import { resolveAdapterDefaultModel } from './stageModelResolver.js';
import { compatibleStageModel, effortForTask, modelForTask } from './pipelineRoleSelection.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import { captureVerifyInputFingerprint, loadTrustedVerifyPlan, runTesterWithVerification } from './deterministicTester.js';
import { captureSecurityAuditBaseline, SecurityAuditInfrastructureError } from './securityAuditGate.js';
import { collectWorkerContext } from './workerContext.js';
import { guardWarningsForResult } from './guardWarningRecord.js';
import { repoNameFromPath, worktreeNameFromPath } from './repoPathNames.js';
import { assignedAgentName, coordinationContextFor, publishStageFailureToBoard, publishStageOutcomeToBoard, publishStageToBoard, stageCorrelationId } from './pipelineCoordination.js';
import { isClassifiedStageError, rethrowClassified, extractClassifiedStageResult, PipelineCancelledError } from './stageErrorClassification.js';
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
import { buildReviewerStageOptions } from './reviewerStageOptions.js';


type RunControl = { signal?: AbortSignal; stuck: StuckDetector };


export class PairPipeline extends EventEmitter {
  private config: PipelineConfig;
  /** Fallback for callers outside run(); each run() installs a fresh control via AsyncLocalStorage. */
  private stuckDetector: StuckDetector;
  /** Per-run abort + stuck controls — never share across concurrent run() calls. */
  private static runControl = new AsyncLocalStorage<RunControl>();
  /** Cache of adapter default models (heavy: OAuth + live catalog) keyed by adapter name. (INT-2393) */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();
  /** Throw if this run has been cancelled. Called at iteration/stage boundaries. */
  private throwIfAborted(): void {
    if (PairPipeline.runControl.getStore()?.signal?.aborted) throw new PipelineCancelledError();
  }
  private getStuck(): StuckDetector {
    return PairPipeline.runControl.getStore()?.stuck ?? this.stuckDetector;
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
  async run(task: TaskItem, projectPath: string, opts?: import('./pairPipelineTypes.js').PipelineRunOptions): Promise<PipelineResult> {
    // A fresh detector per run: two run() calls on one instance must not share
    // the per-run identity that runControl exists to keep separate.
    const stuckDetector = createStuckDetector({ sameErrorRepeat: 3, revisionLoop: 4 });
    return PairPipeline.runControl.run({ signal: opts?.signal, stuck: stuckDetector }, async () => {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const maxIterations = this.config.maxIterations ?? 3;

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
      snapshots: createSnapshotState(task),
      task,
      projectPath,
      session,
      config: this.config,
      currentIteration: 0,
      taskPrefix,
      reflection: createReflectionState(),
      abortSignal: opts?.signal,
      stuckDetector,
    };
    try {
      if (this.config.verify?.enabled) try {
        const plan = await loadTrustedVerifyPlan(projectPath, this.config.verify);
        context.trustedVerifyCommands = plan.commands; context.trustedVerifyPackageJsonByDirectory = plan.packageJsonByDirectory;
        context.trustedVerifyInputFingerprint = await captureVerifyInputFingerprint(projectPath);
      } catch (error) { context.trustedVerifyError = error; }
      context.recovery = await LoopRecovery.create(context, opts?.recovery, startTime);
      if (this.config.securityAudit?.enabled) {
        context.securityBaseline = await captureSecurityAuditBaseline(projectPath, this.config.securityAudit);
        safeConsole.log(`[${context.taskPrefix}] CodeQL baseline: ${context.securityBaseline.status}, ${context.securityBaseline.findings.length} finding(s)`);
        // A partial audit is accepted (the gap is permanent — see securityAuditGate),
        // but the reduced coverage must be readable from the log, not only from
        // a status word: name the languages CodeQL could not analyse (AGT-4098).
        if (context.securityBaseline.status === 'partial') {
          const skipped = context.securityBaseline.skippedCodeqlLanguages.join(', ') || 'unknown';
          safeConsole.warn(`[${context.taskPrefix}] CodeQL coverage is partial — not analysed: ${skipped}. ${context.securityBaseline.detail ?? ''}`.trimEnd());
        }
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
      const cancelled = error instanceof PipelineCancelledError || !!PairPipeline.runControl.getStore()?.signal?.aborted;
      const recoveryPark = !cancelled && error instanceof RecoveryParkError;
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
      if (!infra && !rateLimited && context.recovery && opts?.recovery?.isCurrent()) context.recovery.settle(false);
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
        finalStatus: cancelled ? 'cancelled' : recoveryPark ? 'waiting_on_operator' : rateLimited ? 'rate_limited' : infra ? 'infra_error' : 'failed',
        recovery: context.recovery?.status(),
        operatorPark: recoveryPark ? { code: RECOVERY_ADVISOR_PARK_REASON, reason: error.message } : undefined,
        failureDetail: `${classifiedStage?.stage ?? 'pipeline'}: ${error instanceof Error ? error.message : String(error)}`,
        failureSignal: isTimeoutError(error) ? 'timeout' : undefined,
        rateLimitResetsAt: rateLimited && (error as RateLimitError).resetsAt
          ? (error as RateLimitError).resetsAt! * 1000
          : undefined,
        totalDuration: Date.now() - startTime,
        totalCost: pipelineCosts(context, stages),
        iterations: context.currentIteration,
        // A crashed run still knows what the guards objected to (AGT-4439).
        guardWarnings: guardWarningsForResult(context.guardsResult?.results),
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
    });
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
      if (err instanceof PipelineCancelledError || PairPipeline.runControl.getStore()?.signal?.aborted) throw err;
      safeConsole.warn(`[${context.taskPrefix}] ${stage} skipped (non-blocking failure): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runTester(context: PipelineContext, overrides?: { model?: string; modelRole?: ModelRole }): Promise<TesterResult> {
    if (!context.workerResult) throw new Error('Worker result required for tester');
    if (context.trustedVerifyError) throw context.trustedVerifyError;
    const testerResult = await runTesterWithVerification({
      projectPath: context.projectPath,
      verify: this.config.verify,
      trustedCommands: context.trustedVerifyCommands, trustedPackageJsonByDirectory: context.trustedVerifyPackageJsonByDirectory,
      trustedInputFingerprint: context.trustedVerifyInputFingerprint,
      // Only an explicit `enabled: false` turns the LLM tester off (AGT-4679).
      llmFallback: this.config.roles?.tester?.enabled !== false,
      onInfra: (error) => {
        // The fallback changes what "tester passed" means — an LLM opinion in
        // place of ruff/pytest — so it goes to the stage log (stdout, dashboard)
        // and not only to stderr, where 29 of them went unnoticed (AGT-4416).
        const line = `Deterministic verify unavailable; ${this.config.roles?.tester?.enabled === false ? 'LLM tester is disabled, no verdict' : 'falling back to LLM tester'}: ${error instanceof Error ? error.message : String(error)}`;
        safeConsole.warn(`[${context.taskPrefix}] ${line}`);
        this.emit('log', { line });
      },
      fallback: () => testerAgent.runTester({
        taskTitle: context.task.title, taskDescription: context.task.description || '',
        workerResult: context.workerResult!, projectPath: context.projectPath,
        timeoutMs: stageTimeoutMs('tester', this.config.roles?.tester?.timeoutMs),
        model: compatibleStageModel(this.config, 'tester', overrides?.model ?? this.config.roles?.tester?.model, overrides?.modelRole ?? 'tester'),
        // Coding stages run without a turn ceiling unless configured (AGT-4388).
        maxTurns: this.config.roles?.tester?.maxTurns ?? UNBOUNDED_TURNS,
        adapterName: this.config.roles?.tester?.adapter,
        // Declarative role scope travels with the role, like maxTurns above. The
        // loop applies it last, so it can only narrow the exposed set. (RoleConfig)
        toolAllow: this.config.roles?.tester?.tools?.allow,
        toolDeny: this.config.roles?.tester?.tools?.deny,
        // Task/jobProfile effort wins; the role's own declared effort is the floor.
        reasoningEffort: effortForTask(this.config, context.task) ?? this.config.roles?.tester?.effort,
      }),
    });
    return testerResult;
  }

  /** 복구 판정은 실제 단계 바깥에서 기록해 lease 실패를 단계 성공으로 바꾸지 않는다. */
  private async runStage(stage: PipelineStage, context: PipelineContext,
    overrides?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high'; modelRole?: ModelRole }): Promise<StageResult> {
    const recovery = context.recovery;
    if (recovery?.parkReason) throw new RecoveryParkError(recovery.parkReason);
    const cached = await recovery?.restore(stage);
    if (cached) {
      this.emit('stage:start', { stage, context, model: 'checkpoint', reused: true });
      this.emit('stage:complete', { stage, result: cached, context, reused: true });
      return cached;
    }
    recovery?.start(stage);
    const model = recovery?.model(stage) ?? overrides?.model ?? modelForTask(this.config, stage, context.task)
      ?? (recovery ? await resolveAdapterDefaultModel(this.config.roles?.[stage]?.adapter, this.defaultModelCache) : undefined);
    const effective = recovery?.model(stage) ? { ...overrides, model, modelRole: 'escalate' as const } : overrides;
    let result: StageResult;
    try { result = await this.executeStage(stage, context, effective); }
    catch (error) {
      const failed = extractClassifiedStageResult(error);
      if (failed) await recovery?.complete(failed, model, error);
      if (recovery?.parkReason) throw new RecoveryParkError(recovery.parkReason);
      throw error;
    }
    await recovery?.complete(result, model);
    if (recovery?.parkReason) throw new RecoveryParkError(recovery.parkReason);
    return result;
  }

  /** Run a single stage. */
  private async executeStage(
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
          // A run whose working directory vanished (superseded and re-dispatched
          // before its tree was rebuilt, a prune, a hand removal) used to start
          // the agent anyway; it read "empty repository" and parked an operator
          // question about data access that was never missing (AGT-4080). The
          // `worktree-missing:` prefix is an infra pattern, so the runner backs
          // off and rebuilds the tree on the next attempt instead of counting it.
          if (!existsSync(context.projectPath)) {
            throw new Error(`worktree-missing: working directory is gone before the worker started: ${context.projectPath}`);
          }
          agentPair.updateSessionStatus(context.session.id, 'working');
          const taskId = taskEventKey(context.task);
          const onLog = (line: string) =>
            broadcastEvent({ type: 'log', data: { taskId, stage: 'worker', line: `[${prefix}] ${line}` } });

          // 코드 컨텍스트 수집 (첫 시도 정확도 향상 목적)
          const workerContext = await collectWorkerContext(context, this.config.draftAnalysis);
          if (workerContext && this.config.verbose) {
            const modCount = (workerContext.impactAnalysis?.directModules.length ?? 0)
              + (workerContext.impactAnalysis?.dependentModules.length ?? 0);
            const briefCount = workerContext.registryBriefs?.length ?? 0;
            this.emit('log', { line: `[verbose] Worker context: ${modCount} affected modules, ${briefCount} file briefs` });
          }

          // Self-repair feedback: objective lint/test errors (reflection trail)
          // and the reviewer's revision prompt are always carried forward. The
          // worker is stateless per iteration, so there is no context to reset;
          // dropping this task signal made workers repeat partial implementations.
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
          // The write-scope fence rejected these paths on an earlier iteration of
          // this worktree. Without saying so, the loop cannot escape a demand it
          // is structurally unable to satisfy: on AX-1556 the reviewer asked for
          // a change to a file outside the worker's scope, and three successive
          // workers tried to comply and were each failed by the fence — the last
          // of them having otherwise addressed every point the reviewer raised.
          // The task then ran out of iterations with the real blocker untouched.
          //
          // Sourced from the rejected-path registry rather than a prior turn so
          // every stateless worker iteration receives the structural constraint.
          // (AGT-4451)
          const fenced = rejectedWorkerPaths(context.projectPath);
          const scopeFencePart = fenced.length > 0
            ? '## Outside your write scope — do not edit these\n'
              + 'An earlier iteration changed these paths and the write-scope fence '
              + 'rejected the whole result for it:\n'
              + fenced.map((file) => `- ${file}`).join('\n') + '\n\n'
              + 'Editing any of them fails this iteration no matter what else you get right. '
              + 'If the review above asks for a change there, do not make it — say so in your '
              + 'summary instead, naming the path and what was asked, so it reaches the pull '
              + 'request as a known gap rather than being silently dropped.'
            : undefined;
          const scratchNotesPart = await scratchNotesSection(context.task);
          const combinedFeedback =
            [scratchNotesPart, priorSessionPart, reflectionPart, reviewPart, scopeFencePart, context.recovery?.feedback]
              .filter(Boolean).join('\n\n') || undefined;

          const workerOptions: WorkerOptions = {
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            authoritativeOperatorFeedback: context.task.authoritativeOperatorFeedback,
            projectPath: context.projectPath,
            previousFeedback: combinedFeedback,
            scratchpadRunId: workerScratchpadRunId(context.task),
            memoryContext: { taskId: taskAttributionKey(context.task), iteration: context.currentIteration },
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
            // Coding stages run without a turn ceiling unless configured; the
            // wall-clock, the repeated-call guard and maxIterations bound them.
            // Read-only stages below keep their adapter defaults. (AGT-4388)
            maxTurns: this.config.roles?.worker?.maxTurns ?? UNBOUNDED_TURNS,
            adapterName: this.config.roles?.worker?.adapter,
            // Declarative role scope travels with the role, like maxTurns above;
            // the loop applies it last so it can only narrow. (RoleConfig.tools)
            toolAllow: this.config.roles?.worker?.tools?.allow,
            toolDeny: this.config.roles?.worker?.tools?.deny,
            // Precedence mirrors model resolution: an explicit per-run override
            // (escalation) wins, then the task's jobProfile effort, then the
            // role's own declared effort. (RoleConfig.effort)
            reasoningEffort: overrides?.reasoningEffort ?? effortForTask(this.config, context.task) ?? this.config.roles?.worker?.effort,
            bashTimeoutMs: await workerAgent.resolveWorkerBashTimeout(context.projectPath, overrides?.reasoningEffort ?? effortForTask(this.config, context.task)), // INT-2415
            sandbox: this.config.workerSandbox,
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
            runSnapshotHash: context.runSnapshotHash,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: taskAttributionKey(context.task), stage: 'worker' },
            workerContext,
            signal: PairPipeline.runControl.getStore()?.signal,
            instructionCapsule: this.config.instructionCapsule,
            projectGoal: this.config.projectGoal,
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
          const reviewerOptions = await buildReviewerStageOptions({
            config: this.config, context, prefix, overrides, abortSignal: PairPipeline.runControl.getStore()?.signal,
          });

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
          result = await this.runTester(context, overrides);
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
            toolAllow: this.config.roles?.documenter?.tools?.allow,
            toolDeny: this.config.roles?.documenter?.tools?.deny,
            reasoningEffort: effortForTask(this.config, context.task) ?? this.config.roles?.documenter?.effort,
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
            toolAllow: this.config.roles?.auditor?.tools?.allow,
            toolDeny: this.config.roles?.auditor?.tools?.deny,
            reasoningEffort: effortForTask(this.config, context.task) ?? this.config.roles?.auditor?.effort,
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
            toolAllow: this.config.roles?.['skill-documenter']?.tools?.allow,
            toolDeny: this.config.roles?.['skill-documenter']?.tools?.deny,
            reasoningEffort: effortForTask(this.config, context.task) ?? this.config.roles?.['skill-documenter']?.effort,
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

  private stageMetadata(context: PipelineContext): PipelineRunMetadata {
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
  private async runFullIterationLoop(context: PipelineContext, stages: StageResult[]): Promise<{ success: boolean }> {
    return runFullIterationLoop({
      config: this.config, throwIfAborted: () => this.throwIfAborted(), getStuck: () => this.getStuck(),
      hasStage: (stage) => this.hasStage(stage), runStage: (stage, ctx, overrides) => this.runStage(stage, ctx, overrides),
      shouldAbortSelfRepair: (ctx, progressed, source) => this.shouldAbortSelfRepair(ctx, progressed, source),
      emit: (event, payload) => this.emit(event, payload),
    }, context, stages);
  }

  /**
   * Build pipeline result
   */
  private buildResult(
    context: PipelineContext,
    stages: StageResult[],
    startTime: number
  ): PipelineResult {
    context.recovery?.settle(context.session.status === 'approved');
    const result = composePipelineResult(context, stages, startTime);
    this.emit(result.success ? 'pipeline:complete' : 'pipeline:fail', result);
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
  instructionCapsule?: PipelineConfig['instructionCapsule'],
  roleMcpTools?: PipelineConfig['roleMcpTools'],
  adapterRouting?: PipelineConfig['adapterRouting'],
  workerSandbox?: PipelineConfig['workerSandbox'],
  taskBudgetMs?: number,
  projectGoal?: string,
  loopAdvisor?: PipelineConfig['loopAdvisor'], advisorRole?: PipelineConfig['advisorRole'],
): PairPipeline {
  const stages: PipelineStage[] = [];

  if (roles?.worker?.enabled !== false) {
    stages.push('worker');
  }
  if (roles?.reviewer?.enabled !== false) {
    stages.push('reviewer');
  }
  if (roles?.tester?.enabled || verify?.enabled) {
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
    taskBudgetMs,
    maxReflections,
    roles,
    guards,
    jobProfiles,
    draftAnalysis,
    runMetadata,
    verify,
    securityAudit,
    resumedTaskFiles,
    instructionCapsule,
    roleMcpTools,
    adapterRouting,
    workerSandbox,
    projectGoal, loopAdvisor, advisorRole,
  });
}

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
