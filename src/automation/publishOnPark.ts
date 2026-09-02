// ============================================
// OpenSwarm — publishing a finished run's branch (AGT-4076)
// ============================================
//
// Both publication paths a worktree-mode run can take, kept together because
// they share `commitAndCreatePR` and differ only in what the run earned:
//
// - `publishApprovedWork` — the reviewed path. A publication failure is fatal:
//   a run is not deliverable until its branch is reviewable.
// - `publishParkedWork` — a run that stopped for an operator decision. Draft,
//   committed work only, and a failure never changes the park.
//
// Split out of runnerExecution.ts, which sits on the 1500-line pre-commit cap.

import { broadcastEvent } from '../core/eventHub.js';
import { enforcedFileScope, type FileScopeSource } from '../orchestration/writeScope.js';
import { PublicationScopeMismatchError } from '../support/publicationScopeFence.js';
import { commitAndCreatePRWithHead, type WorktreeInfo } from '../support/worktreeManager.js';
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';

/** Runs once after a reviewed publication succeeded and was durably recorded. */
export type ApprovedPublicationHook = (publication: {
  prUrl: string;
  headSha: string;
  worktreeInfo: WorktreeInfo;
}) => Promise<void>;

/** worktreeManager's refusal to open a PR from a branch with nothing on it. */
const NO_COMMITS_TO_PUBLISH = /No commits to create PR from/;

/** NEEDS_HUMAN code for a branch the publication-scope fence refused. */
export const PUBLICATION_SCOPE_PARK_REASON = 'publication_scope_mismatch';

/** The fields these paths read; narrower than the full pipeline result. */
interface PublishableResult {
  success?: boolean;
  finalStatus?: string;
  prUrl?: string;
  workerResult?: { executionOutcomeUnknown?: boolean };
}

/** The fields these paths read off the task. */
interface PublishableTask {
  /** Required: the broadcast events key on `issueId || id`. */
  id: string;
  issueId?: string;
  title: string;
  description?: string;
  issueIdentifier?: string;
  fileScope?: string[];
  fileScopeSource?: FileScopeSource;
}

/**
 * Should a finished run publish the work it already committed?
 *
 * True only when it parked for the operator with a worktree and nothing
 * published yet. Pure so the decision is testable without the runner's
 * singletons and timers.
 */
export function shouldPublishParkedWork(
  hasWorktree: boolean,
  result: PublishableResult,
): boolean {
  return hasWorktree && result.finalStatus === 'waiting_on_operator'
    && result.workerResult?.executionOutcomeUnknown !== true
    && !result.prUrl;
}

/**
 * Publish the branch of a run that stopped for an operator decision.
 *
 * Otherwise the commits sit on a branch that was never pushed: measured on the
 * deployed daemon, 23 commits across six branches with no PR, while the
 * operator was being asked 70 questions about work they could not see. (The
 * operator's own framing: "supersded할거면 PR은 올리고 가라".)
 *
 * Called from the runner rather than from a later sweep. Three commit-gate
 * rounds rejected a sweep for the same reason: a parked run can be resumed and
 * claimed while an out-of-band publish is in flight, and if that publish opened
 * a PR first, the eventual reviewed publication would silently reuse it and
 * ship approved work as a draft. Here the executor still owns the claim, the
 * lease and the worktree, so there is nothing to race.
 */
export async function publishParkedWork(
  worktreeInfo: WorktreeInfo,
  task: PublishableTask,
  durability: ExecutionDurabilityHooks | undefined,
): Promise<void> {
  // The same lease fence the approved path uses. Without it an executor that
  // already lost its claim — expired lease, a newer generation now owning the
  // run — could still push the branch and open a PR for work it no longer
  // speaks for. A refused fence is not an error: the run parks either way.
  const publishAllowed = await durability?.beforePublish() ?? true;
  if (!publishAllowed) {
    console.warn(`[Runner] Parked publication fenced for ${task.issueIdentifier}; leaving the branch unpublished`);
    return;
  }
  try {
    const publication = await commitAndCreatePRWithHead(
      worktreeInfo,
      task.title,
      task.issueIdentifier || '',
      'Published because this run parked for an operator decision, so the work is'
        + ' visible instead of sitting on an unpushed branch. It has not been'
        + ' reviewed — this PR is a draft on purpose.',
      // Draft, and committed work only: nothing reviewed this, and the tree
      // must stay exactly as the worker left it so the resume continues.
      { draft: true, committedOnly: true,
        fileScope: enforcedFileScope(task) },
    );
    // The ledger records the PR; the pipeline result deliberately does NOT.
    //
    // `durableRunCoordinator.execute()` classifies any result carrying a prUrl
    // that is not an approved success as `publication_reconcile` and parks it
    // in NEEDS_RECONCILE. Setting it here would convert an operator park —
    // which frees the repository admission slot and resumes on the answer —
    // into a reconcile row that holds a slot until a sweep releases it. That is
    // the phantom-row shape that idled the whole loop on 2026-08-29.
    const { prUrl, headSha } = publication;
    const attached = await durability?.onPublication(prUrl, headSha) ?? true;
    if (attached) {
      console.log(`[Runner] Parked run published as draft for ${task.issueIdentifier}: ${prUrl}`);
    } else {
      console.warn(`[Runner] Parked publication for ${task.issueIdentifier} was not durably attached (lease fence); the PR exists at ${prUrl} and will be reused by branch name`);
    }
  } catch (err) {
    // "No commits to create PR from" is the common, correct outcome — the run
    // parked before committing anything. Nothing here may change the park: the
    // operator still has to answer either way.
    const detail = err instanceof Error ? err.message : String(err);
    if (!/No commits to create PR from/.test(detail)) {
      console.warn(`[Runner] Could not publish parked work for ${task.issueIdentifier}: ${detail}`);
    }
  }
}

