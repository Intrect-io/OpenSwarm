// ============================================
// OpenSwarm - worker blocker claims as a reviewer question
// ============================================
//
// A worker is told to stop, with evidence, when a task cannot be done as
// written (e.g. its definition of done is self-contradictory) instead of
// paging the operator over a scope debate. The pipeline used to treat that
// stop like any failed attempt and retry it: measured on a real run
// (AGT-4534 eval base3), a precise, correct "range(1,3) is asserted to equal
// both [1,2,3] and [1,2]" was retried twice with raised effort.
//
// This turns the claim into one bounded exchange instead: the reviewer
// verifies the claim against the repository. Confirmed, the run stops for the
// operator with the verified evidence. Refuted, the reviewer's reasons go back
// to the worker as review feedback. Once per run, so it cannot loop.

import type { WorkerResult, ReviewResult } from './agentPair.js';
import * as agentPair from './agentPair.js';
import * as reviewerAgent from './reviewer.js';
import { buildReviewerStageOptions } from './reviewerStageOptions.js';
import type { PipelineConfig, PipelineContext } from './pairPipelineTypes.js';
import { safeConsole } from '../support/safeLog.js';

export { VERIFIED_WORKER_BLOCKER_PARK_REASON } from './pairPipelineTypes.js';

/**
 * The worker's claim that the task cannot be completed as written, or
 * undefined. Only a stop that changed nothing and states a reason qualifies;
 * an adapter/infrastructure error is not a claim about the task.
 */
export function workerBlockerClaim(result: WorkerResult): string | undefined {
  if (result.success || result.error) return undefined;
  if (result.blockedOnOperator || result.executionOutcomeUnknown) return undefined;
  if ((result.filesChanged ?? []).length > 0) return undefined;
  const reason = (result.haltReason ?? result.noChangesReason ?? '').trim();
  if (!reason) return undefined;
  // A provider/budget stop is about the run, not the task.
  if (RUN_LIMIT_REASON.test(reason)) return undefined;
  return reason;
}

/** Stop reasons that describe the run's limits rather than the task. */
const RUN_LIMIT_REASON = /rate.?limit|quota|\b429\b|timed?.?out|timeout|turn.?limit|max(?:imum)?.?turns|context.?(?:length|window)|budget/i;

export interface BlockerReviewOutcome {
  confirmed: boolean;
  /** Worker claim plus reviewer evidence (confirmed) — the park reason. */
  reason: string;
  verdict: ReviewResult;
}

/**
 * Put a failed worker's blocker claim to the reviewer, once per run. Returns
 * undefined when there is no claim to verify (or it was already verified this
 * run, or the pipeline has no reviewer), and the caller retries as before.
 * On a confirmed claim the context carries the park reason; on a refuted one
 * the reviewer's verdict becomes the next worker's review feedback.
 */
export async function reviewWorkerBlocker(
  config: PipelineConfig,
  context: PipelineContext,
  failedWorker: WorkerResult,
  abortSignal?: AbortSignal,
): Promise<BlockerReviewOutcome | undefined> {
  const claim = workerBlockerClaim(failedWorker);
  if (!claim || context.blockerReviewed || !config.stages.includes('reviewer')) return undefined;
  // Only a first, clean attempt can claim "no changes": later iterations and
  // resumed runs have earlier edits in the tree, which the reviewer would see.
  if (context.currentIteration !== 1 || (config.resumedTaskFiles?.length ?? 0) > 0) return undefined;
  context.blockerReviewed = true;
  context.workerResult = failedWorker;
  const prefix = context.taskPrefix;
  let verdict: ReviewResult;
  try {
    // The reviewer's own model and read-only mode, in blocker-verification mode.
    const options = await buildReviewerStageOptions({ config, context, prefix, overrides: undefined, abortSignal });
    options.mode = 'blocker';
    options.blockerClaim = claim;
    safeConsole.log(`[${prefix}] Worker stopped without edits: ${claim.slice(0, 300)} — asking the reviewer to verify`);
    verdict = await reviewerAgent.runReviewer(options);
  } catch (error) { // cxt-ignore: error_swallow — a failed verification falls back to the old retry
    safeConsole.warn(`[${prefix}] Blocker verification failed (${error instanceof Error ? error.message : String(error)}) — retrying the worker instead`);
    return undefined;
  }
  agentPair.saveReviewerResult(context.session.id, verdict);
  context.blockerReview = verdict;
  if (verdict.decision === 'approve') {
    const reason = `Worker stopped without edits and the reviewer confirmed why. Worker: ${claim} — Reviewer: ${verdict.feedback}`;
    safeConsole.log(`[${prefix}] Worker blocker confirmed by reviewer — stopping for the operator`);
    context.verifiedBlocker = reason;
    context.workerResult = { ...failedWorker, haltReason: reason };
    return { confirmed: true, reason, verdict };
  }
  safeConsole.log(`[${prefix}] Worker blocker refuted by reviewer — sending the reasons back`);
  context.reviewResult = verdict;
  context.feedbackSource = 'review';
  context.lastReviseFeedback = verdict.feedback;
  return { confirmed: false, reason: verdict.feedback, verdict };
}
