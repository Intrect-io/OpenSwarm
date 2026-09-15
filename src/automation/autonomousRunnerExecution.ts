import { clearRejection, isRejectionLimitReached, canRetryNow, clearRetryTime } from './runnerState.js';
import { taskEventKey, TaskItem, classifyStuck } from '../orchestration/decisionEngine.js';
import { drainCoordinationThreadOutbox } from '../coordination/coordinationThreadOutbox.js';
import { OPERATOR_PARK_REASON, OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
// ExecutorResult used via execution.reportExecutionResult
import { citedPathsAreEphemeral } from '../support/worktreeEphemeral.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import {
  PipelineResult,
  formatPipelineResultEmbed,
} from '../agents/pairPipeline.js';
import * as execution from './runnerExecution.js';
import { shouldRefuseShippedClaim } from './shippedClaimGate.js';
import { reportToDiscord, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { OPERATOR_QUESTION_PARK_MARKER } from './explicitDispatchReadmission.js';
import { broadcastEvent } from '../core/eventHub.js';
import { getTaskState } from '../taskState/store.js';
import { findPullRequestForBranch, inspectWorktreeRecovery } from '../support/worktreeManager.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { STUCK_LABEL } from '../linear/index.js';
import { runRecordToTask, type ExecutionDurabilityHooks, type RepositoryAdmissionPolicy } from './durableRunCoordinator.js';
import type { EffectClaim, ImportRunInput } from './runLedger.js';
import { buildCancellationEffect, buildCompletionEffect, completionStats, deliverTrackerEffect } from './trackerEffects.js';
import { planCoordinatorResolution } from './coordinatorResolution.js';
import { AutonomousRunnerCore } from './autonomousRunnerCore.js';
import { AutonomousRunnerScheduling } from './autonomousRunnerScheduling.js';
import { setOperatorPark, setSandboxOutcomePark, effectiveProjectConcurrency, worktreeFanoutEnabled } from './runnerHelpers.js';
export abstract class AutonomousRunnerExecution extends AutonomousRunnerScheduling {
  protected filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] {
    let recovered = 0;
    let stuckSkipped = 0;
    let backoffSkipped = 0;
    let answered = 0;
    let noProject = 0;
    let unresolvable = 0;
    const toUnstick: string[] = [];
    // AGT-4257 idle_fill lifts parked and backed-off rows so free slots do not
    // sit empty. Bounded by this heartbeat's free slot count: a saturated pool
    // must not churn its parks (AGT-4155 reached attempt 20 that way), and one
    // free slot must not un-park every row at once.
    let idleFillBudget = this.scheduler.hasAvailableSlot() ? this.scheduler.getAvailableSlots() : 0;
    const filtered = tasks.filter(task => {
      const id = task.issueId || task.id;
      const isStuck = task.labels?.includes(STUCK_LABEL) ?? false;
      let durableRun = this.durableRuns.getRun(id);
      // Set once this task has spent idle budget, so a later branch in this
      // same pass (the stuck-label recovery) neither charges it twice nor
      // skips a row whose park idle_fill has already erased.
      let idleLifted = false;

      if (
        this.durableRuns.isPrimary
        && durableRun
        && (
          durableRun.state === 'DONE'
          || durableRun.state === 'DECOMPOSED'
          || durableRun.state === 'CANCELLED'
        )
      ) {
        // 'Todo' (or an explicit dispatch) is the operator reopening a finished
        // run — never gated. 'Backlog' is idle fill under AGT-4257 and spends
        // budget. 'In Progress' and 'In Review' are excluded on purpose, the
        // same rule durableRunCoordinator.observeTask states for this exact
        // transition: In Progress may be owned by a human or another daemon,
        // and In Review is a published PR waiting on the merge gate. Reopening
        // either re-decomposes or re-publishes work that already exists.
        const operatorReopened = task.linearState === 'Todo' || task.explicitDispatch === true;
        const idleReopen = !operatorReopened && task.linearState === 'Backlog' && idleFillBudget > 0;
        // A published PR on a terminal run is not a retry license — without an
        // explicit remaining-work delta, Todo/Backlog flaps must not reopen it
        // (AX-863 burned 37 attempts after #179 merged; AGT-4177).
        const refuseShipped = shouldRefuseShippedClaim(task, {
          hasPrUrl: Boolean(durableRun.prUrl),
          shippedTerminal: true,
        });
        if (refuseShipped) {
          if (operatorReopened || idleReopen) {
            console.log(
              `[Scheduler] ${task.issueIdentifier ?? id} not reopened — already published ${durableRun.prUrl} (AGT-4177)`,
            );
          }
        } else if ((operatorReopened || idleReopen) && this.durableRuns.markReady(id)) {
          if (idleReopen) {
            idleFillBudget--;
            idleLifted = true;
          }
          durableRun = this.durableRuns.getRun(id);
        }
      }

      if (this.durableRuns.isPrimary && durableRun?.state === 'NEEDS_HUMAN') {
        const isOperatorQuestionPark = durableRun.lastErrorCode === OPERATOR_QUESTION_PARK_REASON
          || (durableRun.lastErrorMessage?.startsWith(OPERATOR_QUESTION_PARK_MARKER) ?? false);
        // AGT-4256: a guard/publication park that only named ephemeral paths
        // (.test_venv, pytest-local) is not a human decision. Resume even when
        // Linear is still In Progress so the next heartbeat can pick the work.
        // Checked before idle_fill so a false park never spends idle budget.
        if (!isOperatorQuestionPark && citedPathsAreEphemeral(durableRun.lastErrorMessage ?? '')) {
          const resumed = this.durableRuns.resumeNeedsHuman(id, Date.now(), 'unspecified');
          if (resumed) {
            console.log(`[Scheduler] ${task.issueIdentifier ?? id} resumed from NEEDS_HUMAN (ephemeral-only guard park)`);
            durableRun = this.durableRuns.getRun(id);
            if (resumed === 'SYNC_PENDING') this.scheduleNextHeartbeat();
          }
        }
        if (durableRun?.state === 'NEEDS_HUMAN' && idleFillBudget > 0) {
          const idleResumed = this.durableRuns.resumeNeedsHuman(id, Date.now(), 'idle_fill');
          if (idleResumed) {
            idleFillBudget--;
            idleLifted = true;
            console.log(`[Scheduler] ${task.issueIdentifier ?? id} resumed from NEEDS_HUMAN (idle_fill, ${idleFillBudget} free slot(s) left)`);
            const lifted = this.durableRuns.getRun(id);
            if (lifted) durableRun = lifted;
            if (idleResumed === 'SYNC_PENDING') this.scheduleNextHeartbeat();
          }
        }
      }

      if (this.durableRuns.isPrimary && durableRun) {
        // AGT-4257: a parked/backoff row is still work. Lift it so claimRun
        // can take the slot instead of the heartbeat returning skip — one row
        // per free slot. An elapsed RETRY_AT needs no lift and passes below
        // without spending budget. WAITING_EXTERNAL is a run whose published
        // effect is still pending, not a park: lifting it re-runs the task on
        // top of its own in-flight publish.
        //
        // A RETRY_AT row can be parked there for infra_error same as any other
        // reason, and this is the durable-ledger counterpart of the legacy
        // idle-fill bypass gated below by `consecutiveInfraErrorCounts` — without
        // it here too, an issue whose durable row already exists (true for
        // anything that has ever failed once) never reaches that legacy gate at
        // all, since `legacyIsAuthority` is false whenever this block ran and
        // left a durable run in place. (AGT-4305 — this is the branch AX-1272
        // was actually looping through in production.)
        // Only throttle a RETRY_AT that is CURRENTLY backed off for infra_error —
        // `consecutiveInfraErrorCounts` does not reset on a later, unrelated
        // rejection/failure retry for the same issue (by design; see the field
        // comment), so without the lastErrorCode check a stale infra streak
        // would keep throttling idle-fill for a RETRY_AT caused by an ordinary
        // task-level rejection long after the infra episode ended.
        const infraStreak = durableRun.lastErrorCode === 'infra_error'
          ? this.consecutiveInfraErrorCounts.get(id) ?? 0
          : 0;
        const idleLiftable = (
          durableRun.state === 'RETRY_AT'
          && (durableRun.retryAt ?? 0) > Date.now()
          && infraStreak < AutonomousRunnerCore.MAX_CONSECUTIVE_INFRA_IDLE_FILL
        )
          || durableRun.state === 'NEEDS_SPEC'
          || durableRun.state === 'NEEDS_ENV';
        if (idleLiftable && idleFillBudget > 0 && this.durableRuns.markReady(id)) {
          idleFillBudget--;
          idleLifted = true;
          const lifted = this.durableRuns.getRun(id);
          if (lifted) durableRun = lifted;
        }
        if (!durableRun) return false;
        if (['DONE', 'DECOMPOSED', 'CANCELLED', 'NEEDS_HUMAN'].includes(durableRun.state)) return false;
        if (['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING', 'SYNC_PENDING', 'NEEDS_RECONCILE'].includes(durableRun.state)) return false;
        if (durableRun.state === 'RETRY_AT' && (durableRun.retryAt ?? 0) > Date.now()) {
          // Unless the only thing it was waiting for has arrived. A task parked
          // on `ask_human` sits here, and this backoff is also its resume path,
          // so left alone it makes the operator's reply land up to two hours
          // after they sent it. `markReady` is what actually unblocks it: the
          // ledger refuses to claim a RETRY_AT row whose time has not come, so
          // passing this filter alone would change nothing.
          if (!this.readmitAnsweredRun(id)) {
            backoffSkipped++;
            return false;
          }
          durableRun = this.durableRuns.getRun(id);
          answered++;
        }
      }

      // No Linear project → can't be routed to a repo. Drop here (quietly, once per
      // heartbeat) instead of letting a whole batch of project-less Todos reach the
      // per-task selector and spam "No repo mapped to ... undefined" every cycle.
      if (!task.linearProject?.id) {
        noProject++;
        return false;
      }

      // Project resolved to no local repo on a previous heartbeat → don't re-pick
      // it (it would starve runnable tasks behind it). (INT-1875)
      if (this.unresolvableIssueIds.has(id)) {
        unresolvable++;
        return false;
      }

      const legacyIsAuthority = !this.durableRuns.isPrimary || !durableRun;

      if (legacyIsAuthority
          && getTaskState(id)?.execution?.blockedReason === SANDBOX_OUTCOME_UNKNOWN_PARK_REASON) {
        if (task.explicitDispatch !== true) return false;
        setSandboxOutcomePark(id, false);
      }

      // Check rejection limit first. Once an issue has a durable row, the
      // imported ledger state replaces legacy JSON counters as authority.
      if (legacyIsAuthority && isRejectionLimitReached(id)) {
        return false; // Skip tasks that hit max rejection limit
      }

      // Stuck handling (INT-1908): a permanently-blocked issue is parked in Backlog
      // with the `swarm:stuck` label and must NOT be retried automatically. The
      // recovery branch only fires when the user pulls the issue back to an active
      // state — the previous code re-selected it every heartbeat because blocking
      // left it in Todo (a recoverable state), which the recovery branch then
      // mistook for deliberate user intervention.
      const hasFailureHistory = legacyIsAuthority
        && (this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunnerCore.MAX_RETRY_COUNT);
      const stuckDecision = classifyStuck({ isStuck, linearState: task.linearState, hasFailureHistory });
      if (stuckDecision === 'recover') {
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id); // Clear rejection count on recovery
        clearRetryTime(id, this.failedTaskRetryTimes); // Clear retry backoff time
        this.consecutiveInfraErrorCounts.delete(id);
        if (isStuck) toUnstick.push(id); // strip the stuck label so it is not re-skipped
        recovered++;
        return true;
      }
      if (stuckDecision === 'skip-stuck') {
        // AGT-4257: a stuck label must not idle an enabled pool. Linear still
        // showing the card means the work is wanted — but only a free slot
        // justifies re-running an issue whose retries are exhausted.
        if (!idleLifted) {
          if (idleFillBudget <= 0) {
            stuckSkipped++;
            return false;
          }
          idleFillBudget--;
        }
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id);
        clearRetryTime(id, this.failedTaskRetryTimes);
        this.consecutiveInfraErrorCounts.delete(id);
        if (isStuck) toUnstick.push(id);
        recovered++;
        return true;
      }

      // AGT-4257 (ledger-off): a locally completed or retry-exhausted issue whose
      // card sits in a parked state is idle fill, on the same budget as the
      // ledger lifts. (An active card — Todo / In Progress / In Review — never
      // reaches here: classifyStuck already returned 'recover' for it above.)
      if (legacyIsAuthority
          && (this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunnerCore.MAX_RETRY_COUNT)) {
        if (idleFillBudget <= 0) return false;
        idleFillBudget--;
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        recovered++;
        return true;
      }

      // External-claim guard (INT-1979 dup): an issue set to 'In Progress' that THIS
      // daemon never claimed is owned by a human or another agent — picking it up
      // would re-decompose work someone is already doing (that spawned duplicate
      // INT-1980 sub-issues + a redundant PR). markTaskInProgress writes
      // execution.status='in_progress' when WE claim, so our own in-flight work
      // (incl. resumption after a restart) still passes; a bare Linear 'In Progress'
      // with no local claim record is skipped. An explicit dispatch is the
      // operator handing it over and passes.
      //
      // Under the ledger, state alone cannot answer "is this ours": observeTask
      // registers every fetched card as READY and cacheTrackerObservation writes
      // DONE/CANCELLED straight from tracker state, both without a claim. Two
      // signals do:
      //   - attemptNo >= 1: claimRun is the only writer of that counter.
      //   - the legacy in_progress marker, which markTaskInProgress writes when
      //     WE claim. It is also what migrateLegacyRunState read to import an
      //     in-flight card at cutover, so it keeps that row — imported at
      //     attempt 0 — from deadlocking behind a counter only claimRun grows.
      if (task.linearState === 'In Progress' && task.explicitDispatch !== true) {
        const locallyClaimed = getTaskState(id)?.execution?.status === 'in_progress';
        if (this.durableRuns.isPrimary) {
          if (!durableRun || (durableRun.attemptNo === 0 && !locallyClaimed)) return false;
        } else if (!locallyClaimed) {
          return false;
        }
      }

      if (legacyIsAuthority) {
        // Check if task is in exponential backoff period — unless the only thing
        // it was waiting for has arrived. The backoff is also the resume path for
        // an `ask_human` park, so left alone it makes the operator's reply land
        // up to two hours after they sent it.
        if (!canRetryNow(id, this.failedTaskRetryTimes)) {
          const infraStreak = this.consecutiveInfraErrorCounts.get(id) ?? 0;
          if (this.answerArrivedFor(id)) {
            clearRetryTime(id, this.failedTaskRetryTimes);
            this.consecutiveInfraErrorCounts.delete(id);
            answered++;
          } else if (idleFillBudget > 0 && infraStreak < AutonomousRunnerCore.MAX_CONSECUTIVE_INFRA_IDLE_FILL) {
            // AGT-4257: free slots chew the backoff instead of sitting idle — but
            // not when the same issue has died to infra_error (timeout/CLI
            // failure, not a task failure) several times running with an idle
            // fill each time. Retrying instantly with an unchanged payload just
            // re-hits the same wall (AX-1272, 2026-09-10: same reviewer 360s
            // timeout, 9 of ~13 attempts over 4h+, ~90s apart every time because
            // this was the only candidate to fill idle slots with). Past the
            // threshold, honor the real 1h backoff so a transient provider issue
            // gets time to actually clear instead of being hammered. (AGT-4305)
            idleFillBudget--;
            clearRetryTime(id, this.failedTaskRetryTimes);
            recovered++;
          } else {
            backoffSkipped++;
            return false; // Skip tasks still in backoff period
          }
        }
        // Admitted, so the park is spent — retire it here and it expires with the
        // attempt that caused it, the way the ledger's error code does. Left set,
        // an answer from a park the task has long since left would pull it
        // forward past every later backoff.
        if (getTaskState(id)?.execution?.blockedReason === OPERATOR_PARK_REASON) {
          setOperatorPark(id, false);
        }
      }

      return true;
    });
    // Strip the stuck label from issues the user pulled back (fire-and-forget — a
    // failed unstick just means the next heartbeat tries again).
    for (const id of toUnstick) {
      getTaskSource()?.unstick(id).catch(err =>
        console.warn(`[AutonomousRunner] Failed to clear stuck label for ${id}:`, err));
    }
    if (stuckSkipped > 0) {
      // Name Todo because it is the one action that works in every mode. Under
      // the durable ledger (isPrimary) retry exhaustion also parks the run in
      // NEEDS_HUMAN and this filter returns on that state above, before the
      // label check below — so there, removing the label does nothing and
      // 'In Progress' cannot help either, being a state the pipeline writes
      // itself when it claims a task (AGT-4155). The legacy non-primary path
      // skips that gate and still recovers a labelled issue from any of
      // classifyStuck's RECOVERABLE_STATES. Todo recovers on both. The recovery
      // branch strips the label itself, so the operator only moves the card.
      this.syslog(`🛑 Skipped ${stuckSkipped} stuck issue(s) (retries exhausted — move to Todo to retry)`);
    }
    if (recovered > 0) {
      this.saveTaskState();
      this.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
    }
    if (backoffSkipped > 0) {
      this.syslog(`⏰ Skipped ${backoffSkipped} tasks in exponential backoff period`);
    }
    if (answered > 0) {
      this.syslog(`🙋 Re-admitted ${answered} task(s) early — the operator answered`);
    }
    if (noProject > 0) {
      this.syslog(`— Skipped ${noProject} issue(s) with no Linear project (assign a project in Linear to enable)`);
    }
    if (unresolvable > 0) {
      this.syslog(`— Skipped ${unresolvable} issue(s) whose Linear project maps to no local repo (fix the project or add the repo)`);
    }
    return filtered;
  }


  protected async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // Parallel processing disabled
    }

    await this.scheduler.runAvailable(async (task, projectPath, signal) => {
      return this.executeDurably(task, projectPath, signal);
    });
  }

  protected async executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult> {
    const cancelled = (): PipelineResult => ({
      success: false,
      sessionId: `runner-stopping-${Date.now()}`,
      stages: [],
      finalStatus: 'cancelled',
      totalDuration: 0,
      iterations: 0,
      taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
    });
    if (this.stopping || signal?.aborted) return cancelled();

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
      const sameRepoParallelAllowed = worktreeFanoutEnabled(this.config);
      admission = {
        maxConcurrent: sameRepoParallelAllowed
          ? (metadata?.automation?.maxConcurrent ?? effectiveProjectConcurrency(this.config))
          : 1,
        // Worktrees isolate live filesystem writes, not the branches that must
        // later merge. Always carry the predicted write set into the durable
        // claim so another daemon / `openswarm work` process cannot race past
        // this heartbeat's in-memory conflict check. An empty scope fails
        // closed while another same-repository run is active.
        conflictScope: task.fileScope ?? [],
        unknownScopeAdmission: this.config.unknownScopeAdmission,
        // A fixed default attempt budget of 12 made a 32-slot daemon trip its
        // repository circuit before the first pool could even fill. Treat this
        // as an explicit repository policy; failure and cost circuits remain
        // independent safety boundaries.
        maxAttemptsPerHour: metadata?.automation?.maxAttemptsPerHour,
        maxFailuresPerHour: metadata?.automation?.maxFailuresPerHour ?? 6,
        maxCostUsdPerDay: metadata?.automation?.maxCostUsdPerDay,
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

    if (this.stopping || signal?.aborted) return cancelled();

    return this.durableRuns.execute(
      task,
      projectPath,
      (durability, leaseSignal) => this.executePipeline(
        task,
        projectPath,
        signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal,
        durability,
      ),
      {
        admission,
        successEffect: (result, claim) => buildCompletionEffect(task, result, claim.attemptNo),
        cancelEffect: (_result, claim) => buildCancellationEffect(task, claim.attemptNo),
        retryCancellation: () => this.stopping,
        resolveOperatorPark: (parkedTask, parkedResult, attemptNo) => planCoordinatorResolution({
          task: parkedTask,
          result: parkedResult,
          attemptNo,
        }),
      },
    );
  }

  protected async reconcileDurableArtifacts(tasks: TaskItem[]): Promise<void> {
    if (!this.durableRuns.isPrimary || this.stopping) return;
    const taskById = new Map(tasks.map((task) => [task.issueId || task.id, task]));

    for (const run of this.durableRuns.listRuns(['NEEDS_RECONCILE'])) {
      if (this.stopping) return;
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
        console.warn(this.durableRuns.fenceWaitMessage(run));
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
            this.durableRuns.markNeedsHuman(run.issueId, `Published PR was closed without merge: ${pr.url}`);
            continue;
          }
          // A draft is the branch saying it is not finished — the run parked
          // and published for visibility, a sibling PR already closes the
          // issue (INT-2544), or the PR-time review rejected it and moved it
          // back (AGT-4270). Recovering any of those as 'approved' would
          // close the issue on work nobody accepted, and the draft flag means
          // no human is prompted to look either. Send it back to be worked;
          // the commits stay on the branch, so the next attempt continues
          // instead of starting over.
          //
          // Unlike the recovery below, this RE-RUNS work, so it needs the
          // live tracker card the note at the top of this loop describes: an
          // issue that already reached Done is invisible to the heartbeat
          // fetch, and re-queueing one would pay a whole worker attempt for a
          // card nobody can see. (AGT-4094)
          if (pr.isDraft) {
            if (!task) {
              console.warn(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) but no live tracker card — leaving it for the terminal-run reconciler`);
              continue;
            }
            if (this.durableRuns.markReady(run.issueId)) {
              console.log(`[Reconciler] ${run.identifier ?? run.issueId} has a draft PR (${pr.url}) — returned to the queue rather than completed`);
            }
            continue;
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
          if (this.durableRuns.recoverPublishedRun(
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
      const recovery = await inspectWorktreeRecovery(run.projectPath, run.issueId, run.worktreePath, this.durableRuns.deadMarkerOwners(run.issueId))
        .catch((error) => {
          console.warn(`[Reconciler] Worktree evidence unreadable for ${run.identifier ?? run.issueId}:`, error);
          return null;
        });
      if (!recovery || recovery.state === 'active_owner' || recovery.state === 'ambiguous') {
        console.warn(`[Reconciler] Keeping ${run.identifier ?? run.issueId} in NEEDS_RECONCILE (${recovery?.state ?? 'inspection_failed'})`);
        continue;
      }
      if (this.durableRuns.markReady(run.issueId)) {
        console.log(`[Reconciler] ${recovery.state === 'missing' ? 'Reopening branch' : 'Resuming worktree'} for ${run.identifier ?? run.issueId}`);
      }
    }
    await this.drainDurableOutbox();
  }

  protected async migrateLegacyRunState(tasks: TaskItem[]): Promise<void> {
    if (!this.durableRuns.isPrimary || this.stopping) return;
    let imported = 0;
    for (const task of tasks) {
      if (this.stopping) return;
      const issueId = task.issueId || task.id;
      if (this.durableRuns.getRun(issueId)) continue;

      const canonical = getTaskState(issueId);
      const failedCount = this.failedTaskCounts.get(issueId) ?? 0;
      const retryAt = this.failedTaskRetryTimes.get(issueId);
      const legacyCompleted = this.completedTaskIds.has(issueId);
      const canonicalStatus = canonical?.execution.status;
      const hasLegacySignal = legacyCompleted
        || failedCount > 0
        || retryAt != null
        || ['in_progress', 'in_review', 'failed', 'halted', 'done', 'decomposed'].includes(canonicalStatus ?? '');
      if (!hasLegacySignal) continue;

      const projectPath = task.projectPath ?? await this.resolveProjectPath(task);
      if (!projectPath || this.stopping) continue;

      let state: ImportRunInput['state'];
      let reason: string;
      if (
        task.labels?.includes(STUCK_LABEL)
        || failedCount >= AutonomousRunnerCore.MAX_RETRY_COUNT
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

      const result = this.durableRuns.importLegacyRun({
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
    if (imported > 0) this.syslog(`✓ Imported ${imported} legacy run state(s) into automation.db`);
  }

  protected async deliverOutboxEffect(effect: EffectClaim): Promise<void> {
    return deliverTrackerEffect(effect, getTaskSource());
  }

  protected async drainDurableOutbox(): Promise<void> {
    const threadOutcome = await drainCoordinationThreadOutbox();
    if (threadOutcome.warnings.length > 0) {
      console.warn(
        `[ThreadOutbox] delivered=${threadOutcome.delivered} pending=${threadOutcome.pending} `
        + `warnings=${threadOutcome.warnings.length}`,
      );
    }
    if (!this.durableRuns.isPrimary) return;
    if (this.outboxDrain) return this.outboxDrain;
    const finalized = new Set<string>();
    this.outboxDrain = (async () => {
      const outcome = await this.durableRuns.drainOutbox(async (effect) => {
        await this.deliverOutboxEffect(effect);
        finalized.add(effect.issueId);
      });
      for (const issueId of finalized) {
        if (this.durableRuns.getRun(issueId)?.state !== 'DONE') continue;
        this.completedTaskIds.add(issueId);
        clearRejection(issueId);
        clearRetryTime(issueId, this.failedTaskRetryTimes);
        this.consecutiveInfraErrorCounts.delete(issueId);
        this.lastFailureDetails.delete(issueId);
      }
      if (finalized.size > 0) this.saveTaskState();
      if (outcome.retried > 0 || outcome.dead > 0) {
        console.warn(`[Outbox] applied=${outcome.applied} retried=${outcome.retried} dead=${outcome.dead}`);
      }
    })().finally(() => { this.outboxDrain = null; });
    return this.outboxDrain;
  }


  protected async executeTaskPairMode(task: TaskItem): Promise<void> {
    if (this.stopping) return;
    // Serial path (maxConcurrentTasks=1) bypasses enqueueCandidate — attach the
    // prior-session feedback here too so both paths inject it (INT-2474).
    this.attachPriorFeedback(task);

    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);
    if (this.stopping) return;

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      // Record so this issue isn't re-picked every heartbeat (it would starve
      // runnable tasks behind it). Cleared on restart. (INT-1875)
      this.unresolvableIssueIds.add(task.issueId || task.id);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      // Move on to the next actionable task instead of ending the heartbeat here.
      this.scheduleNextHeartbeat();
      return;
    }

    // Skip if project is not in enabled list (allow-list; empty = nothing runs)
    if (this.shouldFilterByEnabled() && !this.isProjectEnabled(projectPath)) {
      console.log(`[AutonomousRunner] Project not enabled, skipping: ${projectPath}`);
      return;
    }

    // Cache linearProjectName → resolvedPath for dashboard
    if (task.linearProject?.name) {
      this.projectPathCache.set(task.linearProject.name, projectPath);
    }

    console.log(`[AutonomousRunner] projectPath: ${projectPath}`);

    // Use scheduler for parallel processing mode
    if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1) {
      if (this.scheduler.enqueue(task, projectPath)) {
        broadcastEvent({ type: 'task:queued', data: { taskId: taskEventKey(task), title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      }
      await this.runAvailableTasks();
      return;
    }

    // Single execution (legacy serial path — maxConcurrentTasks <= 1).
    // The scheduler emits task:started/completed for the parallel path; this
    // path never did, so dashboards saw no lifecycle and (since INT-3402) the
    // transcript buffer was never handed to its retention timer.
    broadcastEvent({
      type: 'task:started',
      data: { taskId: taskEventKey(task), title: task.title, issueIdentifier: task.issueIdentifier },
    });
    let result: PipelineResult;
    try {
      result = await this.executeDurably(task, projectPath);
    } catch (err) {
      broadcastEvent({
        type: 'task:completed',
        data: { taskId: taskEventKey(task), success: false, duration: 0 },
      });
      throw err;
    }
    broadcastEvent({
      type: 'task:completed',
      data: { taskId: taskEventKey(task), success: result.success, duration: result.totalDuration },
    });

    // Rate-limited: pause until quota resets. Return before any Discord/Linear
    // reporting or state change — no failure count, no card spam. Same as the
    // scheduler 'failed' handler's rate_limited branch. (INT-1906)
    if (result.finalStatus === 'rate_limited') {
      const resetsAt = result.rateLimitResetsAt ?? Date.now() + 60_000;
      this.rateLimitUntil = resetsAt;
      const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
      const resetsLabel = new Date(resetsAt).toISOString();
      console.warn(`[AutonomousRunner] Rate limit hit for ${this.formatTaskContext(task)} — pausing until ${resetsLabel} (~${waitSec}s)`);
      broadcastEvent({ type: 'log', data: { taskId: taskEventKey(task), stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` } });
      return;
    }

    await reportToDiscord(formatPipelineResultEmbed(result));

    if (result.success && task.issueId && this.durableRuns.isPrimary) {
      await this.drainDurableOutbox().catch((error) =>
        console.error('[Outbox] Serial completion delivery pass failed:', error));
      if (this.durableRuns.getRun(task.issueId)?.state !== 'DONE') {
        console.warn(`[AutonomousRunner] ${task.issueId} remains sync-pending; completion will reconcile later`);
      }
      return;
    }

    // Update Linear issue state
    if (task.issueId) {
      try {
        if (result.success) {
          // On success, move to Done
          await execution.syncSuccessState(task);
          await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, completionStats(result));
          await execution.reconcileCompletionState(task);
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Done`);

          if (result.taskContext?.projectPath) {
            await recordTaskOutcome(result.taskContext.projectPath, {
              taskTitle: task.title,
              derivedFrom: task.issueIdentifier ?? task.issueId,
              workerResult: result.workerResult,
              iterations: result.iterations,
            });
          }
        } else if (result.finalStatus === 'rejected') {
          // Change to Blocked on review rejection
          await execution.syncFailureState(
            task,
            `Review rejected: ${result.reviewResult?.feedback || t('common.fallback.noDescription')}`,
            'Todo',
          );
          await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
            t('runner.reviewRejected', { feedback: result.reviewResult?.feedback || t('common.fallback.noDescription') })
          );
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Todo (blocked) (rejected)`);
        }
        // If failed, keep In Progress (retry on next heartbeat)
      } catch (err) {
        console.error(`[AutonomousRunner] Failed to update issue state:`, err);
      }
    }
  }

  protected getExecCtx(durability?: ExecutionDurabilityHooks): execution.ExecutionContext {
    return {
      allowedProjects: this.config.allowedProjects,
      plannerModel: this.config.plannerModel,
      plannerTimeoutMs: this.config.plannerTimeoutMs,
      pairMaxAttempts: this.config.pairMaxAttempts,
      enableDecomposition: this.config.enableDecomposition,
      decompositionThresholdMinutes: this.config.decompositionThresholdMinutes,
      decompositionMaxDepth: this.config.decomposition?.maxDepth ?? 2,
      decompositionMaxChildren: this.config.decomposition?.maxChildrenPerTask ?? 5,
      decompositionDailyLimit: this.config.decomposition?.dailyLimit ?? 20,
      decompositionAutoBacklog: this.config.decomposition?.autoBacklog ?? true,
      jobProfiles: this.config.jobProfiles,
      getRolesForProject: (p) => this.getRolesForProject(p),
      reportToDiscord,
      worktreeMode: this.config.worktreeMode ?? false,
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      guards: this.config.guards,
      verify: this.config.verify,
      securityAudit: this.config.securityAudit,
      maxReflections: this.config.maxReflections,
      durability,
      peerIssues: this.lastFetchedTasks,
      getActiveWorkerIssues: (p) => this.durableRuns.activeWorkerIdentifiers(p),
      mcpPolicies: this.config.mcpPolicies,
      adapterRouting: this.config.adapterRouting,
    };
  }

  protected async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  protected async executePipeline(
    task: TaskItem,
    projectPath: string,
    signal?: AbortSignal,
    durability?: ExecutionDurabilityHooks,
  ): Promise<PipelineResult> {
    return execution.executePipeline(this.getExecCtx(durability), task, projectPath, signal);
  }

}
