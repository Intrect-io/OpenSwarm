// ============================================
// OpenSwarm - Durable repository discussion threads
// ============================================
//
// The live coordination JSON file is an intentionally bounded inbox. It is not
// an authority for a discussion that several tasks may join over hours or
// across daemon restarts. Threads live beside the run ledger and coordination
// trace in automation.db; the live board only announces their mutations.

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getTraceDb } from './coordinationTrace.js';

export type CoordinationThreadStatus = 'open' | 'resolved';

export interface ThreadParticipant {
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  followedAt: number;
  lastReadSeq: number;
}

export interface CoordinationThread {
  id: string;
  repository: string;
  subject: string;
  status: CoordinationThreadStatus;
  version: number;
  createdByActor: string;
  createdByTaskId: string;
  relatedTaskIds: string[];
  relatedFiles: string[];
  relatedPullRequests: string[];
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolvedByActor?: string;
  resolvedByTaskId?: string;
  messageCount: number;
  participantCount: number;
  unreadCount?: number;
}

export interface CoordinationThreadMessage {
  id: string;
  seq: number;
  threadId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  body: string;
  createdAt: number;
}

export interface CreateThreadInput {
  repository: string;
  subject: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  body?: string;
  relatedTaskIds?: string[];
  relatedFiles?: string[];
  relatedPullRequests?: string[];
  idempotencyKey?: string;
  now?: number;
}

export interface PostThreadMessageInput {
  repository: string;
  threadId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  body: string;
  idempotencyKey?: string;
  now?: number;
}

export interface ThreadPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface ThreadDetail {
  thread: CoordinationThread;
  participants: ThreadParticipant[];
  messages: ThreadPage<CoordinationThreadMessage>;
}

const MAX_SUBJECT = 240;
const MAX_BODY = 4_000;
const MAX_RELATED = 32;
const MAX_PARTICIPANTS = 64;
const MAX_MESSAGES_PER_THREAD = 1_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_IDEMPOTENCY_KEY = 160;
const SECRET_VALUE = /(bearer\s+[A-Za-z0-9._~+/-]+|(?:sk|ghp|xox[baprs])_?[-A-Za-z0-9_]{8,})/gi;

interface ThreadRow {
  thread_id: string;
  repository: string;
  subject: string;
  status: CoordinationThreadStatus;
  version: number;
  created_by_actor: string;
  created_by_task_id: string;
  related_task_ids_json: string;
  related_files_json: string;
  related_prs_json: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by_actor: string | null;
  resolved_by_task_id: string | null;
  message_count: number;
  participant_count: number;
  unread_count?: number | null;
  fingerprint: string;
}

interface MessageRow {
  message_id: string;
  seq: number;
  thread_id: string;
  actor: string;
  actor_name: string | null;
  actor_role: string | null;
  task_id: string;
  task_label: string | null;
  body: string;
  created_at: number;
  fingerprint: string;
}

interface ParticipantRow {
  actor: string;
  actor_name: string | null;
  actor_role: string | null;
  task_id: string;
  task_label: string | null;
  followed_at: number;
  last_read_seq: number;
}

function database(): Database.Database {
  const handle = getTraceDb();
  if (!handle) throw new Error('Coordination thread store is unavailable');
  migrate(handle);
  return handle;
}

