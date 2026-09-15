import { getInstanceId } from '../support/healthEndpoint.js';
import { shouldRefuseShippedClaim } from './shippedClaimGate.js';
import { DEFAULT_INFRA_FAILURE_CIRCUIT } from './infraFailureCircuit.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import {
  RunLedger,
  type EffectInput,
  type ImportRunInput,
  type RunClaim,
  type RunLedgerMode,
  type RunRecord,
  type ParkResumeTrigger,
  type RunState,
  type TrackerStateObservation,
} from './runLedger.js';
import type { TrackerTerminalState } from './runLedgerTrackerCache.js';
import {
  formatFenceWait,
  holdsLiveLease,
  processIsAlive,
  type DurableRunCoordinatorConfig,
  type ExecutionDurabilityHooks,
} from './durableRunCoordinatorHelpers.js';

/**
 * Connects pipeline execution to the SQLite run state machine. The coordinator
 * owns lease renewal and turns every late callback into a fenced no-op.
 */
export abstract class DurableRunCoordinatorBase {
  readonly mode: RunLedgerMode;
  readonly instanceId: string;
  protected readonly ledger?: RunLedger;
  protected readonly ownsLedger: boolean;
  protected readonly leaseMs: number;
  protected readonly maxActiveForProject: number;
  protected readonly infraFailureCircuit: number;
  protected readonly processIsAlive: (pid: number) => boolean;
  protected readonly reconcileAbandonMs: number;
  protected readonly exitedClaims = new Map<string, RunClaim>();
  protected closed = false;

