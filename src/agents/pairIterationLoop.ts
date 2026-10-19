import type { PipelineConfig, PipelineContext, StageResult } from './pairPipelineTypes.js';
import type { PipelineStage } from '../core/types.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';
import * as agentPair from './agentPair.js';
import { CONFIDENCE_THRESHOLDS } from './agentPair.js';
import { taskAttributionKey, taskEventKey } from '../orchestration/decisionEngine.js';
import { canStartAnotherIteration } from '../orchestration/taskBudget.js';
import { captureBeforeIteration, rollbackStagnantIteration } from './iterationSnapshot.js';
import { discardStagedMemoriesFrom } from './stagedMemory.js';
import { runGuards } from './pipelineGuards.js';
import { adjudicateContractEvidenceStagnation } from './guardArbiter.js';
import { recordReflection, similarReviewFeedback } from './reflection.js';
import type { ReflectionSource } from './reflection.js';
import { buildRepeatEscalation, resolveWorkerStageOverrides } from './workerEscalation.js';
import { emitWorkerFanoutGateDecision, evaluateWorkerFanoutGate } from './workerFanoutGate.js';
import { modelForTask, effortForTask } from './pipelineRoleSelection.js';
import { stageTimeoutMs } from './stageTimeouts.js';
import { collectIntroducedSecurityFindings, formatSecurityFinding } from './securityAuditGate.js';
import { reviewWorkerBlocker } from './workerBlockerReview.js';
import { formatGuardWarningLine } from './guardWarningRecord.js';
import { testerReflectionErrors, testerRevisionFeedback } from './testerFailureFeedback.js';
import { isTesterCodeFile, isValidationRelevantFile, missingWorkerValidationIssues, testerWouldRunForWorkerResult } from './workerValidationEvidence.js';
import { broadcastEvent } from '../core/eventHub.js';
import { safeConsole } from '../support/safeLog.js';
import type { StuckDetector } from '../support/stuckDetector.js';
import type { ModelRole } from '../adapters/modelCompat.js';

