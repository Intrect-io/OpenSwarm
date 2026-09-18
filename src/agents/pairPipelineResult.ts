/**
 * Assemble the run's result from what the stages left on the context.
 *
 * Split out of pairPipeline.ts, which sits at the 1500-line ceiling the
 * pre-commit hook enforces, and because composing a result is a different job
 * from running the loop that produced it. The caller still owns the emit: an
 * event is a side effect, and this stays a function of its inputs.
 */
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { type CostInfo, aggregateCosts, formatCost } from '../support/costTracker.js';
import { broadcastEvent } from '../core/eventHub.js';
import { safeConsole } from '../support/safeLog.js';
import { guardWarningsForResult } from './guardWarningRecord.js';
import { ITERATION_BUDGET_PARK_REASON } from '../orchestration/taskBudget.js';
import {
  WORKER_NO_CHANGES_PARK_REASON,
  type PipelineContext,
  type PipelineResult,
  type StageResult,
} from './pairPipelineTypes.js';

export function composePipelineResult(
  context: PipelineContext,
  stages: StageResult[],
  startTime: number,
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
      // Budget spent, not work rejected: park so the branch is published as a
      // draft instead of stranded (AGT-4430).
      : context.budgetParkReason
        ? { code: ITERATION_BUDGET_PARK_REASON, reason: context.budgetParkReason }
        : undefined,
    totalDuration: Date.now() - startTime,
    iterations: context.currentIteration,
    // Final iteration's non-blocking warnings; see guardWarningRecord.ts.
    guardWarnings: guardWarningsForResult(context.guardsResult?.results),
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

  return result;
}
