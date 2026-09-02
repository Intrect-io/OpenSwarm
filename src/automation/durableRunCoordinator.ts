import { getInstanceId } from '../support/healthEndpoint.js';
import { DEFAULT_INFRA_FAILURE_CIRCUIT, INFRA_CIRCUIT_PARK_REASON, infraFailureFingerprint } from './infraFailureCircuit.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import {
  RunLedger,
  type EffectClaim,
  type EffectInput,
  type ImportRunInput,
  type RunClaim,
  type RunLedgerMode,
  type RunRecord,
  type RunState,
  type TrackerStateObservation,
} from './runLedger.js';
import type { TrackerTerminalState } from './runLedgerTrackerCache.js';
import { pickPipelineFailureDetail } from './runnerState.js';
import {
  normalizeOperatorQuestionCorrelations,
  OPERATOR_QUESTION_PARK_REASON,
} from '../coordination/operatorAnswers.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';

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
  /**
   * Consecutive infra_error attempts with one failure fingerprint after which
   * the run parks for the operator instead of backing off again. 0 disables.
   * Default 6.
   */
  infraFailureCircuit?: number;
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
  /** Whether an unknown scope serializes against live same-repo runs (default) or is admitted. */
  unknownScopeAdmission?: 'serialize' | 'admit';
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

function nonExecutingResult(
  task: TaskItem,
  projectPath: string,
  reason: string,
  disposition: { status: 'deferred'; retryAt: number } | { status: 'superseded' },
): PipelineResult {
  return {
    success: false,
    sessionId: `durable-admission-${Date.now()}`,
    stages: [],
    finalStatus: disposition.status,
    retryAt: disposition.status === 'deferred' ? disposition.retryAt : undefined,
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
  if (result.finalStatus === 'deferred') return Math.max(now + 1_000, result.retryAt ?? 0);
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

const TASK_SOURCES: readonly TaskItem['source'][] = ['linear', 'local', 'discovered', 'github_pr', 'github_pr_review'];

/**
 * Priority is not durable — the ledger never stored it, because nothing about a
 * finished run needs one. A rebuilt task is only ever handed to the completion
 * effect, which reads id/identifier/title/project and nothing else, so this
 * fills the required field with the lowest rank rather than inventing a rank
 * that could outrank live work if the value ever did reach a scheduler.
 */
const REBUILT_TASK_PRIORITY = 4;

/**
 * Rebuild the {@link TaskItem} a run was registered from, using only its
 * durable record — the exact inverse of {@link DurableRunCoordinator.observeTask}'s
 * mapping.
 *
 * Reconciliation needs this because the heartbeat's fetch structurally cannot
 * see a terminal tracker card: Linear's slim query asks only for Todo /
 * In Progress / In Review / Backlog. A run whose issue reached Done therefore
 * has no live task to pair with, while still owning a branch, a merged PR and
 * an admission slot — so the GitHub-authoritative half of reconciliation would
 * wait forever on a card it is never going to be handed. (AGT-4094)
 */
/**
 * Is a worker still holding this run, or has its lease lapsed?
 *
 * An active state alone is not enough: a process that died leaves its row in
 * EXECUTING until reconciliation sweeps it, which can be a full lease period
 * later. Same test the ledger applies when it reclaims those rows, including
 * treating a missing expiry as lapsed rather than eternal. (AGT-4097)
 */
function holdsLiveLease(run: Pick<RunRecord, 'leaseExpiresAt'>, now: number): boolean {
  return run.leaseExpiresAt != null && run.leaseExpiresAt > now;
}

export function runRecordToTask(run: RunRecord): TaskItem {
  const metadata = (run.metadata ?? {}) as {
    projectId?: string;
    projectName?: string;
    fileScope?: string[];
    fileScopeSource?: TaskItem['fileScopeSource'];
    explicitDispatch?: boolean;
  };
  const source = TASK_SOURCES.find((candidate) => candidate === run.source);
  return {
    id: run.issueId,
    issueId: run.issueId,
    issueIdentifier: run.identifier,
    // The column is a free-form string; anything the union does not cover was
    // written by a source this build no longer knows, so say so rather than
    // asserting it into a member it may not be.
    source: source ?? 'discovered',
    title: run.title ?? run.identifier ?? run.issueId,
    priority: REBUILT_TASK_PRIORITY,
    projectPath: run.projectPath,
    linearProject: metadata.projectId
      ? { id: metadata.projectId, name: metadata.projectName ?? run.projectPath }
      : undefined,
    fileScope: metadata.fileScope,
    fileScopeSource: metadata.fileScopeSource,
    explicitDispatch: metadata.explicitDispatch === true,
    createdAt: run.discoveredAt,
  };
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
  private readonly infraFailureCircuit: number;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly reconcileAbandonMs: number;
  private readonly exitedClaims = new Map<string, RunClaim>();
  private closed = false;

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

  resumeNeedsHuman(issueId: string, now = Date.now()): RunState | null {
    return this.ledger?.resumeNeedsHuman(issueId, now) ?? null;
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

/**
 * Why a `NEEDS_RECONCILE` row is still fenced, and when that ends.
 *
 * Names both exits the sweep actually has — age, or a pid probe that shows the
 * owner gone — and pins the first to a clock time. There is deliberately no
 * "unless the owner renews": reaching `NEEDS_RECONCILE` already required a full
 * lease of silence, and nothing renews a row in that state, so offering renewal
 * as an alternative would describe a transition the state machine does not have.
 *
 * The previous wording — "until its original executor exits" — named an event
 * that is never observed when a container restart replaced the process holding
 * the claim, so a self-healing wait read as a permanent wedge. (AGT-4126)
 */
export function formatFenceWait(identifier: string, freesAtMs: number): string {
  return `[Reconciler] Keeping ${identifier} fenced — its claim is still held;`
    + ` frees at ${new Date(freesAtMs).toISOString()} by age,`
    + ' or sooner if its owner process is seen to have exited';
}