export interface PipelineLoopHost {
  config: PipelineConfig;
  throwIfAborted(): void;
  getStuck(): StuckDetector;
  hasStage(stage: PipelineStage): boolean;
  runStage(stage: PipelineStage, context: PipelineContext, overrides?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high'; modelRole?: ModelRole }): Promise<StageResult>;
  shouldAbortSelfRepair(context: PipelineContext, progressed: boolean, source: ReflectionSource): boolean;
  emit(event: string, payload: unknown): unknown;
}

function dropStaleTestVerdict(context: PipelineContext): void { context.testerResult = undefined; }

/** 단계 정책을 분리해 실행·복구 코드가 같은 반복 루프를 공유한다. */
export async function runFullIterationLoop(host: PipelineLoopHost, context: PipelineContext, stages: StageResult[]): Promise<{ success: boolean }> {
    const maxIterations = host.config.maxIterations ?? 3;
    const loopStartedAt = Date.now();
    const hasWorker = host.hasStage('worker');
    const hasReviewer = host.hasStage('reviewer');
    const hasTester = host.hasStage('tester');

    // No point without a worker
    if (!hasWorker) {
      safeConsole.log(`[${context.taskPrefix}] No worker stage configured`);
      return { success: false };
    }

    // The watchdog used to fire mid-iteration and the run ended "cancelled, PR
    // not created" with finished work stranded on a branch (AGT-4430). Stop on
    // our own terms instead: an iteration is only started when the longest one
    // observed so far still fits in what is left of the same budget.
    const taskBudgetMs = host.config.taskBudgetMs ?? 0;
    const workerTimeoutMs = stageTimeoutMs('worker', host.config.roles?.worker?.timeoutMs);
    let longestIterationMs = 0;

    while (context.currentIteration < maxIterations) {
      host.throwIfAborted(); // bail before starting another iteration
      const budget = canStartAnotherIteration({
        elapsedMs: Date.now() - loopStartedAt,
        budgetMs: taskBudgetMs,
        iterationsUsed: context.currentIteration,
        maxIterations,
        longestIterationMs,
        workerTimeoutMs,
      });
      if (!budget.start && budget.reason) {
        context.budgetParkReason = budget.reason;
        safeConsole.warn(`[${context.taskPrefix}] Stopping before iteration ${context.currentIteration + 1}: ${budget.reason}`);
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }
      const iterationStartedAt = Date.now();
      context.currentIteration++;
      dropStaleTestVerdict(context);
      await captureBeforeIteration(context);

      // Stuck detection check (before iteration starts)
      const stuckCheck = host.getStuck().check();
      if (stuckCheck.isStuck) {
        context.stuckReason = stuckCheck.reason;
        safeConsole.error(`[${context.taskPrefix}] STUCK DETECTED: ${stuckCheck.reason}`);
        safeConsole.error(`[${context.taskPrefix}] Suggestion: ${stuckCheck.suggestion}`);
        host.emit('stuck', {
          reason: stuckCheck.reason,
          suggestion: stuckCheck.suggestion,
          context,
        });
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }

      host.emit('iteration:start', {
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
        workerCfg: host.config.roles?.worker,
        iteration: context.currentIteration,
        baseModel: modelForTask(host.config, 'worker', context.task),
        // The role's declared effort is part of the floor, not just the profile's:
        // the retry rung takes a MAX, so omitting it lowered a role asking for
        // `high` down to `medium` on the first retry.
        baseEffort: effortForTask(host.config, context.task) ?? host.config.roles?.worker?.effort,
        signalEscalation: context.workerEscalation,
        taskId: taskEventKey(context.task),
        taskPrefix: context.taskPrefix,
      });

      const fanoutDecision = evaluateWorkerFanoutGate({
        task: context.task,
        draftAnalysis: host.config.draftAnalysis,
        iteration: context.currentIteration,
        feedbackSource: context.feedbackSource,
        effort: effortForTask(host.config, context.task) ?? host.config.roles?.worker?.effort,
        config: host.config.roles?.worker?.fanout,
      });
      context.workerFanoutDecision = fanoutDecision;
      emitWorkerFanoutGateDecision({
        context,
        decision: fanoutDecision,
        verbose: host.config.verbose,
        emit: (event, payload) => host.emit(event, payload),
      });

      agentPair.updateSessionStatus(context.session.id, 'working');
      const workerResult = await host.runStage('worker', context, workerOverrides);
      stages.push(workerResult);

      // Record Worker result in stuck detector
      host.getStuck().addEntry({
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
          host.emit('halt', {
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
        // A second identical scope rejection is structural, not a worker-quality
        // failure.  Retrying would only consume the next iteration with the same
        // fence (and otherwise triggers fresh-context / reasoning escalation).
        // Park it explicitly so the operator sees the incompatible demand and
        // scope rather than receiving a PR that silently dropped the request.
        if (detail?.startsWith('worker-scope:') && context.repeatedScopeRejection === detail) {
          const reason = `Repeated write-scope rejection; stopped instead of retrying: ${detail}`;
          safeConsole.log(`[${context.taskPrefix}] ${reason}`);
          context.workerResult = { ...failedWorker, haltReason: reason };
          agentPair.updateSessionStatus(context.session.id, 'waiting_on_operator');
          host.emit('halt', { confidence: failedWorker.confidencePercent ?? 0, haltReason: reason, sessionId: context.session.id, iteration: context.currentIteration, context });
          return { success: false };
        }
        if (detail?.startsWith('worker-scope:')) context.repeatedScopeRejection = detail;
        // A no-edit stop with a stated reason is a claim about the task: put it
        // to the reviewer once instead of retrying blind (AGT-4535).
        const blocker = await reviewWorkerBlocker(host.config, context, failedWorker, context.abortSignal);
        if (blocker?.confirmed) {
          agentPair.updateSessionStatus(context.session.id, 'waiting_on_operator');
          host.emit('halt', { confidence: failedWorker.confidencePercent ?? 0, haltReason: blocker.reason, sessionId: context.session.id, iteration: context.currentIteration, context });
          return { success: false };
        }
        if (blocker) {
          agentPair.trackFailure(context.session.id);
          host.emit('iteration:fail', { iteration: context.currentIteration, stage: 'worker', context });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
        safeConsole.log(`[${context.taskPrefix}] Worker failed, retrying...${detail ? ` (${detail.slice(0, 500)})` : ''}`);
        agentPair.trackFailure(context.session.id);
        host.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'worker',
          context,
        });
        continue; // Next iteration
      }

      // ========== PIPELINE GUARDS (post-worker, pre-reviewer) ==========
      if (host.config.guards && context.workerResult) {
        safeConsole.log(`[${context.taskPrefix}] Running pipeline guards...`);
        const guardsResult = await runGuards(
          context.workerResult,
          context.projectPath,
          host.config.guards,
        );
        context.guardsResult = guardsResult;

        if (!guardsResult.allPassed) {
          // Blocking guard failed → bad edit. Skip the (expensive) reviewer and
          // drive a bounded self-repair retry with the exact errors preserved.
          const blocking = guardsResult.results.filter(r => !r.passed && r.blocking);
          const blockingIssues = blocking.flatMap(r => r.issues);
          await context.recovery?.failure('guards', blockingIssues);
          safeConsole.log(`[${context.taskPrefix}] Blocking guard failed: ${blockingIssues.join('; ')}`);

          // qualityGate is the lint/type bad-edit check; bsDetector is code-smell.
          const source: ReflectionSource = blocking.some(r => r.guard === 'qualityGate') ? 'lint' : 'bs';
          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source,
            errors: blockingIssues,
          });

          // Confirmed stagnation (identical block twice) on contractEvidence
          // ALONE — not mixed with another guard — gets one arbiter
          // adjudication before the mechanical retry/abort below (AGT-4462):
          // the guard's own evidence check cannot accept a literal this same
          // diff newly defines, so retrying never helps that specific case.
          const arbiterOutcome = !progressed && blocking.length === 1 && blocking[0].guard === 'contractEvidence'
            ? await adjudicateContractEvidenceStagnation({
                issues: blockingIssues,
                projectPath: context.projectPath,
                adapter: host.config.roles?.reviewer?.adapter,
                model: host.config.roles?.reviewer?.model,
              })
            : undefined;
          if (arbiterOutcome) safeConsole.log(`[${context.taskPrefix}] ${arbiterOutcome.summary}`);

          if (!arbiterOutcome?.overridden) {
            context.reviewResult = {
              decision: 'revise',
              feedback: `Pipeline guard failed: ${blockingIssues.join('; ')}`
                + (arbiterOutcome ? `\n\n${arbiterOutcome.summary}` : ''),
              issues: blockingIssues,
              suggestions: ['Fix the issues flagged by quality guards'],
            };
            context.feedbackSource = 'objective';
            agentPair.trackFailure(context.session.id);
            host.emit('iteration:fail', {
              iteration: context.currentIteration,
              stage: 'worker',
              context,
            });
            agentPair.updateSessionStatus(context.session.id, 'revising');

            // Stagnation built on an edit that was not working: restore instead
            // of abandoning the run on top of it (AGT-4460).
            const rolledBack = await rollbackStagnantIteration(context, progressed);
            if (rolledBack) await discardStagedMemoriesFrom(taskAttributionKey(context.task), rolledBack.iteration);
            if (!rolledBack && host.shouldAbortSelfRepair(context, progressed, source)) {
              return { success: false };
            }
            longestIterationMs = Math.max(longestIterationMs, Date.now() - iterationStartedAt);
            continue;
          }
          host.emit('log', { line: '🔓 Guard arbiter override: contractEvidence literal(s) confirmed self-defining by this diff — proceeding.' });
          longestIterationMs = Math.max(longestIterationMs, Date.now() - iterationStartedAt);
          // No `continue` here: fall through past this guard block and treat
          // the iteration as if guards had passed.
        }

        // Carries the issues, not just the guard's name: stdout is the last
        // reader left. Why, in guardWarningRecord.ts (AGT-4439).
        const warningLine = formatGuardWarningLine(guardsResult.results);
        if (warningLine) {
          safeConsole.log(`[${context.taskPrefix}] ${warningLine}`);
          host.emit('log', { line: `⚠️ ${warningLine}` });
        }
      }

      // CodeQL is a post-edit gate, not a tester-stage feature. It is opt-in
      // (securityAudit.enabled, default OFF) because it is too slow to gate PRs
      // (AGT-4160). When disabled we do not even invoke the gate, so the default
      // autonomous path never runs CodeQL.
      const introducedSecurityFindings = host.config.securityAudit?.enabled
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
        host.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'tester',
          context,
        });
        agentPair.updateSessionStatus(context.session.id, 'revising');

