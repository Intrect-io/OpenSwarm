import { randomUUID } from 'node:crypto';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import {
  RunLedger,
  type EffectClaim,
  type EffectInput,
  type ImportRunInput,
  type RunClaim,
  type RunLedgerMode,
  type RunRecord,
  type RunState,
} from './runLedger.js';
import { pickPipelineFailureDetail } from './runnerState.js';

export interface DurableRunCoordinatorConfig {
  mode: RunLedgerMode;
  dbPath?: string;
  ledger?: RunLedger;
  instanceId?: string;
  leaseMs?: number;
  /** Default is one. Values above one must be an explicit repository policy. */
  maxActiveForProject?: number;
  /** Test seam for crash recovery; production probes the owner PID. */
  processIsAlive?: (pid: number) => boolean;
  /**
   * How long a NEEDS_RECONCILE row's stale owner is trusted once a pid probe
   * alone can't disprove it (container pid reuse — see reconcile()). Default
   * matches leaseMs: by the time a row reaches NEEDS_RECONCILE its lease has
   * already fully expired once, so this is a second, independent wait.
   */
  reconcileAbandonMs?: number;
}

export interface ExecutionDurabilityHooks {
  onWorktree(info: WorktreeInfo): Promise<boolean>;
  onStage(stage: string): Promise<boolean>;
  beforePublish(): Promise<boolean>;
  onPublication(prUrl: string, headSha?: string): Promise<boolean>;
}

export interface DurableExecuteOptions {
  successEffect?: (result: PipelineResult, claim: RunClaim) => EffectInput;
  cancelEffect?: (result: PipelineResult, claim: RunClaim) => EffectInput;
  /** Service shutdown is a resumable interruption, unlike an operator cancel. */
  retryCancellation?: (result: PipelineResult, claim: RunClaim) => boolean;
  admission?: RepositoryAdmissionPolicy;
}

export interface RepositoryAdmissionPolicy {
  maxConcurrent?: number;
  /** Predicted repository-relative write set used for atomic conflict admission. */
  conflictScope?: string[];
  maxAttemptsPerHour?: number;
  maxFailuresPerHour?: number;
  maxCostUsdPerDay?: number;
  circuitCooldownMs?: number;
}

export type OutboxDeliverer = (effect: EffectClaim) => Promise<void>;

export interface OutboxDrainResult {
  applied: number;
  retried: number;
  dead: number;
}

function nonExecutingResult(task: TaskItem, projectPath: string, reason: string): PipelineResult {
  return {
    success: false,
    sessionId: `durable-admission-${Date.now()}`,
    stages: [],
    finalStatus: 'superseded',
    totalDuration: 0,
    iterations: 0,
    taskContext: {
      issueIdentifier: task.issueIdentifier || task.issueId,
      projectName: task.linearProject?.name,
      projectPath,
      taskTitle: `${task.title} (${reason})`,
    },
  };
}

function fencedResult(result: PipelineResult): PipelineResult {
  return {
    ...result,
    success: false,
    finalStatus: 'infra_error',
    failureSignal: result.failureSignal ?? 'timeout',
  };
}

export function retryAtFor(result: PipelineResult, now: number, attemptNo = 1): number {
  if (result.finalStatus === 'rate_limited') return result.rateLimitResetsAt ?? now + 60_000;
  if (result.finalStatus === 'superseded') {
    // A first overlap can disappear quickly, but a still-open PR or persistent
    // file-scope conflict should not burn a fresh Draft/worker admission every
    // heartbeat forever. Back off repeated supersession while retaining a
    // bounded recheck so closing/merging the owning PR makes the issue runnable.
    const exponent = Math.max(0, Math.min(16, attemptNo - 1));
    return now + Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** exponent));
  }
  if (result.finalStatus === 'infra_error') return now + 15 * 60_000;
  return now + 30 * 60_000;
}

