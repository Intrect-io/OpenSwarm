import {
  RUN_STATES,
  type EffectRecord,
  type EffectStatus,
  type RunRecord,
  type RunState,
} from './runLedgerTypes.js';

export interface RunRow {
  issue_id: string;
  source: string;
  identifier: string | null;
  title: string | null;
  project_path: string;
  state: string;
  state_version: number;
  attempt_no: number;
  owner_instance_id: string | null;
  lease_token: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  retry_at: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  head_sha: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  discovered_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  tracker_state: string | null;
  tracker_state_type: string | null;
  tracker_checked_at: number | null;
  metadata_json: string | null;
}

export interface EffectRow {
  id: number;
  issue_id: string;
  attempt_no: number;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  status: EffectStatus;
  attempts: number;
  available_at: number;
  owner_instance_id: string | null;
  delivery_token: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

function parseJson(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function assertRunState(value: string): asserts value is RunState {
  if (!(RUN_STATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown automation run state: ${value}`);
  }
}

export function toRunRecord(row: RunRow): RunRecord {
  assertRunState(row.state);
  return {
    issueId: row.issue_id,
    source: row.source,
    identifier: row.identifier ?? undefined,
    title: row.title ?? undefined,
    projectPath: row.project_path,
    state: row.state,
    stateVersion: row.state_version,
    attemptNo: row.attempt_no,
    ownerInstanceId: row.owner_instance_id ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    retryAt: row.retry_at ?? undefined,
    branchName: row.branch_name ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    prUrl: row.pr_url ?? undefined,
    headSha: row.head_sha ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    discoveredAt: row.discovered_at,
    startedAt: row.started_at ?? undefined,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    trackerState: row.tracker_state ?? undefined,
    trackerStateType: row.tracker_state_type ?? undefined,
    trackerCheckedAt: row.tracker_checked_at ?? undefined,
    metadata: parseJson(row.metadata_json),
  };
}

export function toEffectRecord(row: EffectRow): EffectRecord {
  return {
    id: row.id,
    issueId: row.issue_id,
    attemptNo: row.attempt_no,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    ownerInstanceId: row.owner_instance_id ?? undefined,
    deliveryToken: row.delivery_token ?? undefined,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? undefined,
  };
}
