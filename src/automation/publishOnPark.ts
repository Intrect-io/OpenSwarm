// ============================================
// OpenSwarm — publishing a finished run's branch (AGT-4076)
// ============================================
//
// The publication paths a worktree-mode run can take, kept together because
// they share `commitAndCreatePR` and differ only in what the run earned:
//
// - `publishApprovedWork` — the reviewed path. A publication failure is fatal:
//   a run is not deliverable until its branch is reviewable.
// - `publishParkedWork` — a run that stopped for an operator decision. Draft,
//   and a failure never changes the park.
// A run that failed, was rejected, hit a rate limit or an infrastructure fault
// opens NO pull request (AGT-4786). AGT-4664 published those as drafts so their
// work was visible; on 2026-10-20 that produced 25 PRs in one night, 19 of them
// "published because this run ended as infra_error", several +3/-0 against
// multi-defect issues and all titled with the whole issue plus `Closes`. An
// infrastructure failure is not a deliverable. The work is not lost:
// `preserveWorktree` WIP-commits it onto the swarm branch and keeps the tree,
// and the retry resumes from that branch.
//
// `publishFinishedRun` runs the two that remain in the order a run can need them.
//
// Split out of runnerExecution.ts, which sits on the 1500-line pre-commit cap.

import { broadcastEvent } from '../core/eventHub.js';
import { enforcedFileScope, type FileScopeSource } from '../orchestration/writeScope.js';
import { PublicationScopeMismatchError } from '../support/publicationScopeFence.js';
import { SensitiveDataError } from '../support/sensitiveDataFence.js';
import { commitAndCreatePRWithHead, type WorktreeInfo } from '../support/worktreeManager.js';
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import { WORKER_NO_CHANGES_PARK_REASON, WORKER_NO_CHANGES_STATEMENT_PREFIX } from '../agents/pairPipelineTypes.js';
import type { VerifyConfig } from '../core/types.js';
import { pipelineExecutionBoundary, type StageBoundaryResults } from '../agents/stageExecutionBoundary.js';

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
/** NEEDS_HUMAN code for a branch carrying customer credentials / financial PII (AGT-4188). Never auto-retried. */
export const SENSITIVE_DATA_PARK_REASON = 'sensitive_data_on_branch';

export { WORKER_NO_CHANGES_PARK_REASON } from '../agents/pairPipelineTypes.js';

/** The fields these paths read; narrower than the full pipeline result. */
export interface PublishableResult extends StageBoundaryResults {
  success?: boolean;
  finalStatus?: string;
  prUrl?: string;
  workerResult?: { executionOutcomeUnknown?: boolean; noChangesReason?: string };
  operatorPark?: { code: string; reason: string };
}

/** The fields these paths read off the task. */
export interface PublishableTask {
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
  if (!hasWorktree || pipelineExecutionBoundary(result)?.executionOutcomeUnknown === true || result.prUrl) return false;
  // `waiting_on_operator` is one way a run stops for a person; an
  // `operatorPark` — the publication-scope fence, a worker that delivered
  // nothing — is another, and it was added without this. vega-agent AGT-3844
  // parked that way on 2026-09-02 holding 42 commits whose net diff is four
  // files, and published nothing at all.
  return result.finalStatus === 'waiting_on_operator' || Boolean(result.operatorPark);
}

