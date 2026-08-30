// ============================================
// OpenSwarm - Evidence-backed priority councils (AGT-4132)
// ============================================
//
// Councils are deliberately advisory. They may rank a bounded cohort after
// deterministic tracker/dependency facts have produced a real tie or conflict,
// but they can never start work, bypass dependencies or leases, merge code, use
// destructive tools, or mutate the tracker. The durable SQLite record is tied
// to one repository thread so the proposal, evidence, ballots, result, and
// consumers survive daemon restarts without polling Linear for every vote.

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CoordinationPeer } from './repositoryCell.js';
import { getCoordinationThread } from './coordinationThreads.js';
import { getTraceDb } from './coordinationTrace.js';

export type PriorityCouncilReason = 'tie' | 'conflict-cohort' | 'high-impact';
export type PriorityCouncilStatus = 'open' | 'finalized' | 'expired';
export type PriorityCouncilOutcome = 'selected' | 'tie-break' | 'no-quorum';

export interface PriorityCouncilEvidence {
  id: string;
  source: 'tracker-cache' | 'coordination-thread' | 'repository' | 'test' | 'operator';
  summary: string;
  ref?: string;
}

/** Machine-checkable cached fields used by the scheduler's normal ordering. */
export interface PriorityCouncilSchedulingFacts {
  priority: number;
  topoRank?: number;
  dueDate?: number;
  downstreamCount: number;
  blockedBy: string[];
  linearState?: string;
}

export interface PriorityCouncilOption {
  id: string;
  label: string;
  taskId: string;
  evidenceIds: string[];
  /** Required for automatic scheduler consumption; legacy/manual councils may omit it. */
  schedulingFacts?: PriorityCouncilSchedulingFacts;
}

export interface PriorityCouncilEligibleVoter {
  actor: string;
  actorName?: string;
  actorRole: string;
  taskId: string;
  taskLabel?: string;
  lastSeen: number;
}

export interface PriorityCouncilTallyEntry {
  optionId: string;
  points: number;
  firstChoiceCount: number;
  proposalOrder: number;
}

export interface PriorityCouncil {
  id: string;
  repository: string;
  threadId: string;
  reason: PriorityCouncilReason;
  subject: string;
  status: PriorityCouncilStatus;
  outcome?: PriorityCouncilOutcome;
  version: number;
  options: PriorityCouncilOption[];
  eligibleVoters: PriorityCouncilEligibleVoter[];
  snapshotVersion: string;
  snapshotDigest: string;
  snapshotCapturedAt: number;
  snapshotEvidence: PriorityCouncilEvidence[];
  requiredQuorum: number;
  requiredTaskQuorum: number;
  requiredRoleQuorum: number;
  activeWindowMs: number;
  expiresAt: number;
  proposedByActor: string;
  proposedByTaskId: string;
  proposedByRole?: string;
  selectedOptionId?: string;
  rankedOptionIds: string[];
  tieOptionIds: string[];
  tally: PriorityCouncilTallyEntry[];
  decisionEvidenceIds: string[];
  noQuorumReasons: string[];
  createdAt: number;
  updatedAt: number;
  finalizedAt?: number;
  finalizedByActor?: string;
  finalizedByTaskId?: string;
  ballotCount: number;
  evidenceSubmissionCount: number;
  consumptionCount: number;
  coordinationWallTimeMs?: number;
}

export interface PriorityCouncilBallot {
  id: string;
  councilId: string;
  actor: string;
  actorName?: string;
  actorRole: string;
  taskId: string;
  taskLabel?: string;
  ranking: string[];
  confidence: number;
  evidenceIds: string[];
  snapshotVersion: string;
  createdAt: number;
}

export interface PriorityCouncilEvidenceSubmission {
  id: string;
  councilId: string;
  optionId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  summary: string;
  refs: string[];
  createdAt: number;
}

export interface PriorityCouncilConsumption {
  id: string;
  councilId: string;
  consumer: string;
  consumerTaskId: string;
  consumerRole: 'scheduler' | 'orchestrator';
  councilVersion: number;
  snapshotVersion: string;
  consumedAt: number;
}

export interface PriorityCouncilDetail {
  council: PriorityCouncil;
  ballots: PriorityCouncilBallot[];
  evidenceSubmissions: PriorityCouncilEvidenceSubmission[];
  consumptions: PriorityCouncilConsumption[];
}

export interface CreatePriorityCouncilInput {
  repository: string;
  threadId: string;
  reason: PriorityCouncilReason;
  subject: string;
  options: PriorityCouncilOption[];
  snapshotVersion: string;
  snapshotCapturedAt: number;
  snapshotEvidence: PriorityCouncilEvidence[];
  eligiblePeers: CoordinationPeer[];
  requiredQuorum?: number;
  expiresInMs?: number;
  activeWindowMs?: number;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  idempotencyKey: string;
  now?: number;
}

export interface CastPriorityCouncilBallotInput {
  repository: string;
  councilId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  ranking: string[];
  confidence: number;
  evidenceIds: string[];
  snapshotVersion: string;
  idempotencyKey: string;
  now?: number;
}

export interface SubmitPriorityCouncilEvidenceInput {
  repository: string;
  councilId: string;
  optionId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  summary: string;
  refs: string[];
  idempotencyKey: string;
  now?: number;
}

export interface FinalizePriorityCouncilInput {
  repository: string;
  councilId: string;
  expectedVersion: number;
  actor: string;
  taskId: string;
  idempotencyKey: string;
  now?: number;
}

export const PRIORITY_COUNCIL_LIMITS = Object.freeze({
  minOptions: 2,
  maxOptions: 8,
  maxEligibleVoters: 24,
  minQuorum: 2,
  maxQuorum: 7,
  requiredTaskQuorum: 2,
  requiredRoleQuorum: 2,
  minExpiryMs: 60_000,
  maxExpiryMs: 24 * 60 * 60_000,
  defaultExpiryMs: 30 * 60_000,
  defaultActiveWindowMs: 30 * 60_000,
  maxSnapshotAgeMs: 10 * 60_000,
  maxEvidence: 32,
  maxEvidenceRefs: 8,
  maxBlockers: 32,
});

export const ADVISORY_RANKING_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  allowedEffect: 'stable-ranking-within-council-cohort' as const,
  canStartTask: false,
  canBypassDependencies: false,
  canBypassFileLeases: false,
  canMerge: false,
  canUseDestructiveTools: false,
  canMutateTracker: false,
});

export interface AdvisoryPriorityRankingSignal {
  schemaVersion: 1;
  councilId: string;
  threadId: string;
  councilVersion: number;
  snapshotVersion: string;
  outcome: 'selected' | 'tie-break';
  selectedOptionId: string;
  rankedOptionIds: string[];
  rankedTaskIds: string[];
  evidenceIds: string[];
  authority: typeof ADVISORY_RANKING_AUTHORITY;
}

