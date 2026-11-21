// Created: 2026-11-22
// Purpose: the heartbeat's already-processed filter and the operator-answer readmission it relies on,
//          moved out of autonomousRunner.ts as host-taking functions (AGT-4867 slice A)
// Dependencies: durableRunCoordinator (ledger reads/lifts), runnerState (legacy backoff/rejection),
//               operatorAnswers (early readmission rule), execHold, dispatchFingerprint, runnerParking
// Test Status: autonomousRunner.operatorPark/operatorQuestionPark/execHold/dispatchFingerprint/infraError/durable tests,
//              runnerTaskFilter.test.ts (host contract)

import { classifyStuck, type TaskItem } from '../orchestration/decisionEngine.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import { getCoordinationStore } from '../coordination/coordinationStore.js';
import {
  OPERATOR_PARK_REASON,
  OPERATOR_QUESTION_PARK_REASON,
  shouldReadmitEarly,
} from '../coordination/operatorAnswers.js';
import { citedPathsAreEphemeral } from '../support/worktreeEphemeral.js';
import { canRetryNow, clearRejection, clearRetryTime, isRejectionLimitReached } from './runnerState.js';
import { getTaskSource } from './runnerExecution.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { INFRA_CIRCUIT_PARK_REASON } from './infraFailureCircuit.js';
import { listHeldIssueIds } from './execHold.js';
import { inputFingerprint, mayRedispatch } from './dispatchFingerprint.js';
import { VERIFIED_WORKER_BLOCKER_PARK_REASON } from '../agents/pairPipelineTypes.js';
import { OPERATOR_QUESTION_PARK_MARKER } from './explicitDispatchReadmission.js';
import { getTaskState } from '../taskState/store.js';
import { setOperatorPark, setSandboxOutcomePark } from './runnerParking.js';
import { RECOVERY_ADVISOR_PARK_REASON } from './loopRecoveryTypes.js';
import { STUCK_LABEL } from '../linear/index.js';
import { RETRY_RAMP_FROM_ATTEMPT, type DurableRunCoordinator } from './durableRunCoordinator.js';

/**
 * What the filter needs from the runner. The runner builds it so every member is
 * read at call time: state through getters, and every method through the runner
 * itself, so a test (or a later reassignment) of a runner member is honoured
 * exactly as when this code lived on the class. Calls between the functions in
 * this module also go through the host for the same reason.
 */
export interface TaskFilterHost {
  readonly scheduler: Pick<TaskScheduler, 'hasAvailableSlot' | 'getAvailableSlots'>;
  readonly durableRuns: Pick<
    DurableRunCoordinator,
    | 'isPrimary' | 'getRun' | 'markReady' | 'idleFillWouldRepeatVerdict' | 'readmitParkedRun'
    | 'resumeNeedsHuman' | 'resumeNeedsHumanForQuestions'
  >;
  readonly completedTaskIds: Set<string>;
  readonly failedTaskCounts: Map<string, number>;
  readonly failedTaskRetryTimes: Map<string, number>;
  readonly consecutiveInfraErrorCounts: Map<string, number>;
  readonly unresolvableIssueIds: Set<string>;
  /** AutonomousRunner.MAX_RETRY_COUNT — still used by the runner's failure handling. */
  readonly maxRetryCount: number;
  answerArrivedFor(issueId: string): boolean;
  readmitAnsweredRun(issueId: string): boolean;
  resumeAnsweredQuestionPark(issueId: string): boolean;
  parkedOnOperator(issueId: string): boolean;
  scheduleNextHeartbeat(): void;
  saveTaskState(): void;
  syslog(line: string): void;
}

// Consecutive infra_error attempts (same issue, no intervening non-infra
// outcome) allowed to bypass backoff via idle-fill before the real 1h
// backoff is enforced instead. (AGT-4305)
const MAX_CONSECUTIVE_INFRA_IDLE_FILL = 3;

/**
 * Bring a durably backed-off run forward because its answer landed.
 *
 * Both halves are required: the ledger refuses to claim a `RETRY_AT` row whose
 * time has not come, so letting the task past the heartbeat filter without
 * promoting it would select it and then fail to claim it, every cycle.
 *
 * The promotion re-checks the park itself, so what `answerArrivedFor` reads is
 * only a filter — a second daemon can end the parked attempt in between, and
 * the failure that replaces it must keep its own backoff.
 */
export function readmitAnsweredRun(host: TaskFilterHost, issueId: string): boolean {
  if (!host.answerArrivedFor(issueId)) return false;
  if (!host.durableRuns.readmitParkedRun(issueId, OPERATOR_PARK_REASON)) return false;
  clearRetryTime(issueId, host.failedTaskRetryTimes);
  host.consecutiveInfraErrorCounts.delete(issueId);
  return true;
}

