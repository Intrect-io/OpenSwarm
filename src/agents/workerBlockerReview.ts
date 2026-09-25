// ============================================
// OpenSwarm - worker blocker claims as a reviewer question
// ============================================
//
// A worker is told to stop, with evidence, when a task cannot be done as
// written (e.g. its definition of done is self-contradictory) instead of
// paging the operator over a scope debate. The pipeline used to treat that
// stop like any failed attempt and retry it: measured on a real run
// (AGT-4534), a precise, correct report that two tests assert contradictory
// results for the same call was retried twice with raised effort.
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

export interface WorkerBlockerClaim {
  /** Why the worker says the task, or the part it left undone, cannot be done. */
  reason: string;
  /** Files the worker changed before stopping; empty for a no-edit stop. */
  changedFiles: string[];
}

/**
 * The worker's claim that the task cannot be completed as written, or
 * undefined. A stop that states a reason qualifies, with or without edits: a
 * worker that changed files and then stopped on part of the task is making
 * the same kind of claim about the rest of it, and the reviewer judges it the
 * same way (AGT-4534). An adapter/infrastructure error is not a claim about
 * the task.
 */
export function workerBlockerClaim(result: WorkerResult): WorkerBlockerClaim | undefined {
  if (result.success || result.error) return undefined;
  if (result.blockedOnOperator || result.executionOutcomeUnknown) return undefined;
  const reason = (result.haltReason ?? result.noChangesReason ?? '').trim();
  if (!reason) return undefined;
  // A provider/budget stop is about the run, not the task.
  if (RUN_LIMIT_REASON.test(reason)) return undefined;
  return { reason, changedFiles: [...(result.filesChanged ?? [])] };
}

const PARK_REASON_PART_MAX = 600;
const clip = (text: string) => (text.length > PARK_REASON_PART_MAX ? `${text.slice(0, PARK_REASON_PART_MAX)}…` : text);
const PARK_REASON_FILES_MAX = 5;
const formatFiles = (files: string[]) => files.length > PARK_REASON_FILES_MAX
  ? `${files.slice(0, PARK_REASON_FILES_MAX).join(', ')} and ${files.length - PARK_REASON_FILES_MAX} more`
  : files.join(', ');

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
  const edited = claim.changedFiles.length > 0;
  // Only a first, clean attempt can claim "no changes": later iterations and
  // resumed runs have earlier edits in the tree, which the reviewer would see.
  // A claim that names its edits has no such mismatch.
  if (!edited && (context.currentIteration !== 1 || (config.resumedTaskFiles?.length ?? 0) > 0)) return undefined;
  context.blockerReviewed = true;
  context.workerResult = failedWorker;
  const prefix = context.taskPrefix;
  let verdict: ReviewResult;
  try {
    // The reviewer's own model and read-only mode, in blocker-verification mode.
    const options = await buildReviewerStageOptions({ config, context, prefix, overrides: undefined, abortSignal });
    options.mode = 'blocker';
    options.blockerClaim = claim.reason;
    if (edited) options.blockerChangedFiles = claim.changedFiles;
    safeConsole.log(`[${prefix}] Worker stopped ${edited ? `after editing ${claim.changedFiles.length} file(s)` : 'without edits'}: ${claim.reason.slice(0, 300)} — asking the reviewer to verify`);
    verdict = await reviewerAgent.runReviewer(options);
  } catch (error) { // cxt-ignore: error_swallow — a failed verification falls back to the old retry
    safeConsole.warn(`[${prefix}] Blocker verification failed (${error instanceof Error ? error.message : String(error)}) — retrying the worker instead`);
    return undefined;
  }
  agentPair.saveReviewerResult(context.session.id, verdict);
  context.blockerReview = verdict;
  if (verdict.decision === 'approve') {
    // Bounded: the reason is posted to the tracker and the operator's channel.
    // Nobody approved the edits. They stay in the run's worktree for the
    // resume; the parked draft PR publishes committed work only, so it need
    // not contain them — say where they are, not that they were published.
    const stopped = edited
      ? `Worker changed ${formatFiles(claim.changedFiles)} (unreviewed, kept in the run's worktree for the resume) and stopped; the reviewer confirmed why the rest cannot be done.`
      : 'Worker stopped without edits and the reviewer confirmed why.';
    const reason = `${stopped} Worker: ${clip(claim.reason)} — Reviewer: ${clip(verdict.feedback)}`;
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