const ELIGIBLE_ROLES = new Set(['worker', 'reviewer', 'orchestrator', 'review-agent']);
const MAX_TEXT = 500;
const MAX_ID = 240;
const MAX_KEY = 160;
const SECRET_VALUE = /(bearer\s+[A-Za-z0-9._~+/-]+|(?:sk|ghp|xox[baprs])_?[-A-Za-z0-9_]{8,})/gi;

interface CouncilRow {
  council_id: string;
  repository: string;
  thread_id: string;
  reason: PriorityCouncilReason;
  subject: string;
  status: PriorityCouncilStatus;
  outcome: PriorityCouncilOutcome | null;
  version: number;
  options_json: string;
  eligible_voters_json: string;
  snapshot_version: string;
  snapshot_digest: string;
  snapshot_captured_at: number;
  snapshot_evidence_json: string;
  required_quorum: number;
  required_task_quorum: number;
  required_role_quorum: number;
  active_window_ms: number;
  expires_at: number;
  proposed_by_actor: string;
  proposed_by_task_id: string;
  proposed_by_role: string | null;
  create_idempotency_key: string;
  fingerprint: string;
  selected_option_id: string | null;
  ranked_option_ids_json: string | null;
  tie_option_ids_json: string | null;
  tally_json: string | null;
  decision_evidence_ids_json: string | null;
  no_quorum_reasons_json: string | null;
  finalization_idempotency_key: string | null;
  finalization_fingerprint: string | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  finalized_by_actor: string | null;
  finalized_by_task_id: string | null;
  ballot_count: number;
  evidence_submission_count: number;
  consumption_count: number;
}

interface BallotRow {
  ballot_id: string;
  council_id: string;
  actor: string;
  actor_name: string | null;
  actor_role: string;
  task_id: string;
  task_label: string | null;
  ranking_json: string;
  confidence: number;
  evidence_ids_json: string;
  snapshot_version: string;
  idempotency_key: string;
  fingerprint: string;
  created_at: number;
}

interface EvidenceRow {
  evidence_id: string;
  council_id: string;
  option_id: string;
  actor: string;
  actor_name: string | null;
  actor_role: string | null;
  task_id: string;
  task_label: string | null;
  summary: string;
  refs_json: string;
  idempotency_key: string;
  fingerprint: string;
  created_at: number;
}

interface ConsumptionRow {
  consumption_id: string;
  council_id: string;
  consumer: string;
  consumer_task_id: string;
  consumer_role: 'scheduler' | 'orchestrator';
  council_version: number;
  snapshot_version: string;
  consumed_at: number;
}