        if (host.shouldAbortSelfRepair(context, progressed, 'test')) {
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
        host.config.skipTesterIfNoCodeChange ?? true, host.config.verify?.enabled === true,
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
            host.emit('iteration:fail', {
              iteration: context.currentIteration,
              stage: 'worker',
              context,
            });
            agentPair.updateSessionStatus(context.session.id, 'revising');
            continue;
          }
          safeConsole.log(`[${context.taskPrefix}] Validation evidence still missing — deferring to reviewer (already nudged once)`);
          host.emit('log', { line: '⚠️ Validation evidence missing; deferring to reviewer' });
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
          host.emit('halt', { confidence, haltReason, sessionId: context.session.id, iteration: context.currentIteration, context });
          // Degenerate no-op → escalate the next attempt (stronger effort/model) vs the same empty run to STUCK. (INT-2521)
          if (degenerate && !context.workerEscalation) {
            context.workerEscalation = buildRepeatEscalation({
              workerCfg: host.config.roles?.worker,
              currentIteration: context.currentIteration,
              currentModel: modelForTask(host.config, 'worker', context.task),
              currentEffort: effortForTask(host.config, context.task) ?? host.config.roles?.worker?.effort,
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
          host.emit('iteration:fail', { iteration: context.currentIteration, stage: 'worker', context });
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
        const skipIfNoCode = host.config.skipTesterIfNoCodeChange ?? true;
        const changedFiles = context.workerResult?.filesChanged || [];
        const hasCodeChange = changedFiles.some(file => (host.config.verify?.enabled || host.config.securityAudit?.enabled)
          ? isValidationRelevantFile(file)
          : isTesterCodeFile(file));
        if (skipIfNoCode && !hasCodeChange) {
          safeConsole.log(`[${context.taskPrefix}] Skipping tester: no code files changed (${changedFiles.length} files: ${changedFiles.join(', ') || 'none'})`);
        } else {
        const testerResult = await host.runStage('tester', context);
        stages.push(testerResult);

        const hasNewSecurityFindings = (context.newSecurityFindings?.length ?? 0) > 0;
        // Only a configured reviewer can judge a deterministic verdict; without
        // one the deferral had no recipient and the run ended instead of
        // self-repairing. See `testerFailureFeedback.ts` (AGT-4438).
        const reviewerShouldJudgeFailure = hasReviewer
          && context.testerResult?.deterministic === true
          && !hasNewSecurityFindings;
        if (!testerResult.success && !host.config.continueOnTestFail && !reviewerShouldJudgeFailure) {
          // Test failure is objective ground truth → record into the reflection
          // trail and drive a bounded self-repair retry (INT-1679).
          safeConsole.log(`[${context.taskPrefix}] Tester failed, retrying...`);
          agentPair.trackFailure(context.session.id);

          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source: 'test',
            errors: testerReflectionErrors(context.testerResult),
          });

          if (context.testerResult) {
            context.reviewResult = testerRevisionFeedback(context.testerResult);
          }
          context.feedbackSource = 'objective';

          host.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'tester',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');

          if (host.shouldAbortSelfRepair(context, progressed, 'test')) {
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
        const reviewerCfg = host.config.roles?.reviewer;
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
          host.emit('log', {
            line: `🔍 Reviewer spot check: escalating to ${reviewerEscalateModel}`,
          });
        }

        const reviewerResult = await host.runStage('reviewer', context, reviewerOverrides);
        stages.push(reviewerResult);

        const decision = (reviewerResult.result as ReviewResult).decision;

        // Record Reviewer result in stuck detector
        host.getStuck().addEntry({
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
                  workerCfg: host.config.roles?.worker,
                  currentIteration: context.currentIteration,
                  currentModel: modelForTask(host.config, 'worker', context.task),
                  currentEffort: effortForTask(host.config, context.task) ?? host.config.roles?.worker?.effort,
                })
              : undefined;
            if (escalation) {
              context.workerEscalation = escalation;
              const target = [
                escalation.model ? `model→${escalation.model}` : '',
                escalation.reasoningEffort ? `effort→${escalation.reasoningEffort}` : '',
              ].filter(Boolean).join(', ');
              safeConsole.log(`[${context.taskPrefix}] Reviewer repeated the same feedback — escalating worker (${target})`);
              host.emit('log', { line: `⬆️ Worker escalation on repeated review feedback (${target})` });
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
              host.emit('log', { line: `🛑 ${reason}` });
              host.emit('iteration:fail', {
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
          // through the reviewer channel and is kept for the next worker iteration.
          safeConsole.log(`[${context.taskPrefix}] Reviewer requested revision`);
          context.feedbackSource = 'review';
          agentPair.trackFailure(context.session.id);
          host.emit('iteration:fail', {
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
        && (host.config.verify?.blockOnNewFailures === true || (context.newSecurityFindings?.length ?? 0) > 0)) {
        safeConsole.log(`[${context.taskPrefix}] Deterministic verification has a blocking new failure`);
        host.emit('iteration:fail', { iteration: context.currentIteration, stage: 'tester', context });
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }
      longestIterationMs = Math.max(longestIterationMs, Date.now() - iterationStartedAt);
      safeConsole.log(`[${context.taskPrefix}] Iteration ${context.currentIteration} completed successfully`);
      host.emit('iteration:complete', {
        iteration: context.currentIteration,
        context,
      });
      return { success: true };
    }

    safeConsole.log(`[${context.taskPrefix}] Max iterations (${maxIterations}) exceeded`);
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return { success: false };
}
