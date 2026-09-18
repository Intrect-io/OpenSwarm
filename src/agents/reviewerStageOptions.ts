/**
 * What the in-loop reviewer stage is handed.
 *
 * Lifted out of `pairPipeline.ts` unchanged, because that file sits one line
 * under the repository's 1500-line ceiling and the reviewer's inputs are where
 * the next few changes land. Keeping the builder here also keeps its
 * explanatory comments next to the fields they explain.
 */

import { broadcastEvent } from '../core/eventHub.js';
import { getDiffText } from '../support/gitTracker.js';
import { refusedUntrackedPaths } from '../support/worktreeEphemeralOps.js';
import { taskAttributionKey, taskEventKey } from '../orchestration/decisionEngine.js';
import { coordinationContextFor } from './pipelineCoordination.js';
import { compatibleStageModel, effortForTask, modelForTask } from './pipelineRoleSelection.js';
import { stageTimeoutMs } from './stageTimeouts.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import type { PipelineConfig, PipelineContext } from './pairPipelineTypes.js';
import type { ReviewerOptions } from './reviewer.js';

/** The pipeline's own stage overrides; only model/modelRole reach the reviewer. */
export interface ReviewerStageOverrides {
  model?: string;
  modelRole?: ModelRole;
}

/**
 * Bounded inside `getDiffText`, which puts its truncation notice first so a cut
 * cannot hide the fact that the diff is incomplete.
 */
export const REVIEWER_DIFF_MAX_BYTES = 16_000;

/**
 * The change under review, as a diff against HEAD.
 *
 * Without it a read-only reviewer sees only the resulting files, and reading a
 * file shows the result, never the change — the same blindness INT-3101 fixed
 * for the committed-diff path. Untracked files are included because a worker's
 * new file is untracked until the preserve commit and `git diff` ignores it
 * entirely, which would list a changed file with no patch behind it.
 *
 * Limit worth stating: the base is HEAD, matching `openswarm review`'s
 * working-tree default, so WIP a previous attempt already committed to the
 * branch is not in this diff. `workerResult.filesChanged` still names those
 * files, and the reviewer can read them. (AGT-4443)
 */
async function reviewerDiff(projectPath: string): Promise<string | undefined> {
  try {
    const diff = await getDiffText(projectPath, undefined, REVIEWER_DIFF_MAX_BYTES, {
      includeUntracked: true,
      // Untracked pulls in whatever `add -A` would stage, and that is more than
      // the worker wrote: a worktree mount leaves a machine-local `node_modules`
      // symlink behind, and a live reviewer spent turns judging it. Refuse here
      // exactly what the commit path refuses. (AGT-4447)
      excludePaths: await refusedUntrackedPaths(projectPath),
    });
    return diff.trim() ? diff : undefined;
  } catch {
    // A review with no diff is weaker; a review that never runs is worse.
    return undefined;
  }
}

export async function buildReviewerStageOptions(input: {
  config: PipelineConfig;
  context: PipelineContext;
  prefix: string;
  overrides?: ReviewerStageOverrides;
  abortSignal?: AbortSignal;
}): Promise<ReviewerOptions> {
  const { config, context, prefix, overrides } = input;
  if (!context.workerResult) throw new Error('Worker result required for reviewer');
  return {
    // A judgement, not an execution. The pipeline reviewer used to inherit the
    // default-off `readOnly` of the local `openswarm review` path, which left it
    // holding write_file/edit_file/apply_patch/bash on the worktree it was
    // judging — so it could repair the diff and then approve it, and its verdict
    // would mean nothing. The worker demonstrably edits the checks that judge it
    // (AX-1556, 2026-09-18); a reviewer that can do the same is that failure one
    // layer up with nothing below it to catch it. (AGT-4443)
    readOnly: true,
    diff: await reviewerDiff(context.projectPath),
    taskTitle: context.task.title,
    taskDescription: context.task.description || '',
    authoritativeOperatorFeedback: context.task.authoritativeOperatorFeedback,
    workerResult: context.workerResult,
    projectPath: context.projectPath,
    timeoutMs: stageTimeoutMs('reviewer', config.roles?.reviewer?.timeoutMs),
    // jobProfile model precedence (see the worker stage). (INT-1599)
    // `overrides.modelRole` (not the stage) so an escalation resolves as an
    // escalation. This call — not the `stageModel` the pipeline logs, which is
    // the display value — is the one that reaches the agent. (AGT-4273)
    model: compatibleStageModel(config, 'reviewer', overrides?.model, overrides?.modelRole ?? 'reviewer')
      ?? modelForTask(config, 'reviewer', context.task),
    maxTurns: config.roles?.reviewer?.maxTurns,
    adapterName: config.roles?.reviewer?.adapter,
    reasoningEffort: effortForTask(config, context.task),
    completionCriteria: config.draftAnalysis?.completionCriteria,
    verificationEvidence: context.testerResult?.verificationEvidence,
    // Surface non-blocking guard warnings (dead-module, reformat/scope) so the
    // reviewer verifies them instead of them dying in a log. (INT-2388)
    guardWarnings: context.guardsResult?.results
      .filter((r) => !r.passed && !r.blocking)
      .flatMap((r) => r.issues),
    processContext: { taskId: taskAttributionKey(context.task), stage: 'reviewer' },
    // runReviewer has always accepted onLog; nothing passed one, so the
    // reviewer's turns never reached the dashboard/desktop console the way the
    // worker's do. (INT-3397)
    onLog: (line: string) =>
      broadcastEvent({
        type: 'log',
        data: { taskId: taskEventKey(context.task), stage: 'reviewer', line: `[${prefix}] ${line}` },
      }),
    signal: input.abortSignal,
    instructionCapsule: config.instructionCapsule,
    mcpTools: config.roleMcpTools?.reviewer,
    coordinationContext: coordinationContextFor(context, 'reviewer'),
  };
}