function database(): Database.Database {
  const db = getTraceDb();
  if (!db) throw new Error('Priority council store is unavailable');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_priority_councils (
      council_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES coordination_threads(thread_id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK(reason IN ('tie', 'conflict-cohort', 'high-impact')),
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'finalized', 'expired')),
      outcome TEXT CHECK(outcome IN ('selected', 'tie-break', 'no-quorum')),
      version INTEGER NOT NULL DEFAULT 1,
      options_json TEXT NOT NULL,
      eligible_voters_json TEXT NOT NULL,
      snapshot_version TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      snapshot_captured_at INTEGER NOT NULL,
      snapshot_evidence_json TEXT NOT NULL,
      required_quorum INTEGER NOT NULL,
      required_task_quorum INTEGER NOT NULL,
      required_role_quorum INTEGER NOT NULL,
      active_window_ms INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      proposed_by_actor TEXT NOT NULL,
      proposed_by_task_id TEXT NOT NULL,
      proposed_by_role TEXT,
      create_idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      selected_option_id TEXT,
      ranked_option_ids_json TEXT,
      tie_option_ids_json TEXT,
      tally_json TEXT,
      decision_evidence_ids_json TEXT,
      no_quorum_reasons_json TEXT,
      finalization_idempotency_key TEXT,
      finalization_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finalized_at INTEGER,
      finalized_by_actor TEXT,
      finalized_by_task_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS coordination_priority_council_create_key
      ON coordination_priority_councils(repository, proposed_by_actor, proposed_by_task_id, create_idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS coordination_priority_council_open_thread
      ON coordination_priority_councils(thread_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS coordination_priority_council_repository
      ON coordination_priority_councils(repository, updated_at DESC, council_id DESC);

    CREATE TABLE IF NOT EXISTS coordination_priority_ballots (
      ballot_id TEXT PRIMARY KEY,
      council_id TEXT NOT NULL REFERENCES coordination_priority_councils(council_id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_label TEXT,
      ranking_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence > 0 AND confidence <= 1),
      evidence_ids_json TEXT NOT NULL,
      snapshot_version TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(council_id, actor, task_id),
      UNIQUE(council_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS coordination_priority_evidence (
      evidence_id TEXT PRIMARY KEY,
      council_id TEXT NOT NULL REFERENCES coordination_priority_councils(council_id) ON DELETE CASCADE,
      option_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      task_id TEXT NOT NULL,
      task_label TEXT,
      summary TEXT NOT NULL,
      refs_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(council_id, actor, task_id, option_id),
      UNIQUE(council_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS coordination_priority_consumptions (
      consumption_id TEXT PRIMARY KEY,
      council_id TEXT NOT NULL REFERENCES coordination_priority_councils(council_id) ON DELETE CASCADE,
      consumer TEXT NOT NULL,
      consumer_task_id TEXT NOT NULL,
      consumer_role TEXT NOT NULL CHECK(consumer_role IN ('scheduler', 'orchestrator')),
      council_version INTEGER NOT NULL,
      snapshot_version TEXT NOT NULL,
      consumed_at INTEGER NOT NULL,
      UNIQUE(council_id, consumer, consumer_task_id)
    );
  `);
}

function text(value: string, field: string, max = MAX_TEXT): string {
  const clean = value.trim().replace(SECRET_VALUE, '[redacted]');
  if (!clean) throw new Error(`${field} must be non-empty`);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return clean;
}

function id(value: string, field: string): string {
  return text(value, field, MAX_ID);
}

function key(value: string): string {
  return text(value, 'idempotencyKey', MAX_KEY);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function councilRow(db: Database.Database, repository: string, councilId: string): CouncilRow | undefined {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM coordination_priority_ballots b WHERE b.council_id = c.council_id) AS ballot_count,
      (SELECT COUNT(*) FROM coordination_priority_evidence e WHERE e.council_id = c.council_id) AS evidence_submission_count,
      (SELECT COUNT(*) FROM coordination_priority_consumptions x WHERE x.council_id = c.council_id) AS consumption_count
    FROM coordination_priority_councils c
    WHERE c.repository = ? AND c.council_id = ?
  `).get(id(repository, 'repository'), id(councilId, 'councilId')) as CouncilRow | undefined;
}

function requireCouncilRow(db: Database.Database, repository: string, councilId: string): CouncilRow {
  const row = councilRow(db, repository, councilId);
  if (!row) throw new Error(`Priority council not found: ${councilId}`);
  return row;
}

function toCouncil(row: CouncilRow): PriorityCouncil {
  return {
    id: row.council_id,
    repository: row.repository,
    threadId: row.thread_id,
    reason: row.reason,
    subject: row.subject,
    status: row.status,
    outcome: row.outcome ?? undefined,
    version: row.version,
    options: parseJson(row.options_json, []),
    eligibleVoters: parseJson(row.eligible_voters_json, []),
    snapshotVersion: row.snapshot_version,
    snapshotDigest: row.snapshot_digest,
    snapshotCapturedAt: row.snapshot_captured_at,
    snapshotEvidence: parseJson(row.snapshot_evidence_json, []),
    requiredQuorum: row.required_quorum,
    requiredTaskQuorum: row.required_task_quorum,
    requiredRoleQuorum: row.required_role_quorum,
    activeWindowMs: row.active_window_ms,
    expiresAt: row.expires_at,
    proposedByActor: row.proposed_by_actor,
    proposedByTaskId: row.proposed_by_task_id,
    proposedByRole: row.proposed_by_role ?? undefined,
    selectedOptionId: row.selected_option_id ?? undefined,
    rankedOptionIds: parseJson(row.ranked_option_ids_json, []),
    tieOptionIds: parseJson(row.tie_option_ids_json, []),
    tally: parseJson(row.tally_json, []),
    decisionEvidenceIds: parseJson(row.decision_evidence_ids_json, []),
    noQuorumReasons: parseJson(row.no_quorum_reasons_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at ?? undefined,
    finalizedByActor: row.finalized_by_actor ?? undefined,
    finalizedByTaskId: row.finalized_by_task_id ?? undefined,
    ballotCount: row.ballot_count,
    evidenceSubmissionCount: row.evidence_submission_count,
    consumptionCount: row.consumption_count,
    ...(row.finalized_at === null ? {} : { coordinationWallTimeMs: Math.max(0, row.finalized_at - row.created_at) }),
  };
}

function toBallot(row: BallotRow): PriorityCouncilBallot {
  return {
    id: row.ballot_id,
    councilId: row.council_id,
    actor: row.actor,
    actorName: row.actor_name ?? undefined,
    actorRole: row.actor_role,
    taskId: row.task_id,
    taskLabel: row.task_label ?? undefined,
    ranking: parseJson(row.ranking_json, []),
    confidence: row.confidence,
    evidenceIds: parseJson(row.evidence_ids_json, []),
    snapshotVersion: row.snapshot_version,
    createdAt: row.created_at,
  };
}

function toEvidence(row: EvidenceRow): PriorityCouncilEvidenceSubmission {
  return {
    id: row.evidence_id,
    councilId: row.council_id,
    optionId: row.option_id,
    actor: row.actor,
    actorName: row.actor_name ?? undefined,
    actorRole: row.actor_role ?? undefined,
    taskId: row.task_id,
    taskLabel: row.task_label ?? undefined,
    summary: row.summary,
    refs: parseJson(row.refs_json, []),
    createdAt: row.created_at,
  };
}

function toConsumption(row: ConsumptionRow): PriorityCouncilConsumption {
  return {
    id: row.consumption_id,
    councilId: row.council_id,
    consumer: row.consumer,
    consumerTaskId: row.consumer_task_id,
    consumerRole: row.consumer_role,
    councilVersion: row.council_version,
    snapshotVersion: row.snapshot_version,
    consumedAt: row.consumed_at,
  };
}

function normalizeEvidence(input: PriorityCouncilEvidence[]): PriorityCouncilEvidence[] {
  if (input.length < PRIORITY_COUNCIL_LIMITS.minOptions || input.length > PRIORITY_COUNCIL_LIMITS.maxEvidence) {
    throw new Error(`snapshotEvidence must contain between ${PRIORITY_COUNCIL_LIMITS.minOptions} and ${PRIORITY_COUNCIL_LIMITS.maxEvidence} entries`);
  }
  const ids = new Set<string>();
  return input.map((entry) => {
    const evidenceId = id(entry.id, 'evidence.id');
    if (ids.has(evidenceId)) throw new Error(`Duplicate evidence id: ${evidenceId}`);
    ids.add(evidenceId);
    if (!['tracker-cache', 'coordination-thread', 'repository', 'test', 'operator'].includes(entry.source)) {
      throw new Error(`Unsupported evidence source: ${entry.source}`);
    }
    return {
      id: evidenceId,
      source: entry.source,
      summary: text(entry.summary, 'evidence.summary'),
      ...(entry.ref === undefined ? {} : { ref: text(entry.ref, 'evidence.ref') }),
    };
  });
}

function normalizeSchedulingFacts(input: PriorityCouncilSchedulingFacts): PriorityCouncilSchedulingFacts {
  const priority = integer(input.priority, 'option.schedulingFacts.priority', 0, 100);
  const downstreamCount = integer(
    input.downstreamCount,
    'option.schedulingFacts.downstreamCount',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const blockedBy = [...new Set(input.blockedBy.map((value) => id(value, 'option.schedulingFacts.blockedBy')))]
    .sort((a, b) => a.localeCompare(b));
  if (blockedBy.length > PRIORITY_COUNCIL_LIMITS.maxBlockers) {
    throw new Error(`option.schedulingFacts.blockedBy exceeds ${PRIORITY_COUNCIL_LIMITS.maxBlockers} entries`);
  }
  return {
    priority,
    downstreamCount,
    blockedBy,
    ...(input.topoRank === undefined ? {} : {
      topoRank: integer(input.topoRank, 'option.schedulingFacts.topoRank', 0, Number.MAX_SAFE_INTEGER),
    }),
    ...(input.dueDate === undefined ? {} : {
      dueDate: integer(input.dueDate, 'option.schedulingFacts.dueDate', 0, Number.MAX_SAFE_INTEGER),
    }),
    ...(input.linearState === undefined ? {} : {
      linearState: text(input.linearState, 'option.schedulingFacts.linearState', 80),
    }),
  };
}

function normalizeOptions(input: PriorityCouncilOption[], evidence: PriorityCouncilEvidence[]): PriorityCouncilOption[] {
  if (input.length < PRIORITY_COUNCIL_LIMITS.minOptions || input.length > PRIORITY_COUNCIL_LIMITS.maxOptions) {
    throw new Error(`options must contain between ${PRIORITY_COUNCIL_LIMITS.minOptions} and ${PRIORITY_COUNCIL_LIMITS.maxOptions} entries`);
  }
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const optionIds = new Set<string>();
  const taskIds = new Set<string>();
  return input.map((entry) => {
    const optionId = id(entry.id, 'option.id');
    const taskId = id(entry.taskId, 'option.taskId');
    if (optionIds.has(optionId)) throw new Error(`Duplicate option id: ${optionId}`);
    if (taskIds.has(taskId)) throw new Error(`Duplicate option taskId: ${taskId}`);
    optionIds.add(optionId);
    taskIds.add(taskId);
    if (!entry.evidenceIds.length || entry.evidenceIds.length > PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs) {
      throw new Error(`option ${optionId} must reference 1-${PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs} evidence records`);
    }
    const refs = [...new Set(entry.evidenceIds.map((value) => id(value, 'option.evidenceId')))];
    if (refs.some((value) => !evidenceById.has(value))) {
      throw new Error(`option ${optionId} references unknown evidence`);
    }
    if (!refs.some((value) => evidenceById.get(value)?.source === 'tracker-cache')) {
      throw new Error(`option ${optionId} requires cached tracker evidence`);
    }
    return {
      id: optionId,
      label: text(entry.label, 'option.label'),
      taskId,
      evidenceIds: refs,
      ...(entry.schedulingFacts === undefined ? {} : {
        schedulingFacts: normalizeSchedulingFacts(entry.schedulingFacts),
      }),
    };
  });
}

/**
 * Stable version for a machine-checkable scheduling snapshot. The caller may
 * pass `snapshotVersion: "auto"`; ballots then use the returned version.
 */
export function priorityCouncilSchedulingSnapshotVersion(
  options: readonly PriorityCouncilOption[],
): string | undefined {
  const withFacts = options.filter((option) => option.schedulingFacts !== undefined);
  if (withFacts.length === 0) return undefined;
  if (withFacts.length !== options.length) {
    throw new Error('Every council option must include schedulingFacts for automatic scheduler consumption');
  }
  return `sched-v1:${digest(options.map((option) => ({
    taskId: option.taskId,
    schedulingFacts: option.schedulingFacts,
  })))}`;
}

function eligibleVoters(
  peers: CoordinationPeer[],
  options: PriorityCouncilOption[],
  now: number,
  activeWindowMs: number,
): PriorityCouncilEligibleVoter[] {
  const candidateTasks = new Set(options.map((option) => option.taskId));
  const seen = new Set<string>();
  const voters: PriorityCouncilEligibleVoter[] = [];
  for (const peer of [...peers].sort((a, b) => b.lastSeen - a.lastSeen || a.address.localeCompare(b.address) || a.taskId.localeCompare(b.taskId))) {
    const role = peer.role;
    if (!role || !ELIGIBLE_ROLES.has(role)) continue;
    // Independence is snapshotted at proposal time: nobody working on a
    // candidate task casts its deciding ballot, regardless of role. Those
    // workers/reviewers can still submit durable evidence for their option.
    if (candidateTasks.has(peer.taskId)) continue;
    if (peer.lastSeen > now + 60_000 || now - peer.lastSeen > activeWindowMs) continue;
    const identityKey = `${peer.address}\0${peer.taskId}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    voters.push({
      actor: id(peer.address, 'eligible.actor'),
      ...(peer.name ? { actorName: text(peer.name, 'eligible.actorName', MAX_ID) } : {}),
      actorRole: role,
      taskId: id(peer.taskId, 'eligible.taskId'),
      ...(peer.taskLabel ? { taskLabel: text(peer.taskLabel, 'eligible.taskLabel', MAX_ID) } : {}),
      lastSeen: peer.lastSeen,
    });
    if (voters.length >= PRIORITY_COUNCIL_LIMITS.maxEligibleVoters) break;
  }
  return voters;
}

function assertPossibleQuorum(voters: PriorityCouncilEligibleVoter[], requiredQuorum: number): void {
  if (voters.length < requiredQuorum) {
    throw new Error(`Not enough active independent peers for quorum (${voters.length}/${requiredQuorum})`);
  }
  if (new Set(voters.map((voter) => voter.actor)).size < 2) {
    throw new Error('Council requires at least two distinct active actors');
  }
  if (new Set(voters.map((voter) => voter.taskId)).size < PRIORITY_COUNCIL_LIMITS.requiredTaskQuorum) {
    throw new Error(`Council requires peers from ${PRIORITY_COUNCIL_LIMITS.requiredTaskQuorum} distinct tasks`);
  }
  if (new Set(voters.map((voter) => voter.actorRole)).size < PRIORITY_COUNCIL_LIMITS.requiredRoleQuorum) {
    throw new Error(`Council requires peers from ${PRIORITY_COUNCIL_LIMITS.requiredRoleQuorum} distinct roles`);
  }
}

/** Open one durable council on an existing open cross-task thread. */
export function createPriorityCouncil(input: CreatePriorityCouncilInput): PriorityCouncil {
  // Ensure the thread schema exists before the council migration creates its FK.
  const thread = getCoordinationThread({ repository: input.repository, threadId: input.threadId }).thread;
  if (thread.status !== 'open') throw new Error(`Coordination thread is ${thread.status}`);
  if (!['tie', 'conflict-cohort', 'high-impact'].includes(input.reason)) {
    throw new Error('reason must be tie, conflict-cohort, or high-impact');
  }
  const now = input.now ?? Date.now();
  const requestedSnapshotVersion = id(input.snapshotVersion, 'snapshotVersion');
  if (!Number.isSafeInteger(input.snapshotCapturedAt)) {
    throw new Error('Cached tracker snapshot is stale or has an invalid timestamp');
  }
  const snapshotEvidence = normalizeEvidence(input.snapshotEvidence);
  const options = normalizeOptions(input.options, snapshotEvidence);
  const automaticSnapshotVersion = priorityCouncilSchedulingSnapshotVersion(options);
  if (automaticSnapshotVersion
    && requestedSnapshotVersion !== 'auto'
    && requestedSnapshotVersion !== automaticSnapshotVersion) {
    throw new Error(`Scheduling snapshot version must be auto or ${automaticSnapshotVersion}`);
  }
  const snapshotVersion = automaticSnapshotVersion ?? requestedSnapshotVersion;
  const related = new Set(thread.relatedTaskIds);
  for (const option of options) {
    if (!related.has(option.taskId)) throw new Error(`Council option task ${option.taskId} is not related to thread ${thread.id}`);
  }
  const activeWindowMs = integer(
    input.activeWindowMs ?? PRIORITY_COUNCIL_LIMITS.defaultActiveWindowMs,
    'activeWindowMs',
    60_000,
    2 * 60 * 60_000,
  );
  const expiresInMs = integer(
    input.expiresInMs ?? PRIORITY_COUNCIL_LIMITS.defaultExpiryMs,
    'expiresInMs',
    PRIORITY_COUNCIL_LIMITS.minExpiryMs,
    PRIORITY_COUNCIL_LIMITS.maxExpiryMs,
  );
  const repository = id(input.repository, 'repository');
  const actor = id(input.actor, 'actor');
  const taskId = id(input.taskId, 'taskId');
  const createKey = key(input.idempotencyKey);
  const subject = text(input.subject, 'subject');
  const snapshotDigest = digest({ snapshotVersion, snapshotCapturedAt: input.snapshotCapturedAt, snapshotEvidence, options });
  const fingerprint = digest({
    repository, threadId: thread.id, reason: input.reason, subject, options,
    snapshotVersion, snapshotCapturedAt: input.snapshotCapturedAt, snapshotEvidence,
    requestedQuorum: input.requiredQuorum ?? null, expiresInMs, activeWindowMs, actor, taskId,
  });
  const db = database();
  // Active peers are a derived, time-varying snapshot. Resolve an idempotent
  // retry before recomputing eligibility so a board event expiring between two
  // identical calls cannot turn a successful creation into a failure.
  const prior = db.prepare(`
    SELECT council_id, fingerprint FROM coordination_priority_councils
    WHERE repository = ? AND proposed_by_actor = ? AND proposed_by_task_id = ? AND create_idempotency_key = ?
  `).get(repository, actor, taskId, createKey) as { council_id: string; fingerprint: string } | undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('Council idempotency key collision');
    return toCouncil(requireCouncilRow(db, repository, prior.council_id));
  }
  // A successful exact retry remains idempotent after the freshness window.
  // Freshness only gates a genuinely new proposal.
  if (input.snapshotCapturedAt > now + 60_000
    || now - input.snapshotCapturedAt > PRIORITY_COUNCIL_LIMITS.maxSnapshotAgeMs) {
    throw new Error('Cached tracker snapshot is stale or has an invalid timestamp');
  }
  const voters = eligibleVoters(input.eligiblePeers, options, now, activeWindowMs);
  const requiredQuorum = integer(
    input.requiredQuorum ?? Math.min(3, voters.length),
    'requiredQuorum',
    PRIORITY_COUNCIL_LIMITS.minQuorum,
    PRIORITY_COUNCIL_LIMITS.maxQuorum,
  );
  assertPossibleQuorum(voters, requiredQuorum);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT council_id, fingerprint FROM coordination_priority_councils
      WHERE repository = ? AND proposed_by_actor = ? AND proposed_by_task_id = ? AND create_idempotency_key = ?
    `).get(repository, actor, taskId, createKey) as { council_id: string; fingerprint: string } | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Council idempotency key collision');
      return toCouncil(requireCouncilRow(db, repository, existing.council_id));
    }
    const councilId = randomUUID();
    try {
      db.prepare(`
        INSERT INTO coordination_priority_councils(
          council_id, repository, thread_id, reason, subject, status, version,
          options_json, eligible_voters_json, snapshot_version, snapshot_digest,
          snapshot_captured_at, snapshot_evidence_json, required_quorum,
          required_task_quorum, required_role_quorum, active_window_ms, expires_at,
          proposed_by_actor, proposed_by_task_id, proposed_by_role,
          create_idempotency_key, fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        councilId, repository, thread.id, input.reason, subject,
        JSON.stringify(options), JSON.stringify(voters), snapshotVersion, snapshotDigest,
        input.snapshotCapturedAt, JSON.stringify(snapshotEvidence), requiredQuorum,
        PRIORITY_COUNCIL_LIMITS.requiredTaskQuorum, PRIORITY_COUNCIL_LIMITS.requiredRoleQuorum,
        activeWindowMs, now + expiresInMs, actor, taskId,
        input.actorRole ? text(input.actorRole, 'actorRole', 80) : null,
        createKey, fingerprint, now, now,
      );
    } catch (error) {
      if (error instanceof Error && /coordination_priority_council_open_thread|coordination_priority_councils\.thread_id/i.test(error.message)) {
        throw new Error(`Coordination thread already has an open priority council: ${thread.id}`);
      }
      throw error;
    }
    return toCouncil(requireCouncilRow(db, repository, councilId));
  }).immediate();
}

function ballotRows(db: Database.Database, councilId: string): BallotRow[] {
  return db.prepare(`
    SELECT * FROM coordination_priority_ballots WHERE council_id = ? ORDER BY created_at, ballot_id
  `).all(councilId) as BallotRow[];
}

function evidenceRows(db: Database.Database, councilId: string): EvidenceRow[] {
  return db.prepare(`
    SELECT * FROM coordination_priority_evidence WHERE council_id = ? ORDER BY created_at, evidence_id
  `).all(councilId) as EvidenceRow[];
}

/** Candidate workers and any other participant may add evidence, but not extra ballot weight. */
export function submitPriorityCouncilEvidence(input: SubmitPriorityCouncilEvidenceInput): PriorityCouncilEvidenceSubmission {
  const db = database();
  const repository = id(input.repository, 'repository');
  const councilId = id(input.councilId, 'councilId');
  const actor = id(input.actor, 'actor');
  const taskId = id(input.taskId, 'taskId');
  const optionId = id(input.optionId, 'optionId');
  const idempotencyKey = key(input.idempotencyKey);
  const summary = text(input.summary, 'summary');
  if (!Array.isArray(input.refs) || input.refs.length < 1 || input.refs.length > PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs) {
    throw new Error(`refs must contain 1-${PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs} entries`);
  }
  const refs = [...new Set(input.refs.map((value) => text(value, 'ref')))];
  const fingerprint = digest({ councilId, optionId, actor, taskId, summary, refs });
  return db.transaction(() => {
    const council = toCouncil(requireCouncilRow(db, repository, councilId));
    const existing = db.prepare(`
      SELECT * FROM coordination_priority_evidence WHERE council_id = ? AND actor = ? AND task_id = ? AND option_id = ?
    `).get(councilId, actor, taskId, optionId) as EvidenceRow | undefined;
    if (existing) {
      if (existing.idempotency_key === idempotencyKey && existing.fingerprint === fingerprint) return toEvidence(existing);
      throw new Error('Duplicate council evidence submission for actor, task, and option');
    }
    if (council.status !== 'open') throw new Error(`Priority council is ${council.status}`);
    if ((input.now ?? Date.now()) >= council.expiresAt) throw new Error('Priority council has expired');
    if (!council.options.some((option) => option.id === optionId)) throw new Error(`Unknown council option: ${optionId}`);
    const now = input.now ?? Date.now();
    const evidenceId = randomUUID();
    db.prepare(`
      INSERT INTO coordination_priority_evidence(
        evidence_id, council_id, option_id, actor, actor_name, actor_role, task_id, task_label,
        summary, refs_json, idempotency_key, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidenceId, councilId, optionId, actor,
      input.actorName ? text(input.actorName, 'actorName', MAX_ID) : null,
      input.actorRole ? text(input.actorRole, 'actorRole', 80) : null,
      taskId, input.taskLabel ? text(input.taskLabel, 'taskLabel', MAX_ID) : null,
      summary, JSON.stringify(refs), idempotencyKey, fingerprint, now,
    );
    db.prepare(`UPDATE coordination_priority_councils SET version = version + 1, updated_at = ? WHERE council_id = ?`)
      .run(now, councilId);
    return toEvidence(db.prepare(`SELECT * FROM coordination_priority_evidence WHERE evidence_id = ?`)
      .get(evidenceId) as EvidenceRow);
  }).immediate();
}

/** Record exactly one equal-weight ranked ballot per trusted actor+task identity. */
export function castPriorityCouncilBallot(input: CastPriorityCouncilBallotInput): PriorityCouncilBallot {
  const db = database();
  const repository = id(input.repository, 'repository');
  const councilId = id(input.councilId, 'councilId');
  const actor = id(input.actor, 'actor');
  const taskId = id(input.taskId, 'taskId');
  const actorRole = input.actorRole ? text(input.actorRole, 'actorRole', 80) : '';
  const idempotencyKey = key(input.idempotencyKey);
  const snapshotVersion = id(input.snapshotVersion, 'snapshotVersion');
  if (!Number.isFinite(input.confidence) || input.confidence <= 0 || input.confidence > 1) {
    throw new Error('confidence must be greater than 0 and at most 1');
  }
  const confidence = input.confidence;
  const ranking = input.ranking.map((value) => id(value, 'ranking option'));
  const evidenceIds = [...new Set(input.evidenceIds.map((value) => id(value, 'evidenceId')))];
  const fingerprint = digest({ councilId, actor, actorRole, taskId, ranking, confidence, evidenceIds, snapshotVersion });

  return db.transaction(() => {
    const row = requireCouncilRow(db, repository, councilId);
    const existing = db.prepare(`
      SELECT * FROM coordination_priority_ballots WHERE council_id = ? AND actor = ? AND task_id = ?
    `).get(councilId, actor, taskId) as BallotRow | undefined;
    if (existing) {
      if (existing.idempotency_key === idempotencyKey && existing.fingerprint === fingerprint) return toBallot(existing);
      throw new Error('Duplicate council ballot for actor and task');
    }
    const council = toCouncil(row);
    if (council.status !== 'open') throw new Error(`Priority council is ${council.status}`);
    const now = input.now ?? Date.now();
    if (now >= council.expiresAt) throw new Error('Priority council has expired');
    if (snapshotVersion !== council.snapshotVersion) throw new Error('Council ballot uses a stale tracker snapshot');
    if (council.options.some((option) => option.taskId === taskId)) {
      throw new Error('Self-vote is not allowed for a candidate task');
    }
    const eligible = council.eligibleVoters.find((voter) => voter.actor === actor && voter.taskId === taskId);
    if (!eligible) throw new Error('Actor and task are not eligible for this council');
    if (eligible.actorRole !== actorRole) throw new Error('Council voter role does not match the active-peer snapshot');
    const optionIds = council.options.map((option) => option.id);
    if (ranking.length !== optionIds.length
      || new Set(ranking).size !== optionIds.length
      || optionIds.some((optionId) => !ranking.includes(optionId))) {
      throw new Error('Ballot ranking must contain every council option exactly once');
    }
    if (evidenceIds.length < 1 || evidenceIds.length > PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs) {
      throw new Error(`Ballot must cite 1-${PRIORITY_COUNCIL_LIMITS.maxEvidenceRefs} evidence records`);
    }
    const evidenceOption = new Map<string, string>();
    for (const option of council.options) {
      for (const evidenceId of option.evidenceIds) evidenceOption.set(evidenceId, option.id);
    }
    for (const evidence of evidenceRows(db, councilId)) evidenceOption.set(evidence.evidence_id, evidence.option_id);
    if (evidenceIds.some((evidenceId) => !evidenceOption.has(evidenceId))) {
      throw new Error('Ballot cites unknown council evidence');
    }
    if (!evidenceIds.some((evidenceId) => evidenceOption.get(evidenceId) === ranking[0])) {
      throw new Error('Ballot must cite evidence for its first-ranked option');
    }
    const ballotId = randomUUID();
    try {
      db.prepare(`
        INSERT INTO coordination_priority_ballots(
          ballot_id, council_id, actor, actor_name, actor_role, task_id, task_label,
          ranking_json, confidence, evidence_ids_json, snapshot_version,
          idempotency_key, fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ballotId, councilId, actor,
        input.actorName ? text(input.actorName, 'actorName', MAX_ID) : null,
        actorRole, taskId, input.taskLabel ? text(input.taskLabel, 'taskLabel', MAX_ID) : null,
        JSON.stringify(ranking), confidence, JSON.stringify(evidenceIds), snapshotVersion,
        idempotencyKey, fingerprint, now,
      );
    } catch (error) {
      if (error instanceof Error && /coordination_priority_ballots\.council_id, coordination_priority_ballots\.idempotency_key/i.test(error.message)) {
        throw new Error('Council ballot idempotency key collision');
      }
      throw error;
    }
    db.prepare(`UPDATE coordination_priority_councils SET version = version + 1, updated_at = ? WHERE council_id = ?`)
      .run(now, councilId);
    return toBallot(db.prepare(`SELECT * FROM coordination_priority_ballots WHERE ballot_id = ?`)
      .get(ballotId) as BallotRow);
  }).immediate();
}

function quorumReasons(council: PriorityCouncil, ballots: PriorityCouncilBallot[]): string[] {
  const reasons: string[] = [];
  if (ballots.length < council.requiredQuorum) reasons.push(`ballots:${ballots.length}/${council.requiredQuorum}`);
  const actors = new Set(ballots.map((ballot) => ballot.actor)).size;
  if (actors < 2) reasons.push(`actors:${actors}/2`);
  const tasks = new Set(ballots.map((ballot) => ballot.taskId)).size;
  if (tasks < council.requiredTaskQuorum) reasons.push(`tasks:${tasks}/${council.requiredTaskQuorum}`);
  const roles = new Set(ballots.map((ballot) => ballot.actorRole)).size;
  if (roles < council.requiredRoleQuorum) reasons.push(`roles:${roles}/${council.requiredRoleQuorum}`);
  return reasons.sort();
}

function tally(council: PriorityCouncil, ballots: PriorityCouncilBallot[]): {
  entries: PriorityCouncilTallyEntry[];
  rankedOptionIds: string[];
  tieOptionIds: string[];
  selectedOptionId: string;
  outcome: 'selected' | 'tie-break';
  evidenceIds: string[];
} {
  const entries = council.options.map((option, proposalOrder) => ({
    optionId: option.id,
    points: 0,
    firstChoiceCount: 0,
    proposalOrder,
  }));
  const byId = new Map(entries.map((entry) => [entry.optionId, entry]));
  for (const ballot of ballots) {
    ballot.ranking.forEach((optionId, index) => {
      const entry = byId.get(optionId)!;
      // Confidence is audit evidence, never vote weight: each eligible
      // actor+task has exactly one equal ballot and cannot buy influence by
      // claiming certainty.
      entry.points += ballot.ranking.length - index;
      if (index === 0) entry.firstChoiceCount += 1;
    });
  }
  entries.sort((a, b) =>
    b.points - a.points
    || b.firstChoiceCount - a.firstChoiceCount
    || a.proposalOrder - b.proposalOrder
    || a.optionId.localeCompare(b.optionId));
  const top = entries[0];
  const tieOptionIds = entries
    .filter((entry) => entry.points === top.points && entry.firstChoiceCount === top.firstChoiceCount)
    .map((entry) => entry.optionId);
  return {
    entries,
    rankedOptionIds: entries.map((entry) => entry.optionId),
    tieOptionIds,
    selectedOptionId: top.optionId,
    outcome: tieOptionIds.length > 1 ? 'tie-break' : 'selected',
    evidenceIds: [...new Set(ballots.flatMap((ballot) => ballot.evidenceIds))].sort(),
  };
}

/** Finalize with a version CAS. Before expiry, missing quorum is a no-op error. */
export function finalizePriorityCouncil(input: FinalizePriorityCouncilInput): PriorityCouncil {
  const db = database();
  const repository = id(input.repository, 'repository');
  const councilId = id(input.councilId, 'councilId');
  const actor = id(input.actor, 'actor');
  const taskId = id(input.taskId, 'taskId');
  const idempotencyKey = key(input.idempotencyKey);
  integer(input.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
  const finalizationFingerprint = digest({ councilId, expectedVersion: input.expectedVersion, actor, taskId });
  const now = input.now ?? Date.now();

  return db.transaction(() => {
    const row = requireCouncilRow(db, repository, councilId);
    if (row.status !== 'open') {
      if (row.finalization_idempotency_key === idempotencyKey
        && row.finalization_fingerprint === finalizationFingerprint) return toCouncil(row);
      throw new Error(`Priority council is ${row.status}`);
    }
    if (row.version !== input.expectedVersion) throw new Error('Priority council version conflict');
    const council = toCouncil(row);
    const ballots = ballotRows(db, councilId).map(toBallot);
    const missing = quorumReasons(council, ballots);
    if (missing.length > 0 && now < council.expiresAt) {
      throw new Error(`Priority council quorum not reached (${missing.join(', ')})`);
    }

    let status: PriorityCouncilStatus;
    let outcome: PriorityCouncilOutcome;
    let selectedOptionId: string | null = null;
    let rankedOptionIds: string[] = [];
    let tieOptionIds: string[] = [];
    let tallyEntries: PriorityCouncilTallyEntry[] = [];
    let evidenceIds: string[] = [];
    if (missing.length > 0) {
      status = 'expired';
      outcome = 'no-quorum';
    } else {
      status = 'finalized';
      const result = tally(council, ballots);
      outcome = result.outcome;
      selectedOptionId = result.selectedOptionId;
      rankedOptionIds = result.rankedOptionIds;
      tieOptionIds = result.tieOptionIds;
      tallyEntries = result.entries;
      evidenceIds = result.evidenceIds;
    }
    const updated = db.prepare(`
      UPDATE coordination_priority_councils
      SET status = ?, outcome = ?, version = version + 1,
          selected_option_id = ?, ranked_option_ids_json = ?, tie_option_ids_json = ?, tally_json = ?,
          decision_evidence_ids_json = ?, no_quorum_reasons_json = ?,
          finalization_idempotency_key = ?, finalization_fingerprint = ?,
          updated_at = ?, finalized_at = ?, finalized_by_actor = ?, finalized_by_task_id = ?
      WHERE repository = ? AND council_id = ? AND status = 'open' AND version = ?
    `).run(
      status, outcome, selectedOptionId, JSON.stringify(rankedOptionIds), JSON.stringify(tieOptionIds),
      JSON.stringify(tallyEntries), JSON.stringify(evidenceIds), JSON.stringify(missing),
      idempotencyKey, finalizationFingerprint, now, now, actor, taskId,
      repository, councilId, input.expectedVersion,
    );
    if (updated.changes !== 1) throw new Error('Priority council version conflict');
    return toCouncil(requireCouncilRow(db, repository, councilId));
  }).immediate();
}

export function getPriorityCouncil(input: { repository: string; councilId: string }): PriorityCouncilDetail {
  const db = database();
  const repository = id(input.repository, 'repository');
  const councilId = id(input.councilId, 'councilId');
  return {
    council: toCouncil(requireCouncilRow(db, repository, councilId)),
    ballots: ballotRows(db, councilId).map(toBallot),
    evidenceSubmissions: evidenceRows(db, councilId).map(toEvidence),
    consumptions: (db.prepare(`
      SELECT * FROM coordination_priority_consumptions WHERE council_id = ? ORDER BY consumed_at, consumption_id
    `).all(councilId) as ConsumptionRow[]).map(toConsumption),
  };
}

export function listPriorityCouncils(input: {
  repository: string;
  threadId?: string;
  status?: PriorityCouncilStatus;
  limit?: number;
}): PriorityCouncil[] {
  const db = database();
  const repository = id(input.repository, 'repository');
  const where = ['c.repository = ?'];
  const params: Array<string | number> = [repository];
  if (input.threadId) {
    where.push('c.thread_id = ?');
    params.push(id(input.threadId, 'threadId'));
  }
  if (input.status) {
    if (!['open', 'finalized', 'expired'].includes(input.status)) throw new Error('Invalid council status');
    where.push('c.status = ?');
    params.push(input.status);
  }
  const limit = integer(Math.trunc(input.limit ?? 50), 'limit', 1, 100);
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM coordination_priority_ballots b WHERE b.council_id = c.council_id) AS ballot_count,
      (SELECT COUNT(*) FROM coordination_priority_evidence e WHERE e.council_id = c.council_id) AS evidence_submission_count,
      (SELECT COUNT(*) FROM coordination_priority_consumptions x WHERE x.council_id = c.council_id) AS consumption_count
    FROM coordination_priority_councils c
    WHERE ${where.join(' AND ')}
    ORDER BY c.updated_at DESC, c.council_id DESC LIMIT ?
  `).all(...params, limit) as CouncilRow[];
  return rows.map(toCouncil);
}

/**
 * Bounded internal lookup for the decision engine. It never calls the tracker
 * and returns only finalized, selected councils whose entire cohort is present
 * in the caller's already-fetched task snapshot.
 */
export function listPriorityCouncilRankingCandidates(
  repositories: readonly string[],
  taskIds: readonly string[],
  limit = 50,
): PriorityCouncil[] {
  if (repositories.length === 0 || repositories.length > 100
    || taskIds.length < PRIORITY_COUNCIL_LIMITS.minOptions || taskIds.length > 2_000) return [];
  const scopedRepositories = [...new Set(repositories.map((repository) => id(repository, 'repository')))];
  const available = new Set(taskIds.map((taskId) => id(taskId, 'taskId')));
  const boundedLimit = integer(Math.trunc(limit), 'limit', 1, 100);
  const rows = database().prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM coordination_priority_ballots b WHERE b.council_id = c.council_id) AS ballot_count,
      (SELECT COUNT(*) FROM coordination_priority_evidence e WHERE e.council_id = c.council_id) AS evidence_submission_count,
      (SELECT COUNT(*) FROM coordination_priority_consumptions x WHERE x.council_id = c.council_id) AS consumption_count
    FROM coordination_priority_councils c
    WHERE c.repository IN (${scopedRepositories.map(() => '?').join(',')})
      AND c.status = 'finalized' AND c.outcome IN ('selected', 'tie-break')
    ORDER BY c.finalized_at DESC, c.council_id DESC LIMIT ?
  `).all(...scopedRepositories, boundedLimit) as CouncilRow[];
  return rows.map(toCouncil).filter((council) =>
    council.options.length >= PRIORITY_COUNCIL_LIMITS.minOptions
    && council.options.every((option) => available.has(option.taskId)),
  );
}

function rankingSignal(council: PriorityCouncil): AdvisoryPriorityRankingSignal {
  if (council.status !== 'finalized'
    || (council.outcome !== 'selected' && council.outcome !== 'tie-break')
    || !council.selectedOptionId) {
    throw new Error('Priority council has no consumable advisory ranking');
  }
  const optionById = new Map(council.options.map((option) => [option.id, option]));
  const rankedTaskIds = council.rankedOptionIds.map((optionId) => optionById.get(optionId)?.taskId);
  if (rankedTaskIds.some((taskId) => !taskId)) throw new Error('Priority council ranking is corrupt');
  return {
    schemaVersion: 1,
    councilId: council.id,
    threadId: council.threadId,
    councilVersion: council.version,
    snapshotVersion: council.snapshotVersion,
    outcome: council.outcome,
    selectedOptionId: council.selectedOptionId,
    rankedOptionIds: [...council.rankedOptionIds],
    rankedTaskIds: rankedTaskIds as string[],
    evidenceIds: [...council.decisionEvidenceIds],
    authority: ADVISORY_RANKING_AUTHORITY,
  };
}

/**
 * Consume one immutable ranking decision with an INSERT...SELECT version CAS.
 *
 * The council is not mutated: scheduler and orchestrator each keep their own
 * idempotent consumption row, while the WHERE clause proves that the exact
 * finalized version and cached tracker snapshot were still current.
 */
export function consumePriorityCouncilRanking(input: {
  repository: string;
  councilId: string;
  expectedCouncilVersion: number;
  currentSnapshotVersion: string;
  consumer: string;
  consumerTaskId: string;
  consumerRole: 'scheduler' | 'orchestrator';
  now?: number;
}): { signal: AdvisoryPriorityRankingSignal; consumption: PriorityCouncilConsumption } {
  const db = database();
  const repository = id(input.repository, 'repository');
  const councilId = id(input.councilId, 'councilId');
  const consumer = id(input.consumer, 'consumer');
  const consumerTaskId = id(input.consumerTaskId, 'consumerTaskId');
  const snapshotVersion = id(input.currentSnapshotVersion, 'currentSnapshotVersion');
  integer(input.expectedCouncilVersion, 'expectedCouncilVersion', 1, Number.MAX_SAFE_INTEGER);
  if (input.consumerRole !== 'scheduler' && input.consumerRole !== 'orchestrator') {
    throw new Error('Council ranking consumer must be scheduler or orchestrator');
  }
  return db.transaction(() => {
    const council = toCouncil(requireCouncilRow(db, repository, councilId));
    const signal = rankingSignal(council);
    const existing = db.prepare(`
      SELECT * FROM coordination_priority_consumptions
      WHERE council_id = ? AND consumer = ? AND consumer_task_id = ?
    `).get(councilId, consumer, consumerTaskId) as ConsumptionRow | undefined;
    if (existing) {
      if (existing.council_version !== input.expectedCouncilVersion
        || existing.snapshot_version !== snapshotVersion
        || existing.consumer_role !== input.consumerRole) {
        throw new Error('Council ranking consumption identity collision');
      }
      return { signal, consumption: toConsumption(existing) };
    }
    const consumptionId = randomUUID();
    const inserted = db.prepare(`
      INSERT INTO coordination_priority_consumptions(
        consumption_id, council_id, consumer, consumer_task_id, consumer_role,
        council_version, snapshot_version, consumed_at
      )
      SELECT ?, c.council_id, ?, ?, ?, c.version, c.snapshot_version, ?
      FROM coordination_priority_councils c
      WHERE c.repository = ? AND c.council_id = ? AND c.status = 'finalized'
        AND c.outcome IN ('selected', 'tie-break') AND c.version = ? AND c.snapshot_version = ?
    `).run(
      consumptionId, consumer, consumerTaskId, input.consumerRole, input.now ?? Date.now(),
      repository, councilId, input.expectedCouncilVersion, snapshotVersion,
    );
    if (inserted.changes !== 1) {
      if (council.version !== input.expectedCouncilVersion) throw new Error('Priority council version conflict');
      if (council.snapshotVersion !== snapshotVersion) throw new Error('Priority council snapshot is stale');
      throw new Error('Priority council ranking is not consumable');
    }
    const row = db.prepare(`SELECT * FROM coordination_priority_consumptions WHERE consumption_id = ?`)
      .get(consumptionId) as ConsumptionRow;
    return { signal, consumption: toConsumption(row) };
  }).immediate();
}

function validAuthority(signal: AdvisoryPriorityRankingSignal): boolean {
  const authority = signal.authority;
  return authority?.advisoryOnly === true
    && authority.allowedEffect === 'stable-ranking-within-council-cohort'
    && authority.canStartTask === false
    && authority.canBypassDependencies === false
    && authority.canBypassFileLeases === false
    && authority.canMerge === false
    && authority.canUseDestructiveTools === false
    && authority.canMutateTracker === false;
}

/**
 * Apply the signal only inside the cohort's existing slots.
 *
 * Callers must first perform their normal readiness/dependency/lease filters
 * and pass the resulting deterministic tie cohort. A malformed, stale, or
 * partial cohort fails closed to the original order; this helper never adds,
 * drops, starts, or otherwise mutates a task.
 */
export function applyAdvisoryPriorityRanking<T>(
  tasks: readonly T[],
  signal: AdvisoryPriorityRankingSignal,
  taskId: (task: T) => string,
): { tasks: T[]; applied: boolean; reason?: string } {
  const original = [...tasks];
  if (!validAuthority(signal)) return { tasks: original, applied: false, reason: 'authority-contract-mismatch' };
  if (signal.schemaVersion !== 1 || !['selected', 'tie-break'].includes(signal.outcome)) {
    return { tasks: original, applied: false, reason: 'unsupported-signal' };
  }
  const ranked = signal.rankedTaskIds;
  if (ranked.length < PRIORITY_COUNCIL_LIMITS.minOptions
    || ranked.length > PRIORITY_COUNCIL_LIMITS.maxOptions
    || new Set(ranked).size !== ranked.length) {
    return { tasks: original, applied: false, reason: 'invalid-cohort' };
  }
  const byTask = new Map<string, T>();
  for (const task of tasks) {
    const id = taskId(task);
    if (byTask.has(id)) return { tasks: original, applied: false, reason: 'duplicate-task' };
    byTask.set(id, task);
  }
  if (ranked.some((id) => !byTask.has(id))) {
    return { tasks: original, applied: false, reason: 'cohort-mismatch' };
  }
  const cohort = new Set(ranked);
  let next = 0;
  const reordered = original.map((task) => cohort.has(taskId(task)) ? byTask.get(ranked[next++])! : task);
  return { tasks: reordered, applied: true };
}