/**
 * Publish the branch of a run that stopped for an operator decision.
 *
 * Commits whatever is still uncommitted, pushes, and leaves a clean tree for
 * the caller to remove (see the options comment below).
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
  afterPublication?: ApprovedPublicationHook,
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
  let published: { prUrl: string; headSha: string } | null = null;
  try {
    const publication = await commitAndCreatePRWithHead(
      worktreeInfo,
      task.title,
      task.issueIdentifier || '',
      'Published because this run parked for an operator decision, so the work is'
        + ' visible instead of sitting on an unpushed branch. It has not been'
        + ' reviewed — this PR is a draft on purpose.',
      // Draft: nothing reviewed this. Everything in the tree is committed
      // first, so the push carries the whole of the worker's work and the tree
      // is clean afterwards — `preserveWorktree` then removes it, and the
      // resume rebuilds from the pushed branch (`createWorktree` reuses an
      // existing branch). The old `committedOnly` mode left the tree dirty so
      // the resume found it exactly as the worker left it; that kept an
      // unpublished diff on disk, and dead daemons' trees piled up to 54 GB
      // with no PR for any of them (2026-10-03).
      //
      // No write-scope fence. The fence stops an unreviewed run from
      // *delivering* files it never reserved; this PR delivers nothing — it is
      // how the person the run is waiting on sees what it built. Enforcing it
      // here only hides the branch, which is the exact failure this function
      // exists to fix (AGT-3844 parked on that fence holding 42 commits).
      { draft: true },
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
      published = { prUrl, headSha };
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

  // A draft is the *least* reviewed thing this daemon emits — the run stopped
  // because it could not finish — and until AGT-4278 it was also the only
  // publication no reviewer ever looked at. The verdict cannot roll anything
  // back here (it is already a draft), but it is the starting point for
  // whoever picks the draft up.
  //
  // Outside the try above on purpose: a hook that throws must not be reported
  // as "could not publish parked work" when the PR exists and was attached.
  if (published && afterPublication) {
    try {
      await afterPublication({ ...published, worktreeInfo });
    } catch (err) {
      console.warn(`[Runner] Post-publication review failed for ${task.issueIdentifier}:`, err);
    }
  }
}

/**
 * Publish a parked run's branch as a draft, once, if this outcome is a park.
 *
 * Called on both sides of the approved publish because a run parks either
 * before it (the pipeline sets `operatorPark`) or during it (the scope fence
 * refuses the push). vega-agent AGT-3844 parked the second way on 2026-09-02
 * holding 42 commits — a four-file CI fix — and published nothing at all.
 */
