// ============================================
// OpenSwarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================
import { taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';
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
  similarReviewFeedback,
} from './reflection.js';
import { buildRepeatEscalation, resolveWorkerStageOverrides } from './workerEscalation.js';
import { hasRepoSnapshot, scanAndCache } from '../knowledge/index.js';
import { buildTaskPrefix } from './pipelineTaskPrefix.js';
import { emitWorkerFanoutGateDecision, evaluateWorkerFanoutGate } from './workerFanoutGate.js';
import type {
  PipelineConfig,
  PipelineContext,
  PipelineResult,
  PipelineRunMetadata,
  StageResult,
} from './pairPipelineTypes.js';
import { WORKER_NO_CHANGES_PARK_REASON } from './pairPipelineTypes.js';
import * as testerAgent from './tester.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { safeConsole } from '../support/safeLog.js';
import { isInfraError, isTimeoutError } from '../adapters/errorClassification.js';
import { effortForTask, modelForTask } from './pipelineRoleSelection.js';
import { captureVerifyInputFingerprint, loadTrustedVerifyPlan } from './deterministicTester.js';
import { captureSecurityAuditBaseline, collectIntroducedSecurityFindings, formatSecurityFinding, SecurityAuditInfrastructureError } from './securityAuditGate.js';
import { extractClassifiedStageResult, PipelineCancelledError } from './stageErrorClassification.js';
import {
  isTesterCodeFile,
  isValidationRelevantFile,
  missingWorkerValidationIssues,
  testerWouldRunForWorkerResult,
} from './workerValidationEvidence.js';
import { PairPipelineStages } from './pairPipelineStages.js';
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

/**
 * Resolve the coordination identity for one stage of a task.
 *
 * Keyed on the task rather than the session so a call sign survives a retry:
 * an operator's answer, or another agent's advice, is addressed to the name
 * that asked, and a fresh session ID on the next attempt would strand it in an
 * inbox nobody reads. Role is part of the key so the worker and the reviewer on
 * one task never answer to the same name.
 */
export class PairPipeline extends PairPipelineStages {

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
        failureDetail: `${classifiedStage?.stage ?? 'pipeline'}: ${error instanceof Error ? error.message : String(error)}`,
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
        // Blocked-on-operator is terminal for this run, not a retryable
        // failure: every further iteration re-runs the same worker into the
        // same unanswered question, burning the iteration budget to end up
        // where we already are. The question stays open on the board; the task
        // resumes when the Discord answer lands.
        if (failedWorker.blockedOnOperator || failedWorker.executionOutcomeUnknown) {
          safeConsole.log(failedWorker.executionOutcomeUnknown ? `[${context.taskPrefix}] Worker sandbox outcome is unknown — quarantining without retry` : `[${context.taskPrefix}] Worker is waiting on an operator decision — stopping without retry`);
          // First-class status: buildResult derives finalStatus from the
          // session, and anything else here surfaces as a plain 'failed' the
          // scheduler failure-counts and backoff-retries into the same
          // unanswered question.
          context.workerResult = failedWorker;
          agentPair.updateSessionStatus(context.session.id, 'waiting_on_operator');
          this.emit('halt', {
            confidence: failedWorker.confidencePercent ?? 0,
            haltReason: failedWorker.haltReason ?? 'Blocked on an operator decision',
            sessionId: context.session.id,
            iteration: context.currentIteration,
            context,
          });
          return { success: false };
        }
        const detail = failedWorker.error
          ?? failedWorker.haltReason
          ?? failedWorker.noChangesReason
          ?? failedWorker.summary;
        // Partial progress with a residual report is not contaminated context.
        // FreshContext regenerates the same sentence and trips
        // "Same output produced 3 times" (vela 46×/30m; AGT-4275). Park so the
        // residual can become a follow-up instead of burning the retry budget.
        const madeProgress = (failedWorker.filesChanged?.length ?? 0) > 0;
        if (madeProgress && !failedWorker.error && (failedWorker.haltReason || failedWorker.summary)) {
          const residual = (failedWorker.haltReason ?? failedWorker.summary ?? '').slice(0, 500);
          safeConsole.log(`[${context.taskPrefix}] Worker partial progress with residual — parking without FreshContext retry${residual ? ` (${residual})` : ''}`);
          context.workerResult = failedWorker;
          agentPair.updateSessionStatus(context.session.id, 'waiting_on_operator');
          this.emit('halt', {
            confidence: failedWorker.confidencePercent ?? 0,
            haltReason: failedWorker.haltReason ?? failedWorker.summary ?? 'Partial progress with residual work',
            sessionId: context.session.id,
            iteration: context.currentIteration,
            context,
          });
          return { success: false };
        }
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

      // CodeQL is a post-edit gate, not a tester-stage feature. It is opt-in
      // (securityAudit.enabled, default OFF) because it is too slow to gate PRs
      // (AGT-4160). When disabled we do not even invoke the gate, so the default
      // autonomous path never runs CodeQL.
      const introducedSecurityFindings = this.config.securityAudit?.enabled
        ? await collectIntroducedSecurityFindings(context)
        : [];
      if (introducedSecurityFindings.length > 0) {
        const failures = introducedSecurityFindings.map(formatSecurityFinding);
        safeConsole.log(
          `[${context.taskPrefix}] New CodeQL findings (${failures.length}): ${
            failures.slice(0, 3).join('; ')
          }${failures.length > 3 ? ` (+${failures.length - 3} more)` : ''}`,
        );
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

        // `modelRole: 'escalate'` so the escalation resolves as an escalation.
        // Without it the override runs through the reviewer's own role, and on
        // an adapter that routes per role — cursor — it produced the reviewer's
        // model verbatim while the line below announced a spot check on a
        // different one. (AGT-4273)
        const reviewerOverrides = shouldEscalateReviewer
          ? { model: reviewerEscalateModel, modelRole: 'escalate' as const }
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
      // The session stopped because the worker claimed success, changed
      // nothing and gave no reason — three times, across a model escalation
      // and a fresh context. A new attempt runs the same prompt into the same
      // silence: cgf-portal AX-868 reached attempt 27 and AGT-3844 attempt 53
      // that way on 2026-09-02, each attempt ~900k tokens, and the operator
      // was never told the agent had produced nothing at all.
      operatorPark: context.stuckReason && context.workerResult?.zeroDiffWithoutReason
        ? {
          code: WORKER_NO_CHANGES_PARK_REASON,
          reason: `Worker claimed success without changing a file and without a noChangesReason (${context.stuckReason.toLowerCase()}). The issue needs a human: either it asks for something the agent cannot express as a diff, or its description does not say what to change.`,
        }
        : undefined,
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
  instructionCapsule?: PipelineConfig['instructionCapsule'],
  roleMcpTools?: PipelineConfig['roleMcpTools'],
  adapterRouting?: PipelineConfig['adapterRouting'],
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
  });
}

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