function migrate(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_threads (
      thread_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      version INTEGER NOT NULL DEFAULT 1,
      created_by_actor TEXT NOT NULL,
      created_by_task_id TEXT NOT NULL,
      related_task_ids_json TEXT NOT NULL DEFAULT '[]',
      related_files_json TEXT NOT NULL DEFAULT '[]',
      related_prs_json TEXT NOT NULL DEFAULT '[]',
      create_idempotency_key TEXT,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by_actor TEXT,
      resolved_by_task_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS coordination_threads_create_key
      ON coordination_threads(repository, created_by_actor, created_by_task_id, create_idempotency_key)
      WHERE create_idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS coordination_threads_repository_updated
      ON coordination_threads(repository, updated_at DESC, thread_id DESC);

    CREATE TABLE IF NOT EXISTS coordination_thread_tasks (
      thread_id TEXT NOT NULL REFERENCES coordination_threads(thread_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      PRIMARY KEY(thread_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS coordination_thread_tasks_task
      ON coordination_thread_tasks(task_id, thread_id);

    CREATE TABLE IF NOT EXISTS coordination_thread_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL REFERENCES coordination_threads(thread_id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      task_id TEXT NOT NULL,
      task_label TEXT,
      body TEXT NOT NULL,
      idempotency_key TEXT,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS coordination_thread_message_key
      ON coordination_thread_messages(thread_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS coordination_thread_messages_thread_seq
      ON coordination_thread_messages(thread_id, seq);

    CREATE TABLE IF NOT EXISTS coordination_thread_subscriptions (
      thread_id TEXT NOT NULL REFERENCES coordination_threads(thread_id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      task_id TEXT NOT NULL,
      task_label TEXT,
      followed_at INTEGER NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(thread_id, actor, task_id)
    );
    CREATE INDEX IF NOT EXISTS coordination_thread_subscriptions_actor
      ON coordination_thread_subscriptions(actor, task_id, thread_id);
  `);
}

function boundedText(value: string, field: string, max: number): string {
  const clean = value.trim().replace(SECRET_VALUE, '[redacted]');
  if (!clean) throw new Error(`${field} must be non-empty`);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return clean;
}

function identity(value: string, field: string): string {
  return boundedText(value, field, 240);
}

function optionalText(value: string | undefined, field: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, field, max);
}

function repository(value: string): string {
  // This is the repository CELL identity, not necessarily a filesystem path.
  // `repositoryKey()` deliberately produces an opaque `git:<digest>` key, and
  // path resolution here would corrupt it into a cwd-relative pseudo-path.
  return identity(value, 'repository');
}

function idempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, 'idempotencyKey', MAX_IDEMPOTENCY_KEY);
}

function related(values: string[] | undefined, field: string, normalizePath = false): string[] {
  if (!values) return [];
  if (values.length > MAX_RELATED) throw new Error(`${field} exceeds ${MAX_RELATED} entries`);
  const out = new Set<string>();
  for (const item of values) {
    let clean = boundedText(item, field, 500);
    if (normalizePath) {
      clean = clean.replace(/\\/g, '/').replace(/^\.\//, '');
      if (clean.startsWith('/') || /^[A-Za-z]:\//.test(clean) || clean.split('/').includes('..')) {
        throw new Error(`${field} must contain repository-relative paths`);
      }
    }
    out.add(clean);
  }
  return [...out];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toThread(row: ThreadRow): CoordinationThread {
  return {
    id: row.thread_id,
    repository: row.repository,
    subject: row.subject,
    status: row.status,
    version: row.version,
    createdByActor: row.created_by_actor,
    createdByTaskId: row.created_by_task_id,
    relatedTaskIds: parseArray(row.related_task_ids_json),
    relatedFiles: parseArray(row.related_files_json),
    relatedPullRequests: parseArray(row.related_prs_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedByActor: row.resolved_by_actor ?? undefined,
    resolvedByTaskId: row.resolved_by_task_id ?? undefined,
    messageCount: row.message_count,
    participantCount: row.participant_count,
    ...(row.unread_count === undefined ? {} : { unreadCount: row.unread_count ?? 0 }),
  };
}

function toMessage(row: MessageRow): CoordinationThreadMessage {
  return {
    id: row.message_id,
    seq: row.seq,
    threadId: row.thread_id,
    actor: row.actor,
    actorName: row.actor_name ?? undefined,
    actorRole: row.actor_role ?? undefined,
    taskId: row.task_id,
    taskLabel: row.task_label ?? undefined,
    body: row.body,
    createdAt: row.created_at,
  };
}

function toParticipant(row: ParticipantRow): ThreadParticipant {
  return {
    actor: row.actor,
    actorName: row.actor_name ?? undefined,
    actorRole: row.actor_role ?? undefined,
    taskId: row.task_id,
    taskLabel: row.task_label ?? undefined,
    followedAt: row.followed_at,
    lastReadSeq: row.last_read_seq,
  };
}

function getThreadRow(db: Database.Database, repo: string, threadId: string): ThreadRow | undefined {
  return db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM coordination_thread_messages m WHERE m.thread_id = t.thread_id) AS message_count,
      (SELECT COUNT(*) FROM coordination_thread_subscriptions s WHERE s.thread_id = t.thread_id) AS participant_count
    FROM coordination_threads t
    WHERE t.repository = ? AND t.thread_id = ?
  `).get(repo, threadId) as ThreadRow | undefined;
}

function requireThreadRow(db: Database.Database, repo: string, threadId: string): ThreadRow {
  const row = getThreadRow(db, repo, threadId);
  if (!row) throw new Error(`Coordination thread not found: ${threadId}`);
  return row;
}

function participantCount(db: Database.Database, threadId: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM coordination_thread_subscriptions WHERE thread_id = ?
  `).get(threadId) as { count: number }).count;
}

function ensureParticipant(
  db: Database.Database,
  threadId: string,
  input: { actor: string; actorName?: string; actorRole?: string; taskId: string; taskLabel?: string },
  now: number,
): boolean {
  const actor = identity(input.actor, 'actor');
  const taskId = identity(input.taskId, 'taskId');
  const existing = db.prepare(`
    SELECT 1 FROM coordination_thread_subscriptions WHERE thread_id = ? AND actor = ? AND task_id = ?
  `).get(threadId, actor, taskId);
  if (existing) {
    db.prepare(`
      UPDATE coordination_thread_subscriptions
      SET actor_name = COALESCE(?, actor_name), actor_role = COALESCE(?, actor_role),
          task_label = COALESCE(?, task_label)
      WHERE thread_id = ? AND actor = ? AND task_id = ?
    `).run(
      optionalText(input.actorName, 'actorName', 240) ?? null,
      optionalText(input.actorRole, 'actorRole', 80) ?? null,
      optionalText(input.taskLabel, 'taskLabel', 240) ?? null,
      threadId, actor, taskId,
    );
    return false;
  }
  if (participantCount(db, threadId) >= MAX_PARTICIPANTS) {
    throw new Error(`Coordination thread participant limit reached (${MAX_PARTICIPANTS})`);
  }
  const latestSeq = (db.prepare(`
    SELECT COALESCE(MAX(seq), 0) AS seq FROM coordination_thread_messages WHERE thread_id = ?
  `).get(threadId) as { seq: number }).seq;
  db.prepare(`
    INSERT INTO coordination_thread_subscriptions(
      thread_id, actor, actor_name, actor_role, task_id, task_label, followed_at, last_read_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    threadId,
    actor,
    optionalText(input.actorName, 'actorName', 240) ?? null,
    optionalText(input.actorRole, 'actorRole', 80) ?? null,
    taskId,
    optionalText(input.taskLabel, 'taskLabel', 240) ?? null,
    now,
    latestSeq,
  );
  return true;
}

function insertMessage(db: Database.Database, input: PostThreadMessageInput): CoordinationThreadMessage {
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  const thread = requireThreadRow(db, repo, threadId);
  if (thread.status !== 'open') throw new Error(`Coordination thread is ${thread.status}`);
  const actor = identity(input.actor, 'actor');
  const taskId = identity(input.taskId, 'taskId');
  const actorName = optionalText(input.actorName, 'actorName', 240);
  const actorRole = optionalText(input.actorRole, 'actorRole', 80);
  const taskLabel = optionalText(input.taskLabel, 'taskLabel', 240);
  const body = boundedText(input.body, 'body', MAX_BODY);
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = digest({ threadId, actor, taskId, body });
  if (key) {
    const existing = db.prepare(`
      SELECT * FROM coordination_thread_messages WHERE thread_id = ? AND idempotency_key = ?
    `).get(threadId, key) as MessageRow | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Thread message idempotency key collision');
      return toMessage(existing);
    }
  }
  const count = (db.prepare(`
    SELECT COUNT(*) AS count FROM coordination_thread_messages WHERE thread_id = ?
  `).get(threadId) as { count: number }).count;
  if (count >= MAX_MESSAGES_PER_THREAD) {
    throw new Error(`Coordination thread message limit reached (${MAX_MESSAGES_PER_THREAD})`);
  }
  const now = input.now ?? Date.now();
  ensureParticipant(db, threadId, input, now);
  const messageId = randomUUID();
  const result = db.prepare(`
    INSERT INTO coordination_thread_messages(
      message_id, thread_id, actor, actor_name, actor_role, task_id, task_label,
      body, idempotency_key, fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId,
    threadId,
    actor,
    actorName ?? null,
    actorRole ?? null,
    taskId,
    taskLabel ?? null,
    body,
    key ?? null,
    fingerprint,
    now,
  );
  db.prepare(`
    UPDATE coordination_threads SET version = version + 1, updated_at = ? WHERE thread_id = ?
  `).run(now, threadId);
  db.prepare(`
    UPDATE coordination_thread_subscriptions
    SET last_read_seq = MAX(last_read_seq, ?)
    WHERE thread_id = ? AND actor = ? AND task_id = ?
  `).run(Number(result.lastInsertRowid), threadId, actor, taskId);
  return toMessage({
    message_id: messageId,
    seq: Number(result.lastInsertRowid),
    thread_id: threadId,
    actor,
    actor_name: actorName ?? null,
    actor_role: actorRole ?? null,
    task_id: taskId,
    task_label: taskLabel ?? null,
    body,
    created_at: now,
    fingerprint,
  });
}

/** Create a durable topic and automatically follow it as the creator. */
export function createCoordinationThread(input: CreateThreadInput): CoordinationThread {
  const db = database();
  const repo = repository(input.repository);
  const subject = boundedText(input.subject, 'subject', MAX_SUBJECT);
  const actor = identity(input.actor, 'actor');
  const taskId = identity(input.taskId, 'taskId');
  const taskIds = related(input.relatedTaskIds, 'relatedTaskIds');
  if (!taskIds.includes(taskId)) taskIds.unshift(taskId);
  const files = related(input.relatedFiles, 'relatedFiles', true);
  const prs = related(input.relatedPullRequests, 'relatedPullRequests');
  const key = idempotencyKey(input.idempotencyKey);
  const body = optionalText(input.body, 'body', MAX_BODY);
  const fingerprint = digest({ repo, subject, actor, taskId, taskIds, files, prs, body });
  const now = input.now ?? Date.now();

  const create = db.transaction(() => {
    if (key) {
      const existing = db.prepare(`
        SELECT * FROM coordination_threads
        WHERE repository = ? AND created_by_actor = ? AND created_by_task_id = ?
          AND create_idempotency_key = ?
      `).get(repo, actor, taskId, key) as ThreadRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('Thread idempotency key collision');
        return toThread(requireThreadRow(db, repo, existing.thread_id));
      }
    }
    const threadId = randomUUID();
    db.prepare(`
      INSERT INTO coordination_threads(
        thread_id, repository, subject, status, version, created_by_actor, created_by_task_id,
        related_task_ids_json, related_files_json, related_prs_json,
        create_idempotency_key, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId, repo, subject, actor, taskId,
      JSON.stringify(taskIds), JSON.stringify(files), JSON.stringify(prs),
      key ?? null, fingerprint, now, now,
    );
    const insertTask = db.prepare(`
      INSERT INTO coordination_thread_tasks(thread_id, task_id) VALUES (?, ?)
    `);
    for (const relatedTaskId of taskIds) insertTask.run(threadId, relatedTaskId);
    ensureParticipant(db, threadId, input, now);
    if (body) {
      insertMessage(db, {
        repository: repo,
        threadId,
        actor,
        actorName: input.actorName,
        actorRole: input.actorRole,
        taskId,
        taskLabel: input.taskLabel,
        body,
        idempotencyKey: key ? `opening:${key}` : undefined,
        now,
      });
    }
    return toThread(requireThreadRow(db, repo, threadId));
  });
  return create.immediate();
}

/** Add one idempotent reply and follow the thread as the speaker. */
export function postCoordinationThreadMessage(input: PostThreadMessageInput): CoordinationThreadMessage {
  const db = database();
  return db.transaction(() => insertMessage(db, input)).immediate();
}

export function followCoordinationThread(input: {
  repository: string;
  threadId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
  now?: number;
}): ThreadParticipant[] {
  const db = database();
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  return db.transaction(() => {
    requireThreadRow(db, repo, threadId);
    const now = input.now ?? Date.now();
    if (ensureParticipant(db, threadId, input, now)) {
      db.prepare(`UPDATE coordination_threads SET version = version + 1, updated_at = ? WHERE thread_id = ?`)
        .run(now, threadId);
    }
    return listParticipants(db, threadId);
  }).immediate();
}

export function unfollowCoordinationThread(input: {
  repository: string;
  threadId: string;
  actor: string;
  taskId: string;
  now?: number;
}): boolean {
  const db = database();
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  const actor = identity(input.actor, 'actor');
  const taskId = identity(input.taskId, 'taskId');
  return db.transaction(() => {
    const thread = requireThreadRow(db, repo, threadId);
    if (thread.created_by_actor === actor && thread.created_by_task_id === taskId) {
      throw new Error('Thread creator cannot unfollow their own thread');
    }
    const removed = db.prepare(`
      DELETE FROM coordination_thread_subscriptions WHERE thread_id = ? AND actor = ? AND task_id = ?
    `).run(threadId, actor, taskId);
    if (removed.changes > 0) {
      db.prepare(`UPDATE coordination_threads SET version = version + 1, updated_at = ? WHERE thread_id = ?`)
        .run(input.now ?? Date.now(), threadId);
    }
    return removed.changes > 0;
  }).immediate();
}

export function markCoordinationThreadRead(input: {
  repository: string;
  threadId: string;
  actor: string;
  taskId: string;
}): number {
  const db = database();
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  requireThreadRow(db, repo, threadId);
  const latest = (db.prepare(`
    SELECT COALESCE(MAX(seq), 0) AS seq FROM coordination_thread_messages WHERE thread_id = ?
  `).get(threadId) as { seq: number }).seq;
  const updated = db.prepare(`
    UPDATE coordination_thread_subscriptions SET last_read_seq = ?
    WHERE thread_id = ? AND actor = ? AND task_id = ?
  `).run(latest, threadId, identity(input.actor, 'actor'), identity(input.taskId, 'taskId'));
  if (updated.changes === 0) throw new Error('Thread participant is not subscribed');
  return latest;
}

export function resolveCoordinationThread(input: {
  repository: string;
  threadId: string;
  expectedVersion: number;
  actor: string;
  taskId: string;
  now?: number;
}): CoordinationThread {
  const db = database();
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  const actor = identity(input.actor, 'actor');
  const taskId = identity(input.taskId, 'taskId');
  const current = requireThreadRow(db, repo, threadId);
  if (current.status === 'resolved') return toThread(current);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }
  const now = input.now ?? Date.now();
  const result = db.prepare(`
    UPDATE coordination_threads
    SET status = 'resolved', version = version + 1, updated_at = ?, resolved_at = ?,
        resolved_by_actor = ?, resolved_by_task_id = ?
    WHERE repository = ? AND thread_id = ? AND version = ? AND status = 'open'
  `).run(now, now, actor, taskId, repo, threadId, input.expectedVersion);
  if (result.changes === 0) throw new Error('Thread version conflict');
  return toThread(requireThreadRow(db, repo, threadId));
}

function listParticipants(db: Database.Database, threadId: string): ThreadParticipant[] {
  const rows = db.prepare(`
    SELECT actor, actor_name, actor_role, task_id, task_label, followed_at, last_read_seq
    FROM coordination_thread_subscriptions
    WHERE thread_id = ? ORDER BY followed_at, actor, task_id
  `).all(threadId) as ParticipantRow[];
  return rows.map(toParticipant);
}

function encodeThreadCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), 'utf8').toString('base64url');
}

