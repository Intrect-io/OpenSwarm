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
import { isEphemeralWorktreeArtifact } from '../support/worktreeEphemeral.js';
import { enforcedFileScope, filesOutsideWriteScope } from '../orchestration/writeScope.js';
import { withoutBookkeeping } from './siblingWorkFormat.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
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
async function reviewerDiff(projectPath: string, excludePaths: string[]): Promise<string | undefined> {
  try {
    const diff = await getDiffText(projectPath, undefined, REVIEWER_DIFF_MAX_BYTES, {
      includeUntracked: true,
      // Untracked pulls in whatever `add -A` would stage, and that is more than
      // the worker wrote: a worktree mount leaves a machine-local `node_modules`
      // symlink behind, and a live reviewer spent turns judging it. Refuse here
      // exactly what the commit path refuses. (AGT-4447)
      excludePaths,
    });
    return diff.trim() ? diff : undefined;
  } catch {
    // A review with no diff is weaker; a review that never runs is worse.
    return undefined;
  }
}

/**
 * What the publisher would actually commit, out of what the worker touched
 * (AGT-4806). A reviewer shown a file the commit drops raises findings about
 * work that will never ship — one such phantom finding cost a worker iteration
 * $3.35. Each rule below is the publisher's own predicate, not a copy:
 *
 *   - untracked material the staging step refuses (`refusedUntrackedPaths`);
 *   - ephemeral artifacts the commit path purges (`isEphemeralWorktreeArtifact`);
 *   - files outside the reserved write scope, which the publication fence
 *     (`assertBranchWithinWriteScope`) refuses to push, judged on the same
 *     `enforcedFileScope` / `withoutBookkeeping` / `filesOutsideWriteScope` it uses.
 *
 * Protected files need no rule here: the worker's tools refuse to write them,
 * and a protected file that did change is committed, so it is reviewed.
 */
export async function publishableReviewView(
  projectPath: string,
  task: Pick<TaskItem, 'fileScope' | 'fileScopeSource'>,
  filesChanged: readonly string[],
): Promise<{ files: string[]; excludeFromDiff: string[]; outsideScope: number }> {
  const refused = await refusedUntrackedPaths(projectPath).catch(() => [] as string[]);
  const refusedSet = new Set(refused);
  const committable = filesChanged.filter((file) => !refusedSet.has(file) && !isEphemeralWorktreeArtifact(file));
  const scope = enforcedFileScope(task);
  const outside = scope ? filesOutsideWriteScope(withoutBookkeeping(committable), scope) : [];
  const outsideSet = new Set(outside);
  return {
    files: committable.filter((file) => !outsideSet.has(file)),
    excludeFromDiff: [...refused, ...filesChanged.filter((file) => isEphemeralWorktreeArtifact(file)), ...outside],
    outsideScope: outside.length,
  };
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
  const view = await publishableReviewView(context.projectPath, context.task, context.workerResult.filesChanged);
  const scopeWarning = view.outsideScope > 0
    ? [`${view.outsideScope} changed file(s) outside the reserved write scope are not shown: the publication fence refuses to push the branch while they remain`]
    : [];
  return {
    // A judgement, not an execution. The pipeline reviewer used to inherit the
    // default-off `readOnly` of the local `openswarm review` path, which left it
    // holding write_file/edit_file/apply_patch/bash on the worktree it was
    // judging — so it could repair the diff and then approve it, and its verdict
    // would mean nothing. The worker demonstrably edits the checks that judge it
    // (AX-1556, 2026-09-18); a reviewer that can do the same is that failure one
    // layer up with nothing below it to catch it. (AGT-4443)
    readOnly: true,
    diff: await reviewerDiff(context.projectPath, view.excludeFromDiff),
    taskTitle: context.task.title,
    taskDescription: context.task.description || '',
    authoritativeOperatorFeedback: context.task.authoritativeOperatorFeedback,
    // Only what the commit would carry (AGT-4806), so no finding is about a file that never ships.
    workerResult: { ...context.workerResult, filesChanged: view.files },
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
    // Declarative role scope travels with the role, like maxTurns above. The
    // loop applies it last, so an allow-list cannot hand the read-only reviewer
    // (readOnly: true above) a tool this run withheld. (RoleConfig.tools)
    toolAllow: config.roles?.reviewer?.tools?.allow,
    toolDeny: config.roles?.reviewer?.tools?.deny,
    // Task/jobProfile effort wins; the role's own declared effort is the floor. (RoleConfig.effort)
    reasoningEffort: effortForTask(config, context.task) ?? config.roles?.reviewer?.effort,
    completionCriteria: config.draftAnalysis?.completionCriteria,
    verificationEvidence: context.testerResult?.verificationEvidence,
    priorReviewContext: context.recovery?.feedback || undefined,
    // Surface non-blocking guard warnings (dead-module, reformat/scope) so the
    // reviewer verifies them instead of them dying in a log. (INT-2388)
    guardWarnings: [
      ...(context.guardsResult?.results
        .filter((r) => !r.passed && !r.blocking)
        .flatMap((r) => r.issues) ?? []),
      ...scopeWarning,
    ],
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
    projectGoal: config.projectGoal,
    mcpTools: config.roleMcpTools?.reviewer,
    coordinationContext: coordinationContextFor(context, 'reviewer'),
  };
}