export async function publishParkedIfNeeded(
  worktreeInfo: WorktreeInfo | null | undefined,
  task: PublishableTask,
  result: PublishableResult,
  durability: ExecutionDurabilityHooks | undefined,
  afterPublication?: ApprovedPublicationHook,
): Promise<boolean> {
  if (!worktreeInfo || !shouldPublishParkedWork(true, result)) return false;
  await publishParkedWork(worktreeInfo, task, durability, afterPublication);
  return true;
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
      // Commit-all: this tree is about to be deleted, so anything still
      // uncommitted is about to be lost. The pre-cleanup WIP commit normally
      // captures it first and makes this a no-op (a clean tree skips the whole
      // commit phase) — but that commit swallows its own failures, and this is
      // the second chance.
      // No write-scope fence, for the reason publishParkedWork documents: a
      // draft PR nobody merged is how the operator sees the work, and this
      // tree is about to be deleted.
      { draft: true },
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
  verify?: VerifyConfig,
): Promise<void> {
  // Create PR (worktree mode + pipeline success = finalStatus 'approved')
  if (worktreeInfo && result.success && result.finalStatus === 'approved') {
    const publishAllowed = await durability?.beforePublish() ?? true;
    if (!publishAllowed) {
      result.success = false;
      result.finalStatus = 'infra_error';
      // Without this the ledger fell back to `lastReviewFeedback` — an
      // approved run's fence rejection then recorded the REVIEWER'S APPROVAL
      // TEXT as if it were the failure. cgf-portal AX-1020 hit this twice
      // (2026-08-31): both attempts read as SentryAudits sign-off, and the
      // actual cause — the fence, and why it fired — was unrecoverable once
      // the container's log was gone.
      result.failureDetail = 'publication: lease fence rejected the approved publish (a newer generation now owns this run, or the lease expired)';
      console.warn(`[Worktree] Publication fenced for ${task.issueIdentifier}; preserving worktree`);
    } else {
      try {
        const publication = await commitAndCreatePRWithHead(
          worktreeInfo,
          task.title,
          task.issueIdentifier || '',
          task.description || '',
          { fileScope: enforcedFileScope(task), verify },
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
        if (err instanceof SensitiveDataError) {
          // Customer credentials / financial PII on the branch. No retry can
          // rewrite that history, and pushing it is the one outcome this fence
          // exists to prevent — park for a person with the file list (AGT-4188).
          result.finalStatus = 'failed';
          result.operatorPark = { code: SENSITIVE_DATA_PARK_REASON, reason: message };
        } else if (err instanceof PublicationScopeMismatchError) {
          // The branch already holds commits outside the reserved write scope.
          // No retry changes that history; the worker just re-runs, finds the
          // work done, and the fence rejects the same files again — 15-min
          // backoff forever. Park it for the operator with the file list.
          result.finalStatus = 'failed';
          result.operatorPark = { code: PUBLICATION_SCOPE_PARK_REASON, reason: message };
        } else if (NO_COMMITS_TO_PUBLISH.test(message)) {
          result.finalStatus = 'failed';
          const noChangesReason = result.workerResult?.noChangesReason?.trim();
          if (noChangesReason) {
            // The worker looked and said, in so many words, that the issue
            // needs no edit. Re-running the same question is not a retry, it
            // is the same answer at the same price (cgf-portal AX-874 gave it
            // four times in a row on 2026-09-02, 921k tokens each, and the
            // operator never saw a word of it: the ledger only said "No
            // commits"). Park with the worker's statement so the operator can
            // close the issue or send it back with what the worker missed.
            result.failureDetail = `publication: ${message} — worker: ${noChangesReason}`;
            result.operatorPark = { code: WORKER_NO_CHANGES_PARK_REASON, reason: `${WORKER_NO_CHANGES_STATEMENT_PREFIX} ${noChangesReason}` };
          }
          // Otherwise the worker claimed edits that were only runtime
          // artifacts the stager drops. That is the attempt failing at its
          // job, not the infrastructure failing the attempt: count it against
          // the task's retry budget so a fresh attempt gets its chance and
          // STUCK ends it — instead of the 15-minute infra backoff that
          // cgf-portal AX-874 rode twice in an hour on 2026-09-02.
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

// A pytest progress row is only result marks and a percentage. The first 500
// characters of a failing run were all of them, so a draft PR said nothing about
// what failed (AGT-4672: #796, #798); the failing ids and totals come last.
const PROGRESS_RUN = /(?:^|\s)[.sxXFE]{8,}(?=\s|$)/g;
const PERCENT_MARK = /\s\[\s*\d{1,3}%\]/g;
const SUMMARY_CAP = 500;
const SUMMARY_HEAD = 150;

/** One line of a failure detail, bounded. Built for a draft PR body (AGT-4672); no caller since AGT-4786. */
export function summarizeFailure(detail: string | undefined): string {
  const flat = (detail ?? '')
    .replace(/\s+/g, ' ')
    .replace(PROGRESS_RUN, ' ')
    .replace(PERCENT_MARK, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return 'no failure detail was recorded';
  if (flat.length <= SUMMARY_CAP) return flat;
  // Keep both ends: the stage that failed leads, the final failure lines trail.
  return `${flat.slice(0, SUMMARY_HEAD)} … ${flat.slice(-(SUMMARY_CAP - SUMMARY_HEAD))}`;
}

/**
 * Every publication a finished run can need, in the order it can need them.
 *
 * 1. parked before the approved publish (the pipeline set `operatorPark`);
 * 2. the approved publish itself;
 * 3. parked during it (the scope fence refused the push) — only if 1 did not
 *    already publish.
 *
 * A run that did not finish — failed, rejected, infra_error, rate_limited —
 * takes none of these and opens no pull request (AGT-4786, see the file header).
 *
 * A run takes at most one of these. They are separate steps rather than one
 * decision because 1 and 3 depend on what 2 did to the result.
 *
 * `reviewHook` builds the post-publication review for 1 and 3; 2 gets the
 * rolling-back variant.
 *
 * `opts` is kept for the call site's sake and is no longer read: `lifecycleFailed`
 * and `failureSummary` only fed the unfinished-run draft that this no longer opens.
 * `summarizeFailure` stays as a tested pure function for the tracker comment the
 * follow-up will write.
 */
export async function publishFinishedRun(
  worktreeInfo: WorktreeInfo | null | undefined,
  task: PublishableTask,
  result: PublishableResult & Pick<PipelineResult, 'failureDetail' | 'operatorPark'>,
  durability: ExecutionDurabilityHooks | undefined,
  reviewHook: (rollbackOnRejection: boolean) => ApprovedPublicationHook | undefined,
  verify?: VerifyConfig,
  // Not read (see above); typed so the call site keeps compiling.
  _opts: { lifecycleFailed?: boolean; failureSummary?: string } = {},
): Promise<void> {
  const parkedPublished = await publishParkedIfNeeded(worktreeInfo, task, result, durability, reviewHook(false));

  await publishApprovedWork(worktreeInfo, task, result, durability, reviewHook(true), verify);
  if (!parkedPublished) {
    await publishParkedIfNeeded(worktreeInfo, task, result, durability, reviewHook(false));
  }
}
