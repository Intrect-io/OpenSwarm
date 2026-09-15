import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import type {
  EffectClaim,
  EffectInput,
  RunClaim,
  RunLedger,
  RunLedgerMode,
  RunRecord,
} from './runLedger.js';
import type { CoordinatorResolution } from './coordinatorResolution.js';

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
  /**
   * Resolve a deterministic operator park before it is committed to
   * NEEDS_HUMAN. The callback is pure policy; tracker/ledger side effects stay
   * in this coordinator so a completion or bounded retry cannot split state.
   */
  resolveOperatorPark?: (
    task: TaskItem,
    result: PipelineResult,
    attemptNo: number,
  ) => CoordinatorResolution | undefined;
}

export interface RepositoryAdmissionPolicy {
  maxConcurrent?: number;
  /** Predicted repository-relative write set used for atomic conflict admission. */
  conflictScope?: string[];
  /** Whether an unknown scope serializes against live same-repo runs or is admitted (default admit). */
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

export function nonExecutingResult(
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

export function fencedResult(result: PipelineResult): PipelineResult {
  return {
    ...result,
    success: false,
    finalStatus: 'infra_error',
    failureDetail: 'durable completion: lease fence rejected result from an expired or replaced owner',
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

export function ownerProcessId(instanceId: string): number | null {
  const match = instanceId.match(/^(\d+)-/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function processIsAlive(pid: number): boolean {
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

export { holdsLiveLease };

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