/**
 * Publish the branch of a run that parked terminally for a human.
 *
 * Retry exhaustion, the rejection limit and sandbox infeasibility are not
 * failures to hide: reaching one is the run having built as far as it can and
 * arrived at the point where the operator has to look. Until now all three
 * committed the partial work to a local branch and deleted the worktree without
 * ever pushing — measured on the deployed daemon, 14 parked runs holding a
 * branch each and not one PR between them.
 *
 * Draft, like {@link publishParkedWork}: nothing reviewed this work, and a
 * ready PR would put known-incomplete work through CI.
 *
 * Runs as {@link removePreservedWorktreeAt}'s pre-cleanup hook so it inherits
 * that function's lifecycle lock and live-owner re-check, and so it sees the
 * WIP commit that hook fires after. Returns the PR URL when one was opened, so
 * the caller can put it in the tracker comment the operator actually reads.
 *
 * Takes no `beforePublish` hook because the caller already holds the same
 * proof in a stronger form. The reviewed path fences on a live claim; here the
 * caller has just run the durable park, and `markNeedsHuman` refuses any row
 * that still carries an owner or lease — so it only reaches this function when
 * the run is durably parked and unowned. A stale executor is turned away before
 * getting here. Note that the worktree lifecycle lock this runs under does NOT
 * supply that: it proves no worker is still editing the tree, which is a
 * different guarantee from owning the run.
 *
 * The PR is not attached to the ledger, which is a known gap rather than a
 * decision that costs nothing: nothing reading run state sees this artifact.
 * There is no ledger method for it — `attachPublication` needs a live claim and
 * `recoverPublishedRun` only accepts NEEDS_RECONCILE/WAITING_EXTERNAL — and
 * writing `pr_url` onto a parked row feeds the reconcile paths that classify a
 * PR-carrying non-approved run, which is the phantom-row shape that idled the
 * whole loop on 2026-08-29. Until that has an owner, the operator finds this PR
 * through the tracker comment, and a later reviewed publication reuses it by
 * branch name.
 */
export async function publishStuckWork(
  ctx: { worktreePath: string; repoRoot: string; branchName: string },
  task: PublishableTask,
  parkReason: string,
): Promise<string | undefined> {
  try {
    const { prUrl } = await commitAndCreatePRWithHead(
      {
        worktreePath: ctx.worktreePath,
        branchName: ctx.branchName,
        originalPath: ctx.repoRoot,
        issueId: task.issueId ?? task.id,
      },
      task.title,
      task.issueIdentifier || '',
      `Published because this run stopped and needs a human: ${parkReason}\n\n`
        + 'It has not been reviewed and is very likely incomplete — this PR is a'
        + ' draft on purpose. It exists so the work is reviewable instead of'
        + ' sitting on a branch that was never pushed.',
      // NOT committedOnly, unlike the operator-park path. That path leaves the
      // tree untouched because the run resumes from it; this tree is about to
      // be deleted, so anything still uncommitted is about to be lost. The
      // pre-cleanup WIP commit normally captures it first and makes this a
      // no-op (a clean tree skips the whole commit phase) — but that commit
      // swallows its own failures, and this is the second chance.
      { draft: true,
        fileScope: enforcedFileScope(task) },
    );
    broadcastEvent({
      type: 'log',
      data: { taskId: task.issueId || task.id, stage: 'pr', line: `Draft PR created for stuck run: ${prUrl}` },
    });
    console.log(`[Runner] Stuck run published as draft for ${task.issueIdentifier}: ${prUrl}`);
    return prUrl;
  } catch (err) {
    // "No commits to create PR from" is the common, correct outcome — the run
    // went stuck without producing anything. Nothing here may change the park.
    const detail = err instanceof Error ? err.message : String(err);
    if (!/No commits to create PR from/.test(detail)) {
      console.warn(`[Runner] Could not publish stuck work for ${task.issueIdentifier}: ${detail}`);
    }
    return undefined;
  }
}

