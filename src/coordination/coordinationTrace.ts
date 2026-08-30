// ============================================
// OpenSwarm - Durable coordination trace (AGT-4006)
// ============================================
//
// The coordination board (`coordination.json`) is a bounded ring buffer: it is
// the live queue agents read from, and it deliberately forgets old events so
// the file stays small. That makes it the wrong place to answer "what happened
// on this task last week".
//
// This module mirrors every published event into an append-only table in the
// same SQLite database that already holds the run ledger, so a run's trace and
// its execution history stay joinable in one engine and survive container
// recreation on the mounted state volume. Nothing here is ever evicted.
//
// The trace is an archive, not a control path: a failure to record must never
// fail the publish that produced the event.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defaultAutomationDbPath } from '../automation/automationDbPath.js';
import { enableWalWithRetry } from '../support/sqliteWal.js';
import type Database from 'better-sqlite3';
import type { CoordinationEvent, CoordinationKind, CoordinationStatus } from './coordinationStore.js';

// This package is ESM, so `require` does not exist here. The trace loads its
// native dependency lazily — a missing or ABI-mismatched better-sqlite3 must
// degrade the archive, not crash the coordination path that agents run on.
const require = createRequire(import.meta.url);

export interface TraceQuery {
  repository?: string;
  repoKey?: string;
  taskId?: string;
  taskLabel?: string;
  correlationId?: string;
  actor?: string;
  /** Only events at or after this epoch-ms timestamp. */
  since?: number;
  /**
   * Only these kinds. Narrows what the limit applies to, so a caller after one
   * conversation is not pushed out of the window by unrelated traffic on the
   * same task.
   */
  kinds?: Array<CoordinationEvent['kind']>;
  limit?: number;
}

const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 200;

let db: Database.Database | null = null;
let openedPath: string | null = null;
let unavailable = false;

function migrate(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS coordination_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      board_seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      repository TEXT NOT NULL,
      repo_key TEXT,
      task_id TEXT NOT NULL,
      task_label TEXT,
      source_task_id TEXT,
      source_task_label TEXT,
      target_task_id TEXT,
      target_task_label TEXT,
      actor TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      recipient TEXT,
      recipient_name TEXT,
      recipient_role TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      metadata_json TEXT,
      fingerprint TEXT NOT NULL
    );
  `);
  // Existing deployments already have the v1 table. SQLite's IF NOT EXISTS
  // does not add columns, so evolve it from observed table state before any
  // index or write refers to the new routing envelope.
  const columns = new Set((handle.pragma('table_info(coordination_trace)') as Array<{ name: string }>).map((column) => column.name));
  const additions: Array<[string, string]> = [
    ['repo_key', 'TEXT'],
    ['source_task_id', 'TEXT'],
    ['source_task_label', 'TEXT'],
    ['target_task_id', 'TEXT'],
    ['target_task_label', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) handle.exec(`ALTER TABLE coordination_trace ADD COLUMN ${name} ${type}`);
  }
  handle.exec(`
    CREATE INDEX IF NOT EXISTS coordination_trace_task
      ON coordination_trace(repository, task_id, id);
    CREATE INDEX IF NOT EXISTS coordination_trace_cell_task
      ON coordination_trace(repo_key, source_task_id, target_task_id, id);
    CREATE INDEX IF NOT EXISTS coordination_trace_correlation
      ON coordination_trace(correlation_id, id);
    CREATE INDEX IF NOT EXISTS coordination_trace_time
      ON coordination_trace(timestamp);
    CREATE INDEX IF NOT EXISTS coordination_trace_label
      ON coordination_trace(task_label, id);
  `);
}

/**
 * Open (once) the trace database. Returns null when SQLite is unavailable so
 * callers degrade to a board-only view instead of crashing the daemon.
 */
export function getTraceDb(): Database.Database | null {
  const path = defaultAutomationDbPath();
  // The archive can be opened before the daemon has said where automation state
  // lives — a dashboard read is enough to do it. Rebinding here makes the
  // co-location with the run ledger hold whatever the order was, instead of
  // answering from a file the runs are not in. Safe to close between calls:
  // every read prepares its statement from a handle it took in the same call,
  // so nothing outlives one.
  if (openedPath !== null && openedPath !== path) {
    try {
      db?.close();
    } catch { // cxt-ignore: error_swallow — a handle being replaced anyway
      // Nothing to do: the handle is going away either way.
    }
    db = null;
    unavailable = false; // a different file may well open where that one did not
  }
  if (db) return db;
  if (unavailable) return null;
  openedPath = path;
  try {
    const Sqlite = require('better-sqlite3') as typeof Database;
    // better-sqlite3 will not create the parent directory, and the state
    // directory does not exist on a fresh install — without this the trace
    // silently degrades to unavailable on exactly the deployments that have
    // never recorded anything.
    mkdirSync(dirname(path), { recursive: true });
    const handle = new Sqlite(path);
    handle.pragma('busy_timeout = 5000');
    enableWalWithRetry(handle, 5000);
    migrate(handle);
    db = handle;
    return db;
  } catch (error) {
    unavailable = true;
    console.warn('[CoordinationTrace] Durable trace unavailable:', error);
    return null;
  }
}

/**
 * Record one published event. Idempotent on `event_id`, so a replayed publish
 * does not duplicate a row. Never throws.
 */
export function recordTraceEvent(event: CoordinationEvent): void {
  const handle = getTraceDb();
  if (!handle) return;
  try {
    handle.prepare(`
      INSERT OR IGNORE INTO coordination_trace(
        event_id, board_seq, timestamp, repository, repo_key, task_id, task_label,
        source_task_id, source_task_label, target_task_id, target_task_label,
        actor, actor_name, actor_role, recipient, recipient_name, recipient_role,
        kind, status, correlation_id, summary, detail, metadata_json, fingerprint
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      event.id, event.seq, event.timestamp, event.repository, event.repoKey ?? null, event.taskId,
      event.taskLabel ?? null,
      event.sourceTaskId ?? null, event.sourceTaskLabel ?? null,
      event.targetTaskId ?? null, event.targetTaskLabel ?? null,
      event.actor, event.actorName ?? null, event.actorRole ?? null,
      event.recipient ?? null, event.recipientName ?? null, event.recipientRole ?? null,
      event.kind, event.status, event.correlationId, event.summary,
      event.detail ?? null, event.metadata ? JSON.stringify(event.metadata) : null,
      event.fingerprint,
    );
  } catch (error) {
    console.warn('[CoordinationTrace] Failed to record event:', error);
  }
}

