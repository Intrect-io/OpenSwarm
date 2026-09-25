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

/** NEEDS_HUMAN code for a no-edit stop whose reason the reviewer confirmed. */
export const VERIFIED_WORKER_BLOCKER_PARK_REASON = 'verified_worker_blocker';

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
  return reason;
}

/** Task text for the reviewer when it is asked to verify a blocker claim. */
export function blockerVerificationDescription(taskDescription: string, claim: string, summary: string): string {
  return [
    taskDescription,
    '',
    '## Blocker verification (not a code review)',
    'The worker made NO changes and stopped, claiming this task cannot be completed as written:',
    '',
    `> ${claim.replace(/\n/g, '\n> ')}`,
    '',
    summary ? `Worker summary: ${summary}` : '',
    '',
    'Verify this claim yourself against the repository; do not take it on trust.',
    '- APPROVE only if you confirm it with concrete evidence (file:line). The run then stops and the operator decides how to change the task.',
    '- REVISE if the claim is wrong or incomplete, and say exactly how the task can be completed as written.',
    'Put the evidence in your feedback either way.',
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n');
}

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
  context.blockerReviewed = true;
  context.workerResult = failedWorker;
  const prefix = context.taskPrefix;
  // The reviewer's own model and read-only mode; only its task text changes.
  const options = await buildReviewerStageOptions({ config, context, prefix, overrides: undefined, abortSignal });
  options.taskDescription = blockerVerificationDescription(options.taskDescription, claim, failedWorker.summary ?? '');
  safeConsole.log(`[${prefix}] Worker stopped without edits: ${claim.slice(0, 300)} — asking the reviewer to verify`);
  const verdict = await reviewerAgent.runReviewer(options);
  agentPair.saveReviewerResult(context.session.id, verdict);
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
  return { confirmed: false, reason: verdict.feedback, verdict };
}