/**
 * Whether a task parked on the operator now has its answer.
 *
 * Scoped by task id — the Linear issue id, unique per task — so an answer meant
 * for one agent can never spring another that happens to share a display name
 * (the guard added in AGT-4030 is upheld, not bypassed).
 *
 * The park is read off the run's own ledger row rather than a flag kept beside
 * it, so it expires with the attempt that caused it: a task that waited out its
 * backoff and then failed for its own reasons carries that failure's code here,
 * and an answer from a park it has left cannot pull it forward.
 */
/**
 * Whether the task is stopped waiting on the operator, read from whichever
 * store is authoritative for it — the same split the selection filter makes.
 *
 * With the ledger in charge the park is the run's own error code, so it expires
 * with the attempt that caused it. Elsewhere no such code is written (`shadow`
 * noops its transitions, `off` has no ledger at all), so a task-state signal
 * stands in — retired by the filter when the task is admitted, to give it the
 * same lifetime rather than one nobody maintains.
 */
export function parkedOnOperator(host: TaskFilterHost, issueId: string): boolean {
  const durableRun = host.durableRuns.getRun(issueId);
  if (host.durableRuns.isPrimary && durableRun) {
    return durableRun.lastErrorCode === OPERATOR_PARK_REASON;
  }
  return getTaskState(issueId)?.execution?.blockedReason === OPERATOR_PARK_REASON;
}

/**
 * Resume a NEEDS_HUMAN ask_human park whose exact-correlation questions are all answered.
 *
 * The board read comes first and is only a filter — the ledger's contract re-reads the trace and
 * decides — so a heartbeat over many parked runs does not open a write transaction for each.
 */
export function resumeAnsweredQuestionPark(host: TaskFilterHost, issueId: string): boolean {
  try {
    if (!getCoordinationStore().allQuestionsAnswered(issueId)) return false;
    const resumed = host.durableRuns.resumeNeedsHumanForQuestions(issueId);
    if (!resumed) return false;
    if (resumed === 'SYNC_PENDING') host.scheduleNextHeartbeat();
    return true;
  } catch { // cxt-ignore: error_swallow — an unreadable board must not stall the heartbeat
    return false;
  }
}

export function answerArrivedFor(host: TaskFilterHost, issueId: string): boolean {
  try {
    return shouldReadmitEarly({
      parkedOnOperator: host.parkedOnOperator(issueId),
      allQuestionsAnswered: getCoordinationStore().allQuestionsAnswered(issueId),
    });
  } catch { // cxt-ignore: error_swallow — an unreadable board must not stall the heartbeat
    return false;
  }
}