interface TraceRow {
  event_id: string; board_seq: number; timestamp: number; repository: string;
  repo_key: string | null; task_id: string; task_label: string | null;
  source_task_id: string | null; source_task_label: string | null;
  target_task_id: string | null; target_task_label: string | null;
  actor: string; actor_name: string | null;
  actor_role: string | null; recipient: string | null; recipient_name: string | null;
  recipient_role: string | null; kind: string; status: string; correlation_id: string;
  summary: string; detail: string | null; metadata_json: string | null; fingerprint: string;
}

function toEvent(row: TraceRow): CoordinationEvent {
  let metadata: CoordinationEvent['metadata'];
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as CoordinationEvent['metadata'];
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.event_id,
    seq: row.board_seq,
    timestamp: row.timestamp,
    repository: row.repository,
    repoKey: row.repo_key ?? undefined,
    taskId: row.task_id,
    taskLabel: row.task_label ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    sourceTaskLabel: row.source_task_label ?? undefined,
    targetTaskId: row.target_task_id ?? undefined,
    targetTaskLabel: row.target_task_label ?? undefined,
    actor: row.actor,
    actorName: row.actor_name ?? undefined,
    actorRole: row.actor_role ?? undefined,
    recipient: row.recipient ?? undefined,
    recipientName: row.recipient_name ?? undefined,
    recipientRole: row.recipient_role ?? undefined,
    kind: row.kind as CoordinationEvent['kind'],
    status: row.status as CoordinationEvent['status'],
    correlationId: row.correlation_id,
    summary: row.summary,
    detail: row.detail ?? undefined,
    metadata,
    fingerprint: row.fingerprint,
  };
}

/**
 * Read the permanent trace, oldest-first within the returned window. Filters
 * are ANDed; the newest `limit` matching rows are returned so a busy repository
 * does not force callers to page from the beginning of time.
 */
