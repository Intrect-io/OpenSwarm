import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { RunRecord, RunState } from './runLedger.js';
import { INFRA_CIRCUIT_PARK_REASON, infraFailureFingerprint } from './infraFailureCircuit.js';
import { pickPipelineFailureDetail } from './runnerState.js';
import {
  normalizeOperatorQuestionCorrelations,
  OPERATOR_QUESTION_PARK_REASON,
} from '../coordination/operatorAnswers.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { DurableRunCoordinatorBase } from './durableRunCoordinatorBase.js';
import {
  fencedResult,
  nonExecutingResult,
  ownerProcessId,
  retryAtFor,
  type DurableExecuteOptions,
  type ExecutionDurabilityHooks,
  type OutboxDeliverer,
  type OutboxDrainResult,
} from './durableRunCoordinatorHelpers.js';

export type {
  DurableRunCoordinatorConfig,
  DurableExecuteOptions,
  ExecutionDurabilityHooks,
  OutboxDeliverer,
  OutboxDrainResult,
  RepositoryAdmissionPolicy,
} from './durableRunCoordinatorHelpers.js';
export { formatFenceWait, retryAtFor, runRecordToTask } from './durableRunCoordinatorHelpers.js';

export class DurableRunCoordinator extends DurableRunCoordinatorBase {
  async execute(
    task: TaskItem,
    projectPath: string,
    executor: (hooks: ExecutionDurabilityHooks, leaseSignal: AbortSignal) => Promise<PipelineResult>,
    options: DurableExecuteOptions = {},
  ): Promise<PipelineResult> {
    if (this.closed) throw new Error('DurableRunCoordinator is closed');
    if (!this.ledger) return executor(this.noopHooks(), new AbortController().signal);

    const issueId = task.issueId || task.id;
    this.observeTask(task, projectPath);
    // Shadow is projection-only: it may populate discovery records for rollout
    // comparison, but must never claim, fence, enqueue effects, or alter tracker
    // delivery. Otherwise the observer itself becomes a second control plane.
    if (this.mode === 'shadow') return executor(this.noopHooks(), new AbortController().signal);

    let claim = this.ledger.claimRun(issueId, {
      ownerInstanceId: this.instanceId,
      leaseMs: this.leaseMs,
      maxActiveForProject: options.admission?.maxConcurrent ?? this.maxActiveForProject,
      conflictScope: options.admission?.conflictScope,
      unknownScopeAdmission: options.admission?.unknownScopeAdmission,
      maxAttemptsPerHour: options.admission?.maxAttemptsPerHour,
      maxFailuresPerHour: options.admission?.maxFailuresPerHour,
      maxCostUsdPerDay: options.admission?.maxCostUsdPerDay,
      circuitCooldownMs: options.admission?.circuitCooldownMs,
    });
    if (!claim) {
      if (this.isPrimary) {
        const now = Date.now();
        const existing = this.ledger.getRun(issueId);
        // A future RETRY_AT can carry a more specific contract (for example an
        // operator wait). Preserve both its reason and its deadline instead of
        // rewriting it as a generic 30-second admission conflict.
        if (existing?.state === 'RETRY_AT' && existing.retryAt != null && existing.retryAt > now) {
          return nonExecutingResult(task, projectPath, 'durable retry deadline has not arrived', {
            status: 'deferred',
            retryAt: existing.retryAt,
          });
        }
        const circuitOpenUntil = this.ledger.getCircuitOpenUntil(issueId, now);
        const retryAt = Math.max(now + 30_000, circuitOpenUntil ?? 0);
        const didDefer = this.ledger.deferUnclaimedRun(
          issueId,
          retryAt,
          'Durable claim unavailable (repository admission, circuit, budget, or concurrent owner)',
          now,
        );
        const parked = this.ledger.getRun(issueId);
        // A repository slot/budget/circuit refusal parks this task in RETRY_AT:
        // it still owns queued work and must be retried. An already-running copy
        // of this same issue or NEEDS_RECONCILE instead means this invocation is
        // genuinely superseded and must not create a duplicate scheduler entry.
        if (didDefer && parked?.state === 'RETRY_AT') {
          return nonExecutingResult(task, projectPath, 'durable claim unavailable', {
            status: 'deferred',
            retryAt: parked.retryAt ?? retryAt,
          });
        }
        return nonExecutingResult(task, projectPath, 'durable claim unavailable', { status: 'superseded' });
      }
      return executor(this.noopHooks(), new AbortController().signal);
    }

    if (!this.ledger.transition(claim, 'EXECUTING')) {
      if (this.isPrimary) {
        return nonExecutingResult(task, projectPath, 'claim fence rejected', { status: 'superseded' });
      }
      return executor(this.noopHooks(), new AbortController().signal);
    }

    let leaseLost = false;
    const leaseAbortController = new AbortController();
    const loseLease = (): void => {
      leaseLost = true;
      leaseAbortController.abort();
    };
    const renewEveryMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const renewTimer = setInterval(() => {
      const renewed = this.ledger!.renewLease(claim!, this.leaseMs);
      if (renewed) claim = renewed;
      else loseLease();
    }, renewEveryMs);
    renewTimer.unref?.();

    const transitionIfCurrent = async (to: RunState): Promise<boolean> => {
      if (leaseLost) return false;
      const current = this.ledger!.getRun(issueId);
      if (!current) return false;
      if (current.state === to) {
        const stillCurrent = this.ledger!.isClaimCurrent(claim!);
        if (!stillCurrent) loseLease();
        return stillCurrent;
      }
      const transitioned = this.ledger!.transition(claim!, to);
      if (!transitioned) loseLease();
      return transitioned;
    };

    const hooks: ExecutionDurabilityHooks = {
      onWorktree: async (info) => {
        if (leaseLost) return false;
        const attached = this.ledger!.attachWorktree(claim!, info.worktreePath, info.branchName);
        if (!attached) loseLease();
        return attached;
      },
      onStage: async (stage) => {
        if (stage === 'reviewer' || stage === 'tester' || stage === 'auditor') {
          return transitionIfCurrent('VERIFYING');
        }
        if (leaseLost) return false;
        const stillCurrent = this.ledger!.isClaimCurrent(claim!);
        if (!stillCurrent) loseLease();
        return stillCurrent;
      },
      beforePublish: async () => transitionIfCurrent('PUBLISHING'),
      onPublication: async (prUrl, headSha) => {
        if (leaseLost) return false;
        const attached = this.ledger!.attachPublication(claim!, { prUrl, headSha });
        if (!attached) loseLease();
        return attached;
      },
    };

    let result: PipelineResult;
    try {
      result = await executor(hooks, leaseAbortController.signal);
    } catch (error) {
      clearInterval(renewTimer);
      this.ledger.recordAttemptResult(claim, {
        success: false,
        finalStatus: 'infra_error',
        result: { thrown: true },
        maxFailuresPerHour: options.admission?.maxFailuresPerHour,
        circuitCooldownMs: options.admission?.circuitCooldownMs,
      });
      this.ledger.transition(claim, 'RETRY_AT', {
        retryAt: Date.now() + 15 * 60_000,
        errorCode: 'executor_throw',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearInterval(renewTimer);
      try {
        if (!this.ledger.isClaimCurrent(claim)) loseLease();
      } catch {
        // An unreadable ledger cannot prove ownership. Fence locally and retry
        // the executor-exit acknowledgement from the reconciliation loop.
        loseLease();
      }
      if (leaseLost) this.confirmExitedClaim(claim);
    }

    if (leaseLost) return fencedResult(result);
    // A deterministic park is normally terminal. A repository-authored DoD
    // contract may, however, make two narrow outcomes coordinator-owned:
    // explicitly accepted no-change work can complete through the normal
    // outbox, and an ephemeral-only publication fence may receive one bounded
    // retry. Resolve before recording the attempt so the durable row records
    // the outcome that actually governs the next state.
    if (result.operatorPark && options.resolveOperatorPark) {
      const resolution = options.resolveOperatorPark(task, result, claim.attemptNo);
      if (resolution?.action === 'complete') {
        result = {
          ...result,
          success: true,
          finalStatus: 'approved',
          operatorPark: undefined,
          coordinatorResolution: { action: 'complete', reason: resolution.reason },
        };
      } else if (resolution?.action === 'retry') {
        result = {
          ...result,
          success: false,
          finalStatus: 'deferred',
          retryAt: resolution.retryAt,
          operatorPark: undefined,
          coordinatorResolution: { action: 'retry', reason: resolution.reason },
          failureDetail: `coordinator: ${resolution.reason}`,
        };
      }
    }

    // GitHub publication is an external side effect. If it succeeded but the
    // pipeline could not durably attach/finalize it, execution must stop here:
    // a normal RETRY_AT would allow another worker to mutate the published
    // branch or attempt a duplicate PR before artifact truth is reconciled.
    const publishedNeedsReconcile = Boolean(result.prUrl)
      && !(result.success && result.finalStatus === 'approved');
    if (!this.ledger.recordAttemptResult(claim, {
      success: result.success,
      // This is coordination debt, not a repository implementation failure.
      // Keep it out of the failure circuit while NEEDS_RECONCILE blocks claims.
      finalStatus: publishedNeedsReconcile ? 'publication_reconcile' : result.finalStatus,
      repositoryInfra: result.repositoryInfra,
      costUsd: result.totalCost?.costUsd,
      result: {
        sessionId: result.sessionId,
        totalDuration: result.totalDuration,
        iterations: result.iterations,
        prUrl: result.prUrl,
      },
      maxFailuresPerHour: options.admission?.maxFailuresPerHour,
      circuitCooldownMs: options.admission?.circuitCooldownMs,
    })) {
      return fencedResult(result);
    }
    const now = Date.now();

    if (publishedNeedsReconcile) {
      const reason = 'Published PR requires artifact reconciliation before tracker completion';
      return this.ledger.transition(claim, 'NEEDS_RECONCILE', {
        prUrl: result.prUrl,
        errorCode: 'publication_reconcile',
        errorMessage: reason,
        eventData: {
          sessionId: result.sessionId,
          finalStatus: result.finalStatus,
          prUrl: result.prUrl,
        },
      }, now) ? result : fencedResult(result);
    }

    if (result.finalStatus === 'decomposed') {
      return this.ledger.transition(claim, 'DECOMPOSED', {
        eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus },
      }, now) ? result : fencedResult(result);
    }

    if (result.finalStatus === 'cancelled') {
      if (options.retryCancellation?.(result, claim)) {
        return this.ledger.transition(claim, 'RETRY_AT', {
          retryAt: now + 60_000,
          errorCode: 'shutdown_cancelled',
          eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus, resumable: true },
        }, now) ? result : fencedResult(result);
      }
      const effect = options.cancelEffect?.(result, claim);
      if (effect) {
        return this.ledger.commitRunForSync(claim, effect, {
          eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus },
        }, now) ? result : fencedResult(result);
      }
      return this.ledger.transition(claim, 'CANCELLED', {
        errorCode: result.finalStatus,
        eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus },
      }, now) ? result : fencedResult(result);
    }

    if (result.finalStatus === 'superseded') {
      // Back off on how many times in a row a sibling has claimed the files,
      // not on how many attempts of any kind the run has behind it.
      return this.ledger.transition(claim, 'RETRY_AT', {
        retryAt: retryAtFor(result, now, this.ledger.consecutiveSupersessions(issueId) + 1),
        errorCode: result.finalStatus,
        eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus },
      }, now) ? result : fencedResult(result);
    }

    if (result.success) {
      const effect = options.successEffect?.(result, claim);
      if (!this.ledger.commitRunForSync(claim, effect, {
        prUrl: result.prUrl,
        eventData: { finalStatus: result.finalStatus, sessionId: result.sessionId },
      }, now)) {
        return fencedResult(result);
      }
      if (!options.successEffect) this.ledger.finalizeSyncedRun(issueId, now);
      return result;
    }

    if (result.finalStatus === 'waiting_on_operator') {
      if (result.workerResult?.executionOutcomeUnknown) {
        const reason = 'Sandbox command outcome unknown; inspect the preserved worktree and explicitly redispatch to resume';
        return this.ledger.transition(claim, 'NEEDS_HUMAN', {
          errorCode: SANDBOX_OUTCOME_UNKNOWN_PARK_REASON,
          errorMessage: reason,
          eventKind: 'sandbox_outcome_quarantined',
          eventData: { reason, sessionId: result.sessionId },
        }, now) ? result : fencedResult(result);
      }
      const correlationIds = normalizeOperatorQuestionCorrelations(
        result.workerResult?.operatorQuestionCorrelationIds ?? [],
      );
      if (correlationIds.length > 0) {
        const reason = `Waiting for operator answer (${correlationIds.join(', ')})`;
        return this.ledger.transition(claim, 'NEEDS_HUMAN', {
          errorCode: OPERATOR_QUESTION_PARK_REASON,
          errorMessage: reason,
          eventKind: 'operator_question_parked',
          eventData: { reason, correlationIds },
        }, now) ? result : fencedResult(result);
      }
      // Old/non-native adapters may identify the wait without returning the
      // durable tool correlation. Do not invent a broad resume condition: the
      // default RETRY_AT below is the fail-closed compatibility path.
    }

    const detail = pickPipelineFailureDetail(result);

    // A deterministic failure the pipeline has already attributed to the
    // operator (publication-scope fence, …): retrying reproduces it exactly.
    if (result.operatorPark) {
      const { code, reason } = result.operatorPark;
      return this.ledger.transition(claim, 'NEEDS_HUMAN', {
        errorCode: code,
        errorMessage: reason,
        eventKind: 'operator_parked',
        eventData: { sessionId: result.sessionId, code, reason },
      }, now) ? result : fencedResult(result);
    }

    // An infrastructure failure is not counted toward STUCK, and rightly so:
    // a provider blip is not the task's fault. But the same infrastructure
    // failure on every attempt is not a blip, and retrying it forever is how
    // vela spent 140 attempts on 2026-09-01 — CodeQL extractor missing, a
    // sandbox socket not mounted — and produced nothing. Once the identical
    // fingerprint has repeated across the configured number of attempts, the
    // cause is durable and an operator has to change something; park with
    // the cause named, where `openswarm work` can redispatch it afterwards.
    if (result.finalStatus === 'infra_error' && this.infraFailureCircuit > 0) {
      const fingerprint = infraFailureFingerprint(detail);
      const prior = fingerprint ? this.ledger.consecutiveIdenticalInfraFailures(issueId, fingerprint) : 0;
      if (prior + 1 >= this.infraFailureCircuit) {
        const reason = `Identical infrastructure failure on ${prior + 1} consecutive attempts: ${detail ?? 'no detail'}`;
        return this.ledger.transition(claim, 'NEEDS_HUMAN', {
          errorCode: INFRA_CIRCUIT_PARK_REASON,
          errorMessage: reason,
          eventKind: 'infra_circuit_parked',
          eventData: { sessionId: result.sessionId, fingerprint, attempts: prior + 1 },
        }, now) ? result : fencedResult(result);
      }
    }

    let target: RunState;
    switch (result.finalStatus) {
      case 'rate_limited':
      case 'infra_error':
      case 'rejected':
      case 'failed':
      default: target = 'RETRY_AT'; break;
    }
    const transitioned = this.ledger.transition(claim, target, {
      retryAt: target === 'RETRY_AT' ? retryAtFor(result, now) : null,
      errorCode: result.finalStatus,
      errorMessage: detail,
      eventData: { sessionId: result.sessionId, finalStatus: result.finalStatus },
    }, now);
    return transitioned ? result : fencedResult(result);
  }

  reconcile(now = Date.now()): RunRecord[] {
    if (!this.ledger) return [];
    const reconciled = this.ledger.reconcileExpiredLeases(now);

    for (const claim of this.exitedClaims.values()) this.confirmExitedClaim(claim, now);
    for (const run of this.ledger.listRuns(['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING'])) {
      if (!run.ownerInstanceId || !run.leaseToken) continue;
      const pid = ownerProcessId(run.ownerInstanceId);
      // Docker commonly gives a replacement daemon the same container PID.
      // The PID probe then finds *this* process even though the persisted UUID
      // belongs to the daemon generation that was just stopped. A PID cannot
      // belong to two generations, so this exact mismatch proves the recorded
      // executor exited and avoids idling the repository for a full lease.
      const samePidDifferentGeneration = pid === process.pid && run.ownerInstanceId !== this.instanceId;
      if (pid != null && this.processIsAlive(pid) && !samePidDifferentGeneration) continue;
      const ownership = {
        issueId: run.issueId,
        ownerInstanceId: run.ownerInstanceId,
        leaseToken: run.leaseToken,
        leaseEpoch: run.leaseEpoch,
        attemptNo: run.attemptNo,
        leaseExpiresAt: run.leaseExpiresAt ?? 0,
      };
      if (this.ledger.reconcileDeadOwner(ownership, now)) {
        reconciled.push(this.ledger.getRun(run.issueId)!);
        this.confirmExitedClaim(ownership, now);
      }
    }
    for (const run of this.ledger.listRuns(['NEEDS_RECONCILE'])) {
      if (!run.ownerInstanceId || !run.leaseToken) {
        // Owner/lease already cleared — by a prior sweep of this same loop, or
        // by claimRun()'s own reconcileExpiredRows() path — but the row's
        // STATE never advanced past NEEDS_RECONCILE, so it is stuck forever:
        // not claimable (CLAIMABLE_STATES excludes NEEDS_RECONCILE) yet still
        // counted against claimRun()'s per-project admission cap, silently
        // squatting a slot no other issue in the repo can ever use (AGT-4056).
        //
        // Only safe to reopen here when NOTHING was ever pushed
        // (branchName == null): reconcile() has no filesystem/GitHub access,
        // so `prUrl == null` alone cannot prove nothing was published — the
        // ledger write and the actual `gh pr create` are two separate steps,
        // and a row can reach here having done the second without ever
        // completing the first. A row with a branchName MUST go through
        // autonomousRunner's reconcileDurableArtifacts() instead, which
        // checks GitHub for a real PR by branch name before ever falling back
        // to worktree-evidence inspection — reopening here would race ahead
        // of that check and can duplicate published work.
        if (run.branchName == null && run.prUrl == null && this.ledger.markReady(run.issueId, now)) {
          reconciled.push(this.ledger.getRun(run.issueId)!);
        }
        continue;
      }
      const pid = ownerProcessId(run.ownerInstanceId);
      // A container assigns the daemon the same pid every start, so a row
      // orphaned by a restart reads as "alive" forever — the new daemon's
      // own pid probe hits itself. Age is the only signal that survives that
      // (see reference_container_pid_reuse_lock.md; same trap already fixed
      // once in taskState/store.ts's LOCK_ABANDON_MS).
      //
      // Why age alone is safe here: reaching NEEDS_RECONCILE at all already
      // required a full leaseMs of silence — execute()'s renewTimer renews
      // every leaseMs/3, so a genuinely alive, functioning owner renews
      // several times over before its lease can expire. updatedAt marks that
      // expiry moment, so reconcileAbandonMs (default leaseMs) stacks a
      // second full lease window of silence on top — ~2*leaseMs of missed
      // renewal (multiple consecutive misses, not one) before this frees the
      // row, purely as a fallback for when the pid probe can't be trusted.
      const abandonedByAge = now - run.updatedAt >= this.reconcileAbandonMs;
      const samePidDifferentGeneration = pid === process.pid && run.ownerInstanceId !== this.instanceId;
      if (!abandonedByAge && !samePidDifferentGeneration && (pid == null || this.processIsAlive(pid))) continue;
      this.confirmExitedClaim({
        issueId: run.issueId,
        ownerInstanceId: run.ownerInstanceId,
        leaseToken: run.leaseToken,
        leaseEpoch: run.leaseEpoch,
        attemptNo: run.attemptNo,
        leaseExpiresAt: 0,
      }, now);
    }
    return reconciled;
  }

  async drainOutbox(
    deliver: OutboxDeliverer,
    options: { maxEffects?: number; leaseMs?: number; maxAttempts?: number; now?: () => number } = {},
  ): Promise<OutboxDrainResult> {
    if (!this.ledger || this.mode !== 'primary') return { applied: 0, retried: 0, dead: 0 };
    const maxEffects = Math.max(1, options.maxEffects ?? 20);
    const effectLeaseMs = Math.max(3_000, options.leaseMs ?? 60_000);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
    const clock = options.now ?? Date.now;
    const outcome: OutboxDrainResult = { applied: 0, retried: 0, dead: 0 };

    // Upgrade/restart repair for the historical ACK->DONE crash window. New
    // deliveries use the atomic acknowledgement path below.
    this.ledger.finalizeReadySyncedRuns(clock());

    for (let index = 0; index < maxEffects; index++) {
      const now = clock();
      let effect = this.ledger.claimNextEffect(this.instanceId, effectLeaseMs, now);
      if (!effect) break;
      let leaseLost = false;
      const renewEveryMs = Math.max(1_000, Math.floor(effectLeaseMs / 3));
      const renewTimer = setInterval(() => {
        const renewed = this.ledger!.renewEffectLease(effect!, effectLeaseMs, clock());
        if (renewed) effect = renewed;
        else leaseLost = true;
      }, renewEveryMs);
      renewTimer.unref?.();
      let deliveryError: unknown;
      try {
        await deliver(effect);
      } catch (error) {
        deliveryError = error;
      } finally {
        clearInterval(renewTimer);
      }
      if (leaseLost) continue;
      if (deliveryError === undefined) {
        const acknowledgement = this.ledger.ackEffectAndFinalizeRun(effect, clock());
        if (!acknowledgement.acknowledged) continue;
        outcome.applied++;
      } else {
        const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
        const dead = effect.attempts >= maxAttempts;
        const exponent = Math.min(effect.attempts, 8);
        const retryAt = clock() + Math.min(60 * 60_000, 5_000 * (2 ** exponent));
        if (this.ledger.retryEffect(effect, message, retryAt, { dead }, clock())) {
          if (dead) {
            outcome.dead++;
            this.ledger.markNeedsHuman(effect.issueId, `Outbox effect ${effect.kind} exhausted ${effect.attempts} deliveries: ${message}`, clock());
          } else {
            outcome.retried++;
          }
        }
      }
    }
    return outcome;
  }
}