export function filterAlreadyProcessed(host: TaskFilterHost, tasks: TaskItem[]): TaskItem[] {
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
  let idleFillBudget = host.scheduler.hasAvailableSlot() ? host.scheduler.getAvailableSlots() : 0;
  // `exec --issue` hands a run to an external orchestrator (Claude Code, omp,
  // a script) that waits on `exec await` for the elevation. idle_fill would
  // otherwise lift the park it is waiting on and re-run the task (AGT-4257's
  // own loop, reached again through AGT-4155/AGT-4306). Read once per pass,
  // like the budget above, so the gate costs one query per heartbeat.
  const heldExecRuns = listHeldIssueIds();
  const filtered = tasks.filter(task => {
    const id = task.issueId || task.id;
    const isStuck = task.labels?.includes(STUCK_LABEL) ?? false;
    // Held by an external orchestrator: every idle_fill branch below is
    // skipped, so a park reaches the `exec await` that is watching for it.
    const execHeld = heldExecRuns.has(id);
    let durableRun = host.durableRuns.getRun(id);
    // A park or backoff that nobody has touched is not lifted by a free slot:
    // retrying an unchanged issue after an infra_error or an operator park
    // changes nothing (AGT-4787 — 18 dispatches of one issue in 14 hours). The
    // input is title + description; tracker comments are not on a listed task,
    // so an answer given only as a comment waits for an explicit dispatch.
    const issueInput = inputFingerprint({ title: task.title, description: task.description });
    const inputUnchanged = !!durableRun && !mayRedispatch(id, issueInput);
    // Set once this task has spent idle budget, so a later branch in this
    // same pass (the stuck-label recovery) neither charges it twice nor
    // skips a row whose park idle_fill has already erased.
    let idleLifted = false;

    if (
      host.durableRuns.isPrimary
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
      const idleReopen = !operatorReopened && !execHeld && task.linearState === 'Backlog' && idleFillBudget > 0;
      if ((operatorReopened || idleReopen) && host.durableRuns.markReady(id)) {
        if (idleReopen) {
          idleFillBudget--;
          idleLifted = true;
        }
        durableRun = host.durableRuns.getRun(id);
      }
    }

    if (host.durableRuns.isPrimary && durableRun?.state === 'NEEDS_HUMAN') {
      const isOperatorQuestionPark = durableRun.lastErrorCode === OPERATOR_QUESTION_PARK_REASON
        || durableRun.lastErrorCode === RECOVERY_ADVISOR_PARK_REASON
        || durableRun.lastErrorCode === SANDBOX_OUTCOME_UNKNOWN_PARK_REASON
        || (durableRun.lastErrorMessage?.startsWith(OPERATOR_QUESTION_PARK_MARKER) ?? false);
      // AGT-4256: a guard/publication park that only named ephemeral paths
      // (.test_venv, pytest-local) is not a human decision. Resume even when
      // Linear is still In Progress so the next heartbeat can pick the work.
      // Checked before idle_fill so a false park never spends idle budget.
      if (!execHeld && !isOperatorQuestionPark && citedPathsAreEphemeral(durableRun.lastErrorMessage ?? '')) {
        const resumed = host.durableRuns.resumeNeedsHuman(id, Date.now(), 'unspecified');
        if (resumed) {
          console.log(`[Scheduler] ${task.issueIdentifier ?? id} resumed from NEEDS_HUMAN (ephemeral-only guard park)`);
          durableRun = host.durableRuns.getRun(id);
          if (resumed === 'SYNC_PENDING') host.scheduleNextHeartbeat();
        }
      }
      // An answered ask_human question resumes on its own contract, not on a free slot. The
      // ledger refuses every other trigger for this park (`resumeNeedsHuman`), and nothing in the
      // daemon called the contract (`exec answer` aside), so the idle_fill below was what
      // delivered an operator's answer — by accident, since it lifts an unanswered park too. Once
      // idle_fill stands down for an issue nobody edited (AGT-4787), an answer would otherwise
      // wait for an edit nobody needs to make.
      if (!execHeld && durableRun?.lastErrorCode === OPERATOR_QUESTION_PARK_REASON
          && host.resumeAnsweredQuestionPark(id)) {
        console.log(`[Scheduler] ${task.issueIdentifier ?? id} resumed from NEEDS_HUMAN (the operator answered)`);
        answered++;
        durableRun = host.durableRuns.getRun(id) ?? durableRun;
      }
      // The same-fingerprint infra circuit parks a run so that an operator
      // changes something before it runs again; a free slot changes nothing.
      // Resuming it by idle fill re-runs a known-broken environment every
      // heartbeat (AGT-4306). Only an explicit dispatch (board/work API)
      // lifts that park — the resume paths that carry an operator's hand.
      const isInfraCircuitPark = durableRun?.lastErrorCode === INFRA_CIRCUIT_PARK_REASON
        // A blocker the reviewer confirmed is a claim about the task text; a
        // free slot re-runs the same text into the same confirmed claim
        // (AGT-4535). Only an explicit dispatch lifts it; Todo alone does not.
        || durableRun?.lastErrorCode === VERIFIED_WORKER_BLOCKER_PARK_REASON
        || durableRun?.lastErrorCode === RECOVERY_ADVISOR_PARK_REASON
        || durableRun?.lastErrorCode === SANDBOX_OUTCOME_UNKNOWN_PARK_REASON;
      // Nor does a free slot change a verdict that has already come back
      // twice; see idleFillWouldRepeatVerdict.
      if (durableRun?.state === 'NEEDS_HUMAN' && idleFillBudget > 0 && !isInfraCircuitPark && !execHeld && !inputUnchanged
          && !host.durableRuns.idleFillWouldRepeatVerdict(id)) {
        const idleResumed = host.durableRuns.resumeNeedsHuman(id, Date.now(), 'idle_fill');
        if (idleResumed) {
          idleFillBudget--;
          idleLifted = true;
          console.log(`[Scheduler] ${task.issueIdentifier ?? id} resumed from NEEDS_HUMAN (idle_fill, ${idleFillBudget} free slot(s) left)`);
          const lifted = host.durableRuns.getRun(id);
          if (lifted) durableRun = lifted;
          if (idleResumed === 'SYNC_PENDING') host.scheduleNextHeartbeat();
        }
      }
      // The park survives this pass — say why, once, so the daemon log and the
      // `exec await` the orchestrator is holding agree on what is happening.
      if (execHeld && durableRun?.state === 'NEEDS_HUMAN') {
        console.log(`[Scheduler] ${task.issueIdentifier ?? id} held by exec elevation — awaiting the external orchestrator`);
      }
    }

    if (host.durableRuns.isPrimary && durableRun) {
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
        ? host.consecutiveInfraErrorCounts.get(id) ?? 0
        : 0;
      // A supersession backoff is not a slot going to waste: the run was
      // refused because an open PR still owns its files, and that PR does not
      // close because a slot is free. Lifting it re-runs the drafter against
      // the same PR every heartbeat — AX-1481 reached attempt #415 that way,
      // 25 s apart, on 2026-09-17 (AGT-4036). The exponential supersession
      // backoff (retryAtFor) is the recheck cadence; idle fill leaves it alone.
      const idleLiftable = (
        durableRun.state === 'RETRY_AT'
        && (durableRun.retryAt ?? 0) > Date.now()
        && infraStreak < MAX_CONSECUTIVE_INFRA_IDLE_FILL
        && durableRun.lastErrorCode !== 'superseded'
        // A run held by an external orchestrator is re-dispatched by `exec
        // answer`, not by a free slot: lifting its backoff here would start a
        // second attempt while the orchestrator still owns the decision.
        && !execHeld
        && !inputUnchanged
        // A run that has failed three times is backed off on purpose (AGT-4673).
        // Lifting it here whenever a slot frees put the highest-priority failing
        // run ahead of 36 READY tasks, so the backoff never held (AGT-4675).
        && durableRun.attemptNo < RETRY_RAMP_FROM_ATTEMPT
        && !host.durableRuns.idleFillWouldRepeatVerdict(id)
      )
        || durableRun.state === 'NEEDS_SPEC'
        || durableRun.state === 'NEEDS_ENV';
      if (idleLiftable && idleFillBudget > 0 && host.durableRuns.markReady(id)) {
        idleFillBudget--;
        idleLifted = true;
        const lifted = host.durableRuns.getRun(id);
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
        if (!host.readmitAnsweredRun(id)) {
          backoffSkipped++;
          return false;
        }
        durableRun = host.durableRuns.getRun(id);
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
    if (host.unresolvableIssueIds.has(id)) {
      unresolvable++;
      return false;
    }

    const legacyIsAuthority = !host.durableRuns.isPrimary || !durableRun;

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
      && (host.completedTaskIds.has(id) || (host.failedTaskCounts.get(id) ?? 0) >= host.maxRetryCount);
    const stuckDecision = classifyStuck({ isStuck, linearState: task.linearState, hasFailureHistory });
    if (stuckDecision === 'recover') {
      host.completedTaskIds.delete(id);
      host.failedTaskCounts.delete(id);
      clearRejection(id); // Clear rejection count on recovery
      clearRetryTime(id, host.failedTaskRetryTimes); // Clear retry backoff time
      host.consecutiveInfraErrorCounts.delete(id);
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
      host.completedTaskIds.delete(id);
      host.failedTaskCounts.delete(id);
      clearRejection(id);
      clearRetryTime(id, host.failedTaskRetryTimes);
      host.consecutiveInfraErrorCounts.delete(id);
      if (isStuck) toUnstick.push(id);
      recovered++;
      return true;
    }

    // AGT-4257 (ledger-off): a locally completed or retry-exhausted issue whose
    // card sits in a parked state is idle fill, on the same budget as the
    // ledger lifts. (An active card — Todo / In Progress / In Review — never
    // reaches here: classifyStuck already returned 'recover' for it above.)
    if (legacyIsAuthority
        && (host.completedTaskIds.has(id) || (host.failedTaskCounts.get(id) ?? 0) >= host.maxRetryCount)) {
      if (idleFillBudget <= 0) return false;
      idleFillBudget--;
      host.completedTaskIds.delete(id);
      host.failedTaskCounts.delete(id);
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
      if (host.durableRuns.isPrimary) {
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
      if (!canRetryNow(id, host.failedTaskRetryTimes)) {
        const infraStreak = host.consecutiveInfraErrorCounts.get(id) ?? 0;
        if (host.answerArrivedFor(id)) {
          clearRetryTime(id, host.failedTaskRetryTimes);
          host.consecutiveInfraErrorCounts.delete(id);
          answered++;
        } else if (idleFillBudget > 0 && infraStreak < MAX_CONSECUTIVE_INFRA_IDLE_FILL) {
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
          clearRetryTime(id, host.failedTaskRetryTimes);
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
    host.syslog(`🛑 Skipped ${stuckSkipped} stuck issue(s) (retries exhausted — move to Todo to retry)`);
  }
  if (recovered > 0) {
    host.saveTaskState();
    host.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
  }
  if (backoffSkipped > 0) {
    host.syslog(`⏰ Skipped ${backoffSkipped} tasks in exponential backoff period`);
  }
  if (answered > 0) {
    host.syslog(`🙋 Re-admitted ${answered} task(s) early — the operator answered`);
  }
  if (noProject > 0) {
    host.syslog(`— Skipped ${noProject} issue(s) with no Linear project (assign a project in Linear to enable)`);
  }
  if (unresolvable > 0) {
    host.syslog(`— Skipped ${unresolvable} issue(s) whose Linear project maps to no local repo (fix the project or add the repo)`);
  }
  return filtered;
}