export function queryTrace(query: TraceQuery = {}): CoordinationEvent[] {
  const handle = getTraceDb();
  if (!handle) return [];
  const where: string[] = [];
  const params: Array<string | number> = [];
  // Publish resolves the repository before storing it, so the filter has to be
  // resolved the same way or a caller passing a relative or `~`-free path
  // silently matches nothing.
  if (query.repoKey && query.repository) {
    where.push('(repo_key = ? OR (repo_key IS NULL AND repository = ?))');
    params.push(query.repoKey, resolve(query.repository));
  } else if (query.repoKey) {
    where.push('repo_key = ?');
    params.push(query.repoKey);
  } else if (query.repository) {
    where.push('repository = ?');
    params.push(resolve(query.repository));
  }
  if (query.taskId) {
    where.push('(COALESCE(source_task_id, task_id) = ? OR COALESCE(target_task_id, task_id) = ?)');
    params.push(query.taskId, query.taskId);
  }
  if (query.taskLabel) {
    where.push('(COALESCE(source_task_label, task_label) = ? OR COALESCE(target_task_label, task_label) = ?)');
    params.push(query.taskLabel, query.taskLabel);
  }
  if (query.correlationId) { where.push('correlation_id = ?'); params.push(query.correlationId); }
  if (query.actor) { where.push('(actor = ? OR recipient = ?)'); params.push(query.actor, query.actor); }
  if (typeof query.since === 'number') { where.push('timestamp >= ?'); params.push(query.since); }
  if (query.kinds?.length) {
    where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
    params.push(...query.kinds);
  }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  try {
    const rows = handle.prepare(`
      SELECT * FROM coordination_trace
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?
    `).all(...params, limit) as TraceRow[];
    return rows.reverse().map(toEvent);
  } catch (error) {
    console.warn('[CoordinationTrace] Query failed:', error);
    return [];
  }
}

/**
 * The single most recent trace event of one kind for one task, or undefined.
 *
 * Filtered by `kind` (and optionally `status`) in SQL, not read out of a
 * generic `limit`-bounded window: a task's trace stream is shared by every
 * kind it produces (`adapter-route`, `review-run`, `mcp-audit`, ...), so a
 * task busy enough on those can crowd a `human-answer` out of even a
 * thousand-row `queryTrace` slice while this, needing only the one row SQL
 * already filtered to the right kind, never sees that competition.
 */
export function lastTraceEventOfKind(
  taskId: string, kind: CoordinationKind, status?: CoordinationStatus,
): CoordinationEvent | undefined {
  const handle = getTraceDb();
  if (!handle) return undefined;
  const where = ['task_id = ?', 'kind = ?'];
  const params: string[] = [taskId, kind];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  try {
    const row = handle.prepare(`
      SELECT * FROM coordination_trace
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT 1
    `).get(...params) as TraceRow | undefined;
    return row ? toEvent(row) : undefined;
  } catch (error) {
    console.warn('[CoordinationTrace] Query failed:', error);
    return undefined;
  }
}

/**
 * How a task's questions stand, counted in the database rather than fetched.
 *
 * A limit is the wrong tool for this decision: whatever the window, a task that
 * has asked more than it holds loses its oldest unanswered question from view
 * and the caller reads "all answered" — releasing a run that is still blocked.
 * Both columns this joins on are indexed, so the count is cheap.
 *
 * Returns null when the trace is unavailable, so the caller can fall back to the
 * in-memory board rather than treat "cannot tell" as "nothing is waiting".
 */
export function questionStandings(taskId: string): { asked: number; unanswered: number } | null {
  const handle = getTraceDb();
  if (!handle) return null;
  try {
    const row = handle.prepare(`
      SELECT
        COUNT(*) AS asked,
        SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM coordination_trace a
          WHERE a.correlation_id = q.correlation_id
            AND a.task_id = q.task_id
            AND a.kind = 'human-answer'
            AND a.status = 'completed'
        ) THEN 1 ELSE 0 END) AS unanswered
      FROM coordination_trace q
      WHERE q.task_id = ? AND q.kind = 'human-question'
    `).get(taskId) as { asked: number; unanswered: number | null };
    return { asked: row.asked, unanswered: row.unanswered ?? 0 };
  } catch (error) {
    console.warn('[CoordinationTrace] Question standings failed:', error);
    return null;
  }
}

/** Total recorded events, for dashboards that want to show retention depth. */
export function traceSize(): number {
  const handle = getTraceDb();
  if (!handle) return 0;
  try {
    return (handle.prepare('SELECT COUNT(*) AS count FROM coordination_trace').get() as { count: number }).count;
  } catch {
    return 0;
  }
}

/** Test seam: drop the cached handle so a new database path takes effect. */
export function resetTraceDbForTests(): void {
  try {
    db?.close();
  } catch {
    // Closing a broken handle is not worth failing a test teardown over.
  }
  db = null;
  openedPath = null;
  unavailable = false;
}
