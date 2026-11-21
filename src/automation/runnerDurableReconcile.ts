// Created: 2026-11-22
// Purpose: the runner's durable-ledger lanes — durable execution admission (executeDurably), missing-worktree
//          pointer sweep, NEEDS_RECONCILE artifact recovery, legacy run-state import and the outbox drain —
//          moved out of autonomousRunner.ts as host-taking functions with their per-runner state (AGT-4867 slice E)
// Dependencies: durableRunCoordinator, trackerEffects, coordinatorResolution, missingWorktreeReconciler,
//               worktreeManager, ghPullRequests, draftPullRequestCause, runnerState, taskState/store,
//               coordination (channelQueue, projectRuntime, coordinationThreadOutbox), repoMetadata
// Test Status: autonomousRunner.durable/pause/serialLifecycle/idleBackoff/infraError/dispatch tests,
//              runnerDurableReconcile.test.ts (host contract, late binding, per-runner drain coalescing)

import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import { interruptEndedTaskDeliveries } from '../coordination/channelQueue.js';
import { runningProjectSessions } from '../coordination/projectRuntime.js';
import { drainCoordinationThreadOutbox } from '../coordination/coordinationThreadOutbox.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { findPullRequestForBranch, inspectWorktreeRecovery } from '../support/worktreeManager.js';
import { findDuplicateIssuePRs } from '../support/ghPullRequests.js';
import { STUCK_LABEL } from '../linear/index.js';
import { getTaskState } from '../taskState/store.js';
import { clearRejection, clearRetryTime, isRejectionLimitReached, type LastFailureEntry } from './runnerState.js';
import { getTaskSource } from './runnerExecution.js';
import { effectiveProjectConcurrency, worktreeFanoutEnabled } from './runnerAdmissionPolicy.js';
import { resolvePerIssueAttemptsPerDay } from './runLedgerCost.js';
import {
  runRecordToTask,
  type DurableRunCoordinator,
  type ExecutionDurabilityHooks,
  type RepositoryAdmissionPolicy,
} from './durableRunCoordinator.js';
import type { EffectClaim, ImportRunInput } from './runLedger.js';
import { buildCancellationEffect, buildCompletionEffect, deliverTrackerEffect } from './trackerEffects.js';
import { draftPullRequestCause } from './draftPullRequestCause.js';
import { reconcileMissingWorktrees } from './missingWorktreeReconciler.js';
import { planCoordinatorResolution } from './coordinatorResolution.js';
import type { RunnerPauseControl } from './runnerPauseControl.js';
import type { AutonomousConfig } from './runnerTypes.js';

/**
 * Per-runner durable-reconcile state. Each runner owns one instance (never module-global),
 * so two runners in one process never share an in-flight outbox drain.
 */
export interface DurableReconcileState {
  /** The in-flight outbox drain; concurrent drains on one runner coalesce into it. Cleared in finally. */
  outboxDrain: Promise<void> | null;
}

export function createDurableReconcileState(): DurableReconcileState {
  return { outboxDrain: null };
}

/**
 * What the durable lanes need from the runner. The runner builds it so every
 * member is read at call time: state through getters, and every method through
 * the runner itself, so a test (or a later reassignment) of a runner member —
 * `executePipeline`, `drainDurableOutbox`, `deliverOutboxEffect`, `resolveProjectPath`,
 * `getRunningTasks`, `durableRuns`, ... — is honoured exactly as when this code lived on the class.
 */
export interface DurableReconcileHost {
  readonly durableReconcile: DurableReconcileState;
  readonly config: AutonomousConfig;
  readonly durableRuns: DurableRunCoordinator;
  readonly pauses: Pick<RunnerPauseControl, 'pausedResult' | 'consumePauseCancel'>;
  readonly stopping: boolean;
  readonly completedTaskIds: Set<string>;
  readonly failedTaskCounts: Map<string, number>;
  readonly failedTaskRetryTimes: Map<string, number>;
  readonly consecutiveInfraErrorCounts: Map<string, number>;
  readonly lastFailureDetails: Map<string, LastFailureEntry>;
  readonly maxRetryCount: number;
  getRunningTasks(): ReturnType<TaskScheduler['getRunningTasks']>;
  syslog(line: string): void;
  saveTaskState(): void;
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  executePipeline(
    task: TaskItem,
    projectPath: string,
    signal?: AbortSignal,
    durability?: ExecutionDurabilityHooks,
  ): Promise<PipelineResult>;
  deliverOutboxEffect(effect: EffectClaim): Promise<void>;
  drainDurableOutbox(): Promise<void>;
}