  constructor(config: DurableRunCoordinatorConfig) {
    this.mode = config.mode;
    // Share the per-process id the worktree markers are stamped with, so a
    // ledger owner id names the same generation as the marker it wrote.
    this.instanceId = config.instanceId ?? `${process.pid}-${getInstanceId()}`;
    this.leaseMs = config.leaseMs ?? 10 * 60_000;
    this.maxActiveForProject = Math.max(1, Math.floor(config.maxActiveForProject ?? 1));
    this.infraFailureCircuit = Math.max(0, Math.floor(config.infraFailureCircuit ?? DEFAULT_INFRA_FAILURE_CIRCUIT));
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

  cacheTrackerObservation(
    expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion'>,
    observation: TrackerStateObservation,
    terminalState?: TrackerTerminalState,
    now = Date.now(),
  ): boolean {
    if (!this.ledger || this.mode !== 'primary') return false;
    return this.ledger.cacheTrackerObservation(expected, observation, terminalState, now);
  }

  /**
   * Identifiers of this project's runs a worker currently holds.
   *
   * This is what decides whether an open PR reserves its files. Not *why* a run
   * stopped — that was the first attempt and it did not survive contact with
   * production: the runs whose PRs were blocking siblings had all parked on an
   * operator question, but each later dispatch overwrote `lastErrorCode`, so
   * only 2 of 10 still said so. A lease is not overwritten by the next attempt;
   * it is held or it is not. (AGT-4097)
   *
   * `undefined` when this coordinator does not claim: `off` has no ledger at
   * all, and `shadow` observes without ever transitioning a run into an active
   * state. Both would otherwise return an empty array, which asserts "nothing
   * is held" — and a caller that fails closed on the difference (the draft
   * overlap gate does) would silently stop reserving anything.
   */
  /**
   * When the age sweeper will free `run` if its owner stays silent.
   *
   * Read from the same field the sweep compares against, so a caller reporting
   * the deadline and the sweep acting on it cannot drift apart. Exposed because
   * the reconciler in autonomousRunner logs the wait but lives in another file,
   * and named the executor's exit — a condition no one can observe once the
   * container holding it has been replaced. (AGT-4126)
   */
  reconcileAbandonDeadline(run: { updatedAt: number }): number {
    return run.updatedAt + this.reconcileAbandonMs;
  }

  /**
   * The sentence the reconciler prints while a claim is still held.
   *
   * Owned here because this class owns the policy it describes: the wait ends
   * when the age sweep fires, not when a process exits, and the two must not be
   * described by different files that can drift. (AGT-4126)
   */
  fenceWaitMessage(run: { updatedAt: number; identifier?: string | null; issueId: string }): string {
    return formatFenceWait(run.identifier ?? run.issueId, this.reconcileAbandonDeadline(run));
  }

  activeWorkerIdentifiers(projectPath: string, now = Date.now()): string[] | undefined {
    if (!this.isPrimary || !this.ledger) return undefined;
    const normalized = normalizeProjectPath(projectPath);
    return this.listRuns(ACTIVE_LEASE_STATES)
      .filter((run) => run.projectPath === normalized && holdsLiveLease(run, now))
      .map((run) => run.identifier)
      .filter((identifier): identifier is string => !!identifier);
  }

  /**
   * Branches protected by a currently-live worker lease. Integration uses the
   * branch name (not the issue identifier) because that is the ref it would
   * force-update. Undefined preserves the same fail-closed contract as
   * activeWorkerIdentifiers when the ledger is off/shadow.
   */
  activeWorkerBranches(projectPath: string, now = Date.now()): string[] | undefined {
    if (!this.isPrimary || !this.ledger) return undefined;
    const normalized = normalizeProjectPath(projectPath);
    return this.listRuns(ACTIVE_LEASE_STATES)
      .filter((run) => run.projectPath === normalized && holdsLiveLease(run, now))
      .map((run) => run.branchName)
      .filter((branch): branch is string => !!branch);
  }

  /**
   * Hold the same durable SQLite fence that claimRun() consults while a
   * post-merge integration updates one sibling branch. Expiry makes a daemon
   * crash recoverable; renewal keeps a slow network push fenced.
   */
  async withIntegrationReservation(
    projectPath: string,
    branchName: string,
    issueIdentifier: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    if (!this.isPrimary || !this.ledger || this.closed) return false;
    let reservation = this.ledger.acquireIntegrationReservation(
      normalizeProjectPath(projectPath),
      branchName,
      issueIdentifier,
      { ownerInstanceId: this.instanceId, leaseMs: this.leaseMs },
    );
    if (!reservation) return false;

    let leaseLost = false;
    const renewEveryMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const renewTimer = setInterval(() => {
      try {
        const renewed = this.ledger!.renewIntegrationReservation(reservation!, this.leaseMs);
        if (renewed) reservation = renewed;
        else leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, renewEveryMs);
    renewTimer.unref?.();

    try {
      await operation();
      return !leaseLost;
    } finally {
      clearInterval(renewTimer);
      this.ledger.releaseIntegrationReservation(reservation);
    }
  }

  markReady(issueId: string, now = Date.now()): boolean {
    return this.ledger?.markReady(issueId, now) ?? false;
  }

  queueIntegrationRequeue(
    issueId: string,
    expectedStateVersion: number,
    effect: EffectInput,
    now = Date.now(),
  ): boolean {
    return this.ledger?.queueIntegrationRequeue(issueId, expectedStateVersion, effect, now) ?? false;
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

  markNeedsHumanForQuestions(
    issueId: string,
    correlationIds: readonly string[],
    reason: string,
    now = Date.now(),
  ): boolean {
    return this.ledger?.markNeedsHumanForQuestions(issueId, correlationIds, reason, now) ?? false;
  }

  resumeNeedsHuman(issueId: string, now = Date.now(), trigger: ParkResumeTrigger = 'unspecified'): RunState | null {
    return this.ledger?.resumeNeedsHuman(issueId, now, trigger) ?? null;
  }

  resumeNeedsHumanForQuestions(issueId: string, now = Date.now()): RunState | null {
    return this.ledger?.resumeNeedsHumanForQuestions(issueId, now) ?? null;
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
        fileScopeSource: task.fileScopeSource,
        explicitDispatch: task.explicitDispatch === true,
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
      if (shouldRefuseShippedClaim(task, {
        hasPrUrl: Boolean(record.prUrl),
        shippedTerminal: true,
      })) {
        return record;
      }
      this.ledger.markReady(issueId, now);
      return this.ledger.getRun(issueId);
    }
    return record;
  }

  /**
   * Marker owner ids (`getInstanceId()` values) of every executor that once
   * claimed this run and no longer holds its lease.
   *
   * A worktree marker from another pid namespace cannot be judged by pid, so
   * the marker code trusts it for a full day. But an owner our own ledger has
   * already released is not "another container": it is a previous generation
   * of this daemon, and the ledger has proven its claim dead by a full lease
   * of silence. Naming those ids lets recovery release their markers now
   * rather than after the 24h window — which otherwise parks every in-flight
   * run for a day on each container recreate.
   */
  deadMarkerOwners(issueId: string): string[] {
    if (!this.ledger) return [];
    const run = this.ledger.getRun(issueId);
    const live = run?.ownerInstanceId;
    return this.ledger.listClaimOwners(issueId)
      .filter((owner) => owner !== live && owner !== this.instanceId)
      .map((owner) => owner.replace(/^\d+-/, ''))
      .filter((owner) => owner !== getInstanceId());
  }

  getProtectedWorktreePaths(projectPath?: string): Set<string> {
    return this.ledger?.getProtectedWorktreePaths(projectPath ? normalizeProjectPath(projectPath) : undefined) ?? new Set();
  }

  /**
   * Ledger metrics, counted within the projects the daemon actually works on.
   *
   * The raw table is a permanent record of everything the daemon has ever seen,
   * including projects that were later disabled and paths from an earlier
   * deployment that do not exist in this one. Those rows can never execute, but
   * they dominate a whole-table `GROUP BY state` and make the totals read as a
   * backlog. Measured on one host: 158 of 254 rows referenced host paths from
   * before containerisation, so `RETRY_AT` reported 88 where the live figure was
   * 48, and `READY` reported 24 where it was 4. Both readings produced a wrong
   * diagnosis before the scope was applied. (AGT-4127)
   *
   * Membership is a predicate, not a path list, because dispatch is two gates
   * with different case handling and every list-based re-derivation here got
   * one of them wrong. Callers pass `composeDispatchScope(...) via the runner's getDispatchScopePredicate()` — the
   * gates themselves — so the counts cannot disagree with dispatch. `undefined`
   * means unscoped: the raw table.
   *
   * Out-of-scope rows surface as one `outOfScope` number rather than being
   * dropped — hiding them would trade one misleading total for another.
   * `byState` and `expiredActiveLeases` are scoped because both derive from the
   * runs table. `effectsByStatus` and `openCircuits` stay global: effects and
   * circuits are keyed by their own identifiers rather than by project path,
   * and this comment is the record of that choice.
   */
  getMetrics(now = Date.now(), inScope?: (projectPath: string) => boolean) {
    const base = this.ledger?.getMetrics(now) ?? {
      byState: {}, effectsByStatus: {}, expiredActiveLeases: 0, oldestPendingEffectAgeMs: 0,
      openCircuits: 0,
    };
    if (!this.ledger || !inScope) return { ...base, outOfScope: 0 };

    const byState: Record<string, number> = {};
    let outOfScope = 0;
    let expiredActiveLeases = 0;
    for (const run of this.ledger.listRuns()) {
      if (!inScope(run.projectPath)) { outOfScope++; continue; }
      byState[run.state] = (byState[run.state] ?? 0) + 1;
      if (ACTIVE_LEASE_STATES.includes(run.state) && !holdsLiveLease(run, now)) expiredActiveLeases++;
    }
    return { ...base, byState, expiredActiveLeases, outOfScope };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsLedger) this.ledger?.close();
  }

  protected confirmExitedClaim(claim: RunClaim, now = Date.now()): void {
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

  protected noopHooks(): ExecutionDurabilityHooks {
    return {
      onWorktree: async () => true,
      onStage: async () => true,
      beforePublish: async () => true,
      onPublication: async () => true,
    };
  }
}