function ownerProcessId(instanceId: string): number | null {
  const match = instanceId.match(/^(\d+)-/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Connects pipeline execution to the SQLite run state machine. The coordinator
 * owns lease renewal and turns every late callback into a fenced no-op.
 */
export class DurableRunCoordinator {
  readonly mode: RunLedgerMode;
  readonly instanceId: string;
  private readonly ledger?: RunLedger;
  private readonly ownsLedger: boolean;
  private readonly leaseMs: number;
  private readonly maxActiveForProject: number;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly reconcileAbandonMs: number;
  private readonly exitedClaims = new Map<string, RunClaim>();
  private closed = false;

  constructor(config: DurableRunCoordinatorConfig) {
    this.mode = config.mode;
    this.instanceId = config.instanceId ?? `${process.pid}-${randomUUID()}`;
    this.leaseMs = config.leaseMs ?? 10 * 60_000;
    this.maxActiveForProject = Math.max(1, Math.floor(config.maxActiveForProject ?? 1));
    this.processIsAlive = config.processIsAlive ?? processIsAlive;
    this.reconcileAbandonMs = config.reconcileAbandonMs ?? this.leaseMs;
    if (this.leaseMs < 3_000) throw new Error('Durable run lease must be at least 3000ms');
    // A negative value would make `now - run.updatedAt >= reconcileAbandonMs`
    // trivially true for every row the instant it enters NEEDS_RECONCILE,
    // silently collapsing the whole safety margin this is meant to enforce.
    if (!Number.isFinite(this.reconcileAbandonMs) || this.reconcileAbandonMs < 0) {
      throw new Error('reconcileAbandonMs must be a non-negative, finite number of milliseconds');
    }
    this.ledger = config.mode === 'off' ? undefined : (config.ledger ?? new RunLedger(config.dbPath));
    this.ownsLedger = config.mode !== 'off' && !config.ledger;
  }

  get isPrimary(): boolean {
    return this.mode === 'primary';
  }

  getRun(issueId: string): RunRecord | null {
    return this.ledger?.getRun(issueId) ?? null;
  }

  listRuns(states?: readonly RunState[]): RunRecord[] {
    return this.ledger?.listRuns(states) ?? [];
  }

  markReady(issueId: string, now = Date.now()): boolean {
    return this.ledger?.markReady(issueId, now) ?? false;
  }

  consecutiveAttemptsWithErrorCode(issueId: string, errorCode: string, sinceMs?: number): number {
    return this.ledger?.consecutiveAttemptsWithErrorCode(issueId, errorCode, sinceMs) ?? 0;
  }

  readmitParkedRun(issueId: string, parkCode: string, now = Date.now()): boolean {
    return this.ledger?.readmitParkedRun(issueId, parkCode, now) ?? false;
  }

  recoverPublishedRun(
    issueId: string,
    publication: { prUrl: string; headSha?: string },
    effect: EffectInput,
    now = Date.now(),
  ): boolean {
    return this.ledger?.recoverPublishedRun(issueId, publication, effect, now) ?? false;
  }

  markNeedsHuman(issueId: string, reason: string, now = Date.now()): boolean {
    return this.ledger?.markNeedsHuman(issueId, reason, now) ?? false;
  }

  resumeNeedsHuman(issueId: string, now = Date.now()): RunState | null {
    return this.ledger?.resumeNeedsHuman(issueId, now) ?? null;
  }

  importLegacyRun(input: ImportRunInput, now = Date.now()): { record: RunRecord; imported: boolean } | null {
    return this.ledger?.importRun({ ...input, projectPath: normalizeProjectPath(input.projectPath) }, now) ?? null;
  }

  observeTask(task: TaskItem, projectPath: string, now = Date.now()): RunRecord | null {
    if (!this.ledger) return null;
    const issueId = task.issueId || task.id;
    const record = this.ledger.registerRun({
      issueId,
      source: task.source ?? 'unknown',
      identifier: task.issueIdentifier,
      title: task.title,
      projectPath: normalizeProjectPath(projectPath),
      metadata: {
        projectId: task.linearProject?.id,
        projectName: task.linearProject?.name,
        fileScope: task.fileScope,
      },
    }, now);

    // Todo is the autonomous operator-reopen surface. In Progress may be owned
    // by a human or another daemon and therefore never reactivates a terminal
    // run on its own — but an explicit user dispatch (issue board / `work`
    // CLI) IS the operator saying "run this", so it reopens terminal records
    // regardless of the Linear state it arrived in. Without this, dispatching
    // a previously-completed issue reports "queued" and then dies as
    // `superseded` with the issue stranded In Progress. (INT-3388)
    if (
      (record.state === 'DONE' || record.state === 'DECOMPOSED' || record.state === 'CANCELLED')
      && (task.linearState === 'Todo' || task.explicitDispatch === true)
    ) {
      this.ledger.markReady(issueId, now);
      return this.ledger.getRun(issueId);
    }
    return record;
  }

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
      maxAttemptsPerHour: options.admission?.maxAttemptsPerHour,
      maxFailuresPerHour: options.admission?.maxFailuresPerHour,
      maxCostUsdPerDay: options.admission?.maxCostUsdPerDay,
      circuitCooldownMs: options.admission?.circuitCooldownMs,
    });
    if (!claim) {
      if (this.isPrimary) {
        const now = Date.now();
        const circuitOpenUntil = this.ledger.getCircuitOpenUntil(issueId, now);
        this.ledger.deferUnclaimedRun(
          issueId,
          Math.max(now + 30_000, circuitOpenUntil ?? 0),
          'Durable claim unavailable (repository admission, circuit, budget, or concurrent owner)',
          now,
        );
        return nonExecutingResult(task, projectPath, 'durable claim unavailable');
      }
      return executor(this.noopHooks(), new AbortController().signal);
    }

    if (!this.ledger.transition(claim, 'EXECUTING')) {
      if (this.isPrimary) return nonExecutingResult(task, projectPath, 'claim fence rejected');
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
      return this.ledger.transition(claim, 'RETRY_AT', {
        retryAt: retryAtFor(result, now, claim.attemptNo),
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
      errorMessage: pickPipelineFailureDetail(result),
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
      if (pid == null || this.processIsAlive(pid)) continue;
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
      if (!abandonedByAge && (pid == null || this.processIsAlive(pid))) continue;
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

  getProtectedWorktreePaths(projectPath?: string): Set<string> {
    return this.ledger?.getProtectedWorktreePaths(projectPath ? normalizeProjectPath(projectPath) : undefined) ?? new Set();
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

  getMetrics(now = Date.now()) {
    return this.ledger?.getMetrics(now) ?? {
      byState: {}, effectsByStatus: {}, expiredActiveLeases: 0, oldestPendingEffectAgeMs: 0,
      openCircuits: 0,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsLedger) this.ledger?.close();
  }

  private confirmExitedClaim(claim: RunClaim, now = Date.now()): void {
    try {
      if (this.ledger?.confirmExecutorExit(claim, now)) {
        this.exitedClaims.delete(claim.issueId);
        return;
      }
      const run = this.ledger?.getRun(claim.issueId);
      const stillOwned = run?.ownerInstanceId === claim.ownerInstanceId
        && run.leaseToken === claim.leaseToken
        && run.leaseEpoch === claim.leaseEpoch;
      if (stillOwned) this.exitedClaims.set(claim.issueId, claim);
      else this.exitedClaims.delete(claim.issueId);
    } catch (error) {
      this.exitedClaims.set(claim.issueId, claim);
      console.warn(`[DurableRunCoordinator] Executor-exit acknowledgement deferred for ${claim.issueId}:`, error);
    }
  }

  private noopHooks(): ExecutionDurabilityHooks {
    return {
      onWorktree: async () => true,
      onStage: async () => true,
      beforePublish: async () => true,
      onPublication: async () => true,
    };
  }
}