function decodeThreadCursor(cursor: string): [number, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'number' || typeof parsed[1] !== 'string') {
      throw new Error('shape');
    }
    return [parsed[0], parsed[1]];
  } catch {
    throw new Error('Invalid thread cursor');
  }
}

export function listCoordinationThreads(input: {
  repository: string;
  status?: CoordinationThreadStatus;
  relatedTaskId?: string;
  participant?: { actor: string; taskId: string };
  limit?: number;
  cursor?: string;
}): ThreadPage<CoordinationThread> {
  const db = database();
  const repo = repository(input.repository);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const where = ['t.repository = ?'];
  const params: Array<string | number> = [repo];
  if (input.status) {
    where.push('t.status = ?');
    params.push(input.status);
  }
  if (input.relatedTaskId) {
    where.push(`EXISTS (
      SELECT 1 FROM coordination_thread_tasks rt
      WHERE rt.thread_id = t.thread_id AND rt.task_id = ?
    )`);
    params.push(identity(input.relatedTaskId, 'relatedTaskId'));
  }
  if (input.participant) {
    where.push(`EXISTS (
      SELECT 1 FROM coordination_thread_subscriptions ps
      WHERE ps.thread_id = t.thread_id AND ps.actor = ? AND ps.task_id = ?
    )`);
    params.push(identity(input.participant.actor, 'actor'), identity(input.participant.taskId, 'taskId'));
  }
  if (input.cursor) {
    const [updatedAt, id] = decodeThreadCursor(input.cursor);
    where.push('(t.updated_at < ? OR (t.updated_at = ? AND t.thread_id < ?))');
    params.push(updatedAt, updatedAt, id);
  }
  const unreadSelect = input.participant
    ? `, COALESCE((
        SELECT COUNT(*) FROM coordination_thread_messages um
        WHERE um.thread_id = t.thread_id AND um.seq > COALESCE((
          SELECT us.last_read_seq FROM coordination_thread_subscriptions us
          WHERE us.thread_id = t.thread_id AND us.actor = ? AND us.task_id = ?
        ), 0)
      ), 0) AS unread_count`
    : '';
  const unreadParams = input.participant
    ? [identity(input.participant.actor, 'actor'), identity(input.participant.taskId, 'taskId')]
    : [];
  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM coordination_thread_messages m WHERE m.thread_id = t.thread_id) AS message_count,
      (SELECT COUNT(*) FROM coordination_thread_subscriptions s WHERE s.thread_id = t.thread_id) AS participant_count
      ${unreadSelect}
    FROM coordination_threads t
    WHERE ${where.join(' AND ')}
    ORDER BY t.updated_at DESC, t.thread_id DESC
    LIMIT ?
  `).all(...unreadParams, ...params, limit + 1) as ThreadRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(toThread);
  const last = page.at(-1);
  return {
    items: page,
    ...(hasMore && last ? { nextCursor: encodeThreadCursor(last.updatedAt, last.id) } : {}),
  };
}

export function getCoordinationThread(input: {
  repository: string;
  threadId: string;
  messageLimit?: number;
  messageAfterSeq?: number;
}): ThreadDetail {
  const db = database();
  const repo = repository(input.repository);
  const threadId = identity(input.threadId, 'threadId');
  const thread = toThread(requireThreadRow(db, repo, threadId));
  const limit = Math.min(Math.max(Math.trunc(input.messageLimit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const after = Math.max(0, Math.trunc(input.messageAfterSeq ?? 0));
  const rows = db.prepare(`
    SELECT * FROM coordination_thread_messages
    WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?
  `).all(threadId, after, limit + 1) as MessageRow[];
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).map(toMessage);
  return {
    thread,
    participants: listParticipants(db, threadId),
    messages: {
      items: messages,
      ...(hasMore && messages.length > 0 ? { nextCursor: String(messages.at(-1)!.seq) } : {}),
    },
  };
}