export async function executeDurably(host: DurableReconcileHost, task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult> {
  const cancelled = (): PipelineResult => ({
    success: false,
    sessionId: `runner-stopping-${Date.now()}`,
    stages: [],
    finalStatus: 'cancelled',
    totalDuration: 0,
    iterations: 0,
    taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
  });
  if (host.stopping || signal?.aborted) return cancelled();
  const paused = host.pauses.pausedResult(task, projectPath); if (paused) return paused; // AGT-4808, fresh read, fails closed

  let admission: RepositoryAdmissionPolicy;
  try {
    const metadata = await loadRepoMetadata(projectPath);
    if (metadata?.automation?.enabled === false) {
      return {
        success: false,
        sessionId: `repo-admission-disabled-${Date.now()}`,
        stages: [],
        finalStatus: 'superseded',
        totalDuration: 0,
        iterations: 0,
        taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
      };
    }
    const sameRepoParallelAllowed = worktreeFanoutEnabled(host.config);
    admission = {
      maxConcurrent: sameRepoParallelAllowed
        ? (metadata?.automation?.maxConcurrent ?? effectiveProjectConcurrency(host.config))
        : 1,
      // Worktrees isolate live filesystem writes, not the branches that must
      // later merge. Always carry the predicted write set into the durable
      // claim so another daemon / `openswarm work` process cannot race past
      // this heartbeat's in-memory conflict check. An empty scope fails
      // closed while another same-repository run is active.
      conflictScope: task.fileScope ?? [],
      unknownScopeAdmission: host.config.unknownScopeAdmission,
      // A fixed default attempt budget of 12 made a 32-slot daemon trip its
      // repository circuit before the first pool could even fill. Treat this
      // as an explicit repository policy; failure and cost circuits remain
      // independent safety boundaries.
      maxAttemptsPerHour: metadata?.automation?.maxAttemptsPerHour,
      maxFailuresPerHour: metadata?.automation?.maxFailuresPerHour ?? 6,
      maxCostUsdPerDay: metadata?.automation?.maxCostUsdPerDay ?? host.config.budget?.perProjectDailyUsd, globalMaxCostUsdPerDay: host.config.spend?.maxCostUsdPerDay, unknownAttemptCostUsd: host.config.spend?.unknownAttemptCostUsd, maxCostUsdPerIssue: host.config.budget?.perIssueUsd, maxAttemptsPerIssuePerDay: resolvePerIssueAttemptsPerDay(host.config.budget), // budget: AGT-4807, AGT-4787
      circuitCooldownMs: (metadata?.automation?.circuitCooldownMinutes ?? 60) * 60_000,
    };
  } catch (error) {
    console.error(`[Admission] Invalid/unreadable repository policy for ${projectPath}:`, error);
    return {
      success: false,
      sessionId: `repo-admission-error-${Date.now()}`,
      failureDetail: `repository admission policy: ${error instanceof Error ? error.message : String(error)}`,
      stages: [],
      finalStatus: 'infra_error',
      totalDuration: 0,
      iterations: 0,
      taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
    };
  }

  if (host.stopping || signal?.aborted) return cancelled();

  return host.durableRuns.execute(
    task,
    projectPath,
    (durability, leaseSignal) => host.executePipeline(
      task,
      projectPath,
      signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal,
      durability,
    ),
    {
      admission,
      successEffect: (result, claim) => buildCompletionEffect(task, result, claim.attemptNo),
      cancelEffect: (_result, claim) => buildCancellationEffect(task, claim.attemptNo),
      retryCancellation: () => host.stopping || host.pauses.consumePauseCancel(task.id), // a `now` pause resumes after unpause
      resolveOperatorPark: (parkedTask, parkedResult, attemptNo) => planCoordinatorResolution({
        task: parkedTask,
        result: parkedResult,
        attemptNo,
      }),
    },
  );
}

/** Sweep stale ledger pointers before artifact recovery or pruning can act on them. */
// Classified failures, durable per-run backoff, concurrent probes: missingWorktreeReconciler.ts (round-1 redteam B-F3).
export async function reconcileMissingWorktreePointers(host: DurableReconcileHost): Promise<void> {
  await reconcileMissingWorktrees({
    durableRuns: host.durableRuns,
    stopping: () => host.stopping,
    findPullRequestForBranch,
    findDuplicateIssuePRs,
  });
}

export async function reconcileDurableArtifacts(host: DurableReconcileHost, tasks: TaskItem[]): Promise<void> {
  if (!host.durableRuns.isPrimary || host.stopping) return;
  const taskById = new Map(tasks.map((task) => [task.issueId || task.id, task]));

  for (const run of host.durableRuns.listRuns(['NEEDS_RECONCILE'])) {
    if (host.stopping) return;
    // One row's failure must not take the heartbeat with it. This loop runs
    // inside `heartbeat()`'s try, with no per-row catch, so a throw here
    // aborts the ENTIRE cycle before any task is selected — which is how the
    // AGT-4518 dedupe collision produced `[HB] ✗ Heartbeat error: Outbox
    // dedupe key collision` and stopped all work, not just that row. The
    // throw itself is fixed, but the blast radius was the real defect: park
    // this row, log it, and keep reconciling the others.
    try {
    // A task may legitimately be absent: the fetch asks only for Todo /
    // In Progress / In Review / Backlog, so an issue that reached Done is
    // structurally invisible here. That makes absence ambiguous for the
    // worktree path below — which re-runs work — but not for the branch
    // path, where GitHub is the authority. So the guard moved down to the
    // one place it actually protects something. (AGT-4094)
    const task = taskById.get(run.issueId);
    if (run.ownerInstanceId || run.leaseToken) {
      // Not "until its executor exits": a container restart replaces the
      // process holding the claim, so that exit is never observed and the
      // line reads as a permanent wedge. What actually frees the row is the
      // age sweep in durableRunCoordinator, so report its deadline. (AGT-4126)
      console.warn(host.durableRuns.fenceWaitMessage(run));
      continue;
    }

    if (run.branchName) {
      let pr;
      try {
        pr = await findPullRequestForBranch(run.projectPath, run.branchName);
      } catch (error) {
        console.warn(`[Reconciler] GitHub lookup failed for ${run.identifier ?? run.issueId}; keeping NEEDS_RECONCILE:`, error);
        continue;
      }

      if (pr) {
        if (pr.state === 'CLOSED') {
          host.durableRuns.markNeedsHuman(run.issueId, `Published PR was closed without merge: ${pr.url}`);
          continue;
        }
        // A draft is the branch saying it is not finished, and recovering
        // one as 'approved' would close the issue on work nobody accepted
        // with no human prompted to look (AGT-4270). But the three reasons a
        // PR is a draft want three different things (AGT-4272):
        //
        // - the PR-time review rejected it and moved it back: re-run. The
        //   commits stay on the branch, so the next attempt fixes rather
        //   than restarts. Unlike the recovery below this RE-RUNS work, so
        //   it needs the live tracker card the note at the top of this loop
        //   describes — re-queueing an issue the heartbeat cannot see pays
        //   a worker attempt for a card nobody can see (AGT-4094);
        // - a sibling PR already closes the issue (INT-2544): the draft is
        //   deliberate and survives every republish, so a re-run can never
        //   make it ready — it only burns attempts. The work is delivered;
        //   record it as such;
        // - anything else is a publication a human has to judge: park it
        //   with the draft in the reason instead of re-running it.
        if (pr.isDraft) {
          const siblings = run.identifier
            ? await findDuplicateIssuePRs(run.projectPath, run.identifier, run.branchName)
            : [];
          const cause = draftPullRequestCause(run.lastErrorCode, siblings.length);
          if (cause === 'review_rollback') {
            if (!task) {
              console.warn(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) rolled back by review but no live tracker card — leaving it for the terminal-run reconciler`);
              continue;
            }
            if (host.durableRuns.markReady(run.issueId)) {
              console.log(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) rolled back by review — returned to the queue rather than completed`);
            }
            continue;
          }
          if (cause === 'parked_publication') {
            if (host.durableRuns.markNeedsHuman(run.issueId, `Draft PR needs a human: ${pr.url} — not a review rollback and no sibling PR closes the issue`)) {
              console.log(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) of no recorded cause — parked for a human rather than re-run`);
            }
            continue;
          }
          console.log(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) because ${siblings.length} sibling PR(s) already close the issue — recording it as delivered`);
        }
        const publishedTask = task ?? runRecordToTask(run);
        const recoveredResult: PipelineResult = {
          success: true,
          sessionId: `recovered-publication-${run.attemptNo}`,
          stages: [],
          finalStatus: 'approved',
          totalDuration: 0,
          iterations: Math.max(1, run.attemptNo),
          prUrl: pr.url,
          taskContext: {
            issueIdentifier: publishedTask.issueIdentifier || run.identifier,
            projectName: publishedTask.linearProject?.name,
            projectPath: run.projectPath,
            taskTitle: publishedTask.title,
          },
        };
        if (host.durableRuns.recoverPublishedRun(
          run.issueId,
          { prUrl: pr.url, headSha: pr.headSha },
          buildCompletionEffect(publishedTask, recoveredResult, run.attemptNo),
        )) {
          console.log(`[Reconciler] Recovered published run ${run.identifier ?? run.issueId}: ${pr.url}`);
        }
        continue;
      }
    }

    // No PR exists, so nothing was published and the only way out of this
    // state is to run the work again — which needs a live tracker card.
    // Log it: this branch used to be the loop's one silent exit, which is
    // exactly why a row stuck here was invisible to log-reading. (AGT-4094)
    if (!task) {
      console.warn(`[Reconciler] Keeping ${run.identifier ?? run.issueId} in NEEDS_RECONCILE (no published PR and no actionable task)`);
      continue;
    }

    // Never overlap a replacement with an executor that lost its lease but
    // still owns the filesystem. Missing/ambiguous markers stay parked;
    // preserved work or a dead owner is safe for createWorktree to resume.
    const recovery = await inspectWorktreeRecovery(run.projectPath, run.issueId, run.worktreePath, host.durableRuns.deadMarkerOwners(run.issueId))
      .catch((error) => {
        console.warn(`[Reconciler] Worktree evidence unreadable for ${run.identifier ?? run.issueId}:`, error);
        return null;
      });
    if (!recovery || recovery.state === 'active_owner' || recovery.state === 'ambiguous') {
      console.warn(`[Reconciler] Keeping ${run.identifier ?? run.issueId} in NEEDS_RECONCILE (${recovery?.state ?? 'inspection_failed'})`);
      continue;
    }
    if (host.durableRuns.markReady(run.issueId)) {
      console.log(`[Reconciler] ${recovery.state === 'missing' ? 'Reopening branch' : 'Resuming worktree'} for ${run.identifier ?? run.issueId}`);
    }
    } catch (error) { // cxt-ignore: error_swallow — one row's failure stays this row's; the rest of the sweep and the rest of the heartbeat continue
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Reconciler] Reconciliation failed for ${run.identifier ?? run.issueId}; keeping NEEDS_RECONCILE:`, detail);
    }
  }
  await host.drainDurableOutbox();
}

export async function migrateLegacyRunState(host: DurableReconcileHost, tasks: TaskItem[]): Promise<void> {
  if (!host.durableRuns.isPrimary || host.stopping) return;
  let imported = 0;
  for (const task of tasks) {
    if (host.stopping) return;
    const issueId = task.issueId || task.id;
    if (host.durableRuns.getRun(issueId)) continue;

    const canonical = getTaskState(issueId);
    const failedCount = host.failedTaskCounts.get(issueId) ?? 0;
    const retryAt = host.failedTaskRetryTimes.get(issueId);
    const legacyCompleted = host.completedTaskIds.has(issueId);
    const canonicalStatus = canonical?.execution.status;
    const hasLegacySignal = legacyCompleted
      || failedCount > 0
      || retryAt != null
      || ['in_progress', 'in_review', 'failed', 'halted', 'done', 'decomposed'].includes(canonicalStatus ?? '');
    if (!hasLegacySignal) continue;

    const projectPath = task.projectPath ?? await host.resolveProjectPath(task);
    if (!projectPath || host.stopping) continue;

    let state: ImportRunInput['state'];
    let reason: string;
    if (
      task.labels?.includes(STUCK_LABEL)
      || failedCount >= host.maxRetryCount
      || isRejectionLimitReached(issueId)
      || canonicalStatus === 'failed'
      || canonicalStatus === 'halted'
    ) {
      state = 'NEEDS_HUMAN';
      reason = 'Legacy state indicates exhausted or human-blocked execution';
    } else if (canonicalStatus === 'done' || task.linearState === 'Done') {
      state = 'DONE';
      reason = 'Legacy and tracker state agree that the issue is complete';
    } else if (canonicalStatus === 'decomposed') {
      state = 'DECOMPOSED';
      reason = 'Legacy task state records successful decomposition';
    } else if (
      legacyCompleted
      || canonicalStatus === 'in_progress'
      || canonicalStatus === 'in_review'
      || canonical?.worktree.branchName
      || canonical?.worktree.worktreePath
    ) {
      state = 'NEEDS_RECONCILE';
      reason = 'Legacy state may have in-flight or published work; artifact reconciliation required';
    } else if (retryAt != null && retryAt > Date.now()) {
      state = 'RETRY_AT';
      reason = 'Legacy retry backoff imported';
    } else {
      state = 'READY';
      reason = 'Legacy nonterminal state imported as claimable work';
    }

    const result = host.durableRuns.importLegacyRun({
      issueId,
      source: task.source ?? 'unknown',
      identifier: task.issueIdentifier,
      title: task.title,
      projectPath,
      state,
      retryAt,
      branchName: canonical?.worktree.branchName,
      worktreePath: canonical?.worktree.worktreePath,
      errorCode: 'legacy_import',
      errorMessage: reason,
      metadata: {
        legacyCompleted,
        failedCount,
        canonicalStatus,
        importedAt: new Date().toISOString(),
      },
    });
    if (result?.imported) imported++;
  }
  if (imported > 0) host.syslog(`✓ Imported ${imported} legacy run state(s) into automation.db`);
}

export async function deliverOutboxEffect(effect: EffectClaim): Promise<void> {
  return deliverTrackerEffect(effect, getTaskSource());
}

export async function drainDurableOutbox(host: DurableReconcileHost): Promise<void> {
  try { interruptEndedTaskDeliveries(runningProjectSessions(host)); }
  catch (error) { console.warn('[Channels] Recipient reconciliation unavailable:', error instanceof Error ? error.message : String(error)); }
  const threadOutcome = await drainCoordinationThreadOutbox();
  if (threadOutcome.warnings.length > 0) {
    console.warn(
      `[ThreadOutbox] delivered=${threadOutcome.delivered} pending=${threadOutcome.pending} `
      + `warnings=${threadOutcome.warnings.length}`,
    );
  }
  if (!host.durableRuns.isPrimary) return;
  if (host.durableReconcile.outboxDrain) return host.durableReconcile.outboxDrain;
  const finalized = new Set<string>();
  host.durableReconcile.outboxDrain = (async () => {
    const outcome = await host.durableRuns.drainOutbox(async (effect) => {
      await host.deliverOutboxEffect(effect);
      finalized.add(effect.issueId);
    });
    for (const issueId of finalized) {
      if (host.durableRuns.getRun(issueId)?.state !== 'DONE') continue;
      host.completedTaskIds.add(issueId);
      clearRejection(issueId);
      clearRetryTime(issueId, host.failedTaskRetryTimes);
      host.consecutiveInfraErrorCounts.delete(issueId);
      host.lastFailureDetails.delete(issueId);
    }
    if (finalized.size > 0) host.saveTaskState();
    if (outcome.retried > 0 || outcome.dead > 0) {
      console.warn(`[Outbox] applied=${outcome.applied} retried=${outcome.retried} dead=${outcome.dead}`);
    }
  })().finally(() => { host.durableReconcile.outboxDrain = null; });
  return host.durableReconcile.outboxDrain;
}
