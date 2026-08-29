export const AUTOMATION_SCHEMA_VERSION = 2;

export const RUN_STATES = [
  'DISCOVERED',
  'READY',
  'CLAIMED',
  'EXECUTING',
  'VERIFYING',
  'PUBLISHING',
  'SYNC_PENDING',
  'DONE',
  'RETRY_AT',
  'WAITING_EXTERNAL',
  'NEEDS_SPEC',
  'NEEDS_ENV',
  'NEEDS_HUMAN',
  'NEEDS_RECONCILE',
  'DECOMPOSED',
  'CANCELLED',
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type RunLedgerMode = 'off' | 'shadow' | 'primary';
export type EffectStatus = 'pending' | 'in_flight' | 'applied' | 'dead';

export const ACTIVE_LEASE_STATES: readonly RunState[] = [
  'CLAIMED',
  'EXECUTING',
  'VERIFYING',
  'PUBLISHING',
];

// NEEDS_RECONCILE is deliberately excluded. Artifact truth (PR/worktree/branch)
// must be checked before a crashed run can return to READY.
export const CLAIMABLE_STATES: readonly RunState[] = ['READY', 'RETRY_AT'];

export const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  DISCOVERED: ['READY', 'NEEDS_SPEC', 'NEEDS_ENV', 'CANCELLED'],
  READY: ['CLAIMED', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_SPEC', 'NEEDS_ENV', 'NEEDS_HUMAN', 'CANCELLED'],
  CLAIMED: ['EXECUTING', 'RETRY_AT', 'NEEDS_RECONCILE', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'PUBLISHING', 'SYNC_PENDING', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_SPEC', 'NEEDS_ENV', 'NEEDS_HUMAN', 'NEEDS_RECONCILE', 'DECOMPOSED', 'CANCELLED'],
  VERIFYING: ['PUBLISHING', 'SYNC_PENDING', 'RETRY_AT', 'NEEDS_SPEC', 'NEEDS_ENV', 'NEEDS_HUMAN', 'NEEDS_RECONCILE', 'CANCELLED'],
  PUBLISHING: ['SYNC_PENDING', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_RECONCILE', 'NEEDS_HUMAN', 'CANCELLED'],
  SYNC_PENDING: ['DONE', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_RECONCILE', 'NEEDS_HUMAN', 'CANCELLED'],
  DONE: ['READY'],
  RETRY_AT: ['CLAIMED', 'READY', 'RETRY_AT', 'NEEDS_RECONCILE', 'CANCELLED'],
  WAITING_EXTERNAL: ['READY', 'SYNC_PENDING', 'NEEDS_RECONCILE', 'NEEDS_HUMAN', 'CANCELLED'],
  NEEDS_SPEC: ['READY', 'NEEDS_HUMAN', 'CANCELLED'],
  NEEDS_ENV: ['READY', 'NEEDS_HUMAN', 'CANCELLED'],
  NEEDS_HUMAN: ['READY', 'SYNC_PENDING', 'NEEDS_RECONCILE', 'CANCELLED'],
  NEEDS_RECONCILE: ['READY', 'SYNC_PENDING', 'NEEDS_HUMAN', 'CANCELLED'],
  DECOMPOSED: ['READY'],
  CANCELLED: ['READY'],
};

export interface RegisterRunInput {
  issueId: string;
  source: string;
  identifier?: string;
  title?: string;
  projectPath: string;
  metadata?: unknown;
  ready?: boolean;
}

export interface ImportRunInput extends RegisterRunInput {
  state: 'DISCOVERED' | 'READY' | 'RETRY_AT' | 'NEEDS_RECONCILE' | 'NEEDS_HUMAN' | 'DONE' | 'DECOMPOSED' | 'CANCELLED';
  retryAt?: number;
  branchName?: string;
  worktreePath?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunRecord {
  issueId: string;
  source: string;
  identifier?: string;
  title?: string;
  projectPath: string;
  state: RunState;
  stateVersion: number;
  attemptNo: number;
  ownerInstanceId?: string;
  leaseToken?: string;
  leaseEpoch: number;
  leaseExpiresAt?: number;
  retryAt?: number;
  branchName?: string;
  worktreePath?: string;
  prUrl?: string;
  headSha?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  discoveredAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: unknown;
}

export interface RunClaim {
  issueId: string;
  ownerInstanceId: string;
  leaseToken: string;
  leaseEpoch: number;
  attemptNo: number;
  leaseExpiresAt: number;
}

export interface ClaimOptions {
  ownerInstanceId: string;
  leaseMs: number;
  now?: number;
  /** Atomic repository admission cap. Defaults to one active run per repository. */
  maxActiveForProject?: number;
  /** Normalized predicted write set. Unknown scope serializes against live same-repo claims. */
  conflictScope?: string[];
  maxAttemptsPerHour?: number;
  maxFailuresPerHour?: number;
  maxCostUsdPerDay?: number;
  circuitCooldownMs?: number;
}

export interface TransitionPatch {
  retryAt?: number | null;
  branchName?: string | null;
  worktreePath?: string | null;
  prUrl?: string | null;
  headSha?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: unknown;
  eventData?: unknown;
}

export interface AttemptResultInput {
  success: boolean;
  finalStatus: string;
  /**
   * Only meaningful when `finalStatus === 'infra_error'`: whether the cause was
   * the repository itself, not an adapter timeout, tooling failure, or network
   * blip. The repository failure circuit counts only the former (AGT-4038).
   */
  repositoryInfra?: boolean;
  costUsd?: number;
  result?: unknown;
  maxFailuresPerHour?: number;
  circuitCooldownMs?: number;
}

export interface EffectInput {
  kind: string;
  dedupeKey: string;
  payload: unknown;
  availableAt?: number;
}

export interface EffectRecord {
  id: number;
  issueId: string;
  attemptNo: number;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  status: EffectStatus;
  attempts: number;
  availableAt: number;
  ownerInstanceId?: string;
  deliveryToken?: string;
  leaseEpoch: number;
  leaseExpiresAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
}

export interface EffectClaim extends EffectRecord {
  ownerInstanceId: string;
  deliveryToken: string;
  leaseExpiresAt: number;
}

export interface LedgerMetrics {
  byState: Record<string, number>;
  effectsByStatus: Record<string, number>;
  expiredActiveLeases: number;
  oldestPendingEffectAgeMs: number;
  openCircuits: number;
}

export interface RunLedgerOptions {
  /** Operations override; production defaults to five seconds. */
  busyTimeoutMs?: number;
}

/**
 * Outcomes that are not the repository failing, and so must not trip its circuit.
 *
 * `waiting_on_operator` is the one that matters most and was missing: an agent
 * that stops to ask a question has not broken anything, and counting it as a
 * failure means a run of polite questions closes the whole repository to every
 * other task — measured on vela, six questions and one real failure opened the
 * circuit at 7/6 and idled the daemon for an hour. The better the human-in-the-
 * loop path works, the faster that would happen.
 *
 * Kept in one place because the three call sites had already drifted: the
 * in-memory guard was missing `operator_remediated` that both SQL copies had.
 */
export const NON_FAILURE_RESULT_STATUSES: readonly string[] = [
  'cancelled',
  'superseded',
  'rate_limited',
  'publication_reconcile',
  'operator_remediated',
  'waiting_on_operator',
];

/**
 * Row-mapping and argument helpers shared by the ledger's SQL.
 *
 * They live here rather than in `runLedger.ts` because that module sits on the
 * 1500-line pre-commit cap, and these are self-contained: no database handle, no
 * ledger state, nothing but their arguments.
 */
export function parseJson(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

export function assertRunState(value: string): asserts value is RunState {
  if (!(RUN_STATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown automation run state: ${value}`);
  }
}