/**
 * Publish the branch of a run that passed review.
 *
 * A publication failure is fatal here, unlike the parked path: a worktree-mode
 * run is not deliverable until its branch is remotely reviewable, so the result
 * is turned back into a retryable `infra_error` with the worktree preserved —
 * except a publication-scope rejection, which no retry can change and which
 * therefore parks for the operator (`operatorPark`).
 */
export async function publishApprovedWork(
  worktreeInfo: WorktreeInfo | null | undefined,
  task: PublishableTask,
  result: PublishableResult & Pick<PipelineResult, 'failureDetail' | 'operatorPark'> & { success?: boolean; finalStatus?: string; prUrl?: string },
  durability: ExecutionDurabilityHooks | undefined,
  afterPublication?: ApprovedPublicationHook,
): Promise<void> {
  // Create PR (worktree mode + pipeline success = finalStatus 'approved')
  if (worktreeInfo && result.success && result.finalStatus === 'approved') {
    const publishAllowed = await durability?.beforePublish() ?? true;
    if (!publishAllowed) {
      result.success = false;
      result.finalStatus = 'infra_error';
      console.warn(`[Worktree] Publication fenced for ${task.issueIdentifier}; preserving worktree`);
    } else {
      try {
        const publication = await commitAndCreatePRWithHead(
          worktreeInfo,
          task.title,
          task.issueIdentifier || '',
          task.description || '',
          { fileScope: enforcedFileScope(task) },
        );
        const { prUrl, headSha } = publication;
        result.prUrl = prUrl;
        const publicationRecorded = await durability?.onPublication(prUrl, headSha) ?? true;
        if (!publicationRecorded) {
          throw new Error('Durable lease fence rejected publication attachment');
        }
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR created: ${prUrl}`,
          },
        });
        console.log(`[Runner] PR created for ${task.issueIdentifier}: ${prUrl}`);
        if (afterPublication) {
          try {
            await afterPublication({ prUrl, headSha, worktreeInfo });
          } catch (reviewError) {
            // The PR and durable publication record are already real. A review
            // infrastructure failure must be visible but cannot pretend the
            // publication never happened or trigger a duplicate PR on retry.
            const detail = reviewError instanceof Error ? reviewError.message : String(reviewError);
            console.error(`[Runner] PR-time review failed for ${task.issueIdentifier}:`, reviewError);
            broadcastEvent({
              type: 'log',
              data: { taskId: task.issueId || task.id, stage: 'pr-review', line: `PR-time review failed: ${detail}` },
            });
          }
        }
      } catch (err) {
        console.error('[Worktree] PR creation failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        // A worktree-mode run is not deliverable until the branch is published.
        // Keep it preserved instead of marking the issue Done with no remotely
        // reviewable artifact — and record WHY, or the ledger row is blank.
        result.success = false;
        result.failureDetail = `publication: ${message}`;
        if (err instanceof PublicationScopeMismatchError) {
          // The branch already holds commits outside the reserved write scope.
          // No retry changes that history; the worker just re-runs, finds the
          // work done, and the fence rejects the same files again — 15-min
          // backoff forever. Park it for the operator with the file list.
          result.finalStatus = 'failed';
          result.operatorPark = { code: PUBLICATION_SCOPE_PARK_REASON, reason: message };
        } else if (NO_COMMITS_TO_PUBLISH.test(message)) {
          // The worker claimed success but left the branch identical to its
          // base (its only edits were runtime artifacts the stager drops).
          // That is the attempt failing at its job, not the infrastructure
          // failing the attempt: count it against the task's retry budget so
          // a fresh attempt gets its chance and STUCK ends it — instead of the
          // 15-minute infra backoff that cgf-portal AX-874 rode twice in an
          // hour on 2026-09-02 with nothing to show.
          result.finalStatus = 'failed';
        } else {
          result.finalStatus = 'infra_error';
        }
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR creation failed: ${message}`,
          },
        });
      }
    }
  } else if (worktreeInfo) {
    // Log why PR was not created
    const reason = !result.success
      ? `Pipeline failed (${result.finalStatus})`
      : `Unexpected state (success=${result.success}, finalStatus=${result.finalStatus})`;
    console.log(`[Runner] PR not created for ${task.issueIdentifier}: ${reason}`);
  }
}
