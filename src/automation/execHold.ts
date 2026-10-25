// ============================================
// OpenSwarm - The hold that keeps an `exec --issue` run for its external orchestrator
// ============================================
//
// `openswarm exec --issue INT-123` hands a run to an external orchestrator
// (Claude Code, omp, codex, a shell script). That orchestrator observes the run
// with `exec await`, and when the worker stops for input the run parks. The
// daemon's idle_fill then does exactly what it is designed to do — a free slot
// lifts the park and re-runs the task (AGT-4257) — which silently ignores the
// elevation it was supposed to wait on. AGT-4155 and AGT-4306 are the same loop
// reached by other routes: attempt counts climbing while the operator, or a
// non-existent operator, is still deciding.
//
// So the deployer leaves a hold: this issue is owned by an external orchestrator
// until it answers or the hold expires. `filterAlreadyProcessed` reads the set
// once per scheduling pass and skips those issues' idle_fill branches.
//
// Its own table rather than `automation_runs.metadata_json`: `registerRun`'s
// conflict branch replaces that column whole, and `observeTask` rewrites it on
// every scheduling pass, so a key parked there is erased by the next
// observation. `draftCache.ts` keeps its state in its own table for the same
// reason.
//
// Reads fail OPEN, writes fail CLOSED. The read side runs in the heartbeat hot
// path, where an unopenable database must degrade to the previous idle_fill
// behaviour rather than kill the scheduler. The write side runs in `exec`, where
// deploying a run without its hold would break the contract this exists to
// enforce — so it throws and the deploy is aborted instead.

import Database from 'better-sqlite3';
import { defaultAutomationDbPath } from './automationDbPath.js';

/**
 * How long a hold stays in force.
 *
 * A hold is not a lease on the run: it belongs to the deploy session, and it
 * has to expire, or an orchestrator that walked away would block idle_fill for
 * this issue forever. Long enough for a real elevation cycle (the pipeline takes
 * tens of minutes to hours), short enough that a day of silence hands the issue
 * back to the daemon. Normal flow re-marks the hold on every `exec answer`, so
 * each elevation cycle extends it.
 */
export const EXEC_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

let db: Database.Database | undefined;
let openedPath: string | undefined;

function connect(): Database.Database | undefined {
  const path = defaultAutomationDbPath();
  if (db && openedPath === path) return db;
  // A path change means a test redirected the store; drop the old handle.
  if (db) { try { db.close(); } catch { /* already closed */ } db = undefined; }
  try {
    const next = new Database(path);
    next.pragma('journal_mode = WAL');
    next.exec(`
      CREATE TABLE IF NOT EXISTS automation_exec_runs (
        issue_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_exec_runs_updated ON automation_exec_runs(updated_at);
    `);
    db = next;
    openedPath = path;
    return db;
  } catch (err) {
    console.warn('[ExecHold] Unavailable:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Drop the handle so the next call re-resolves the path. Tests redirect the DB. */
export function resetExecHoldForTests(): void {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = undefined;
  openedPath = undefined;
}

/**
 * Record that an external orchestrator owns this run.
 *
 * Throws when the hold cannot be written: the caller deploys a run behind this
 * call, and a run deployed without its hold is one idle_fill will silently
 * re-run out from under the orchestrator that is waiting on it.
 *
 * Re-marking an existing hold refreshes `updated_at` (and thus the TTL) and
 * keeps the original `created_at`.
 */
export function markExecHold(issueId: string, actor: string, now = Date.now()): void {
  const handle = connect();
  if (!handle) throw new Error('Could not open the automation database to record the exec hold');
  try {
    handle.prepare(`
      INSERT INTO automation_exec_runs(issue_id, actor, created_at, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        actor = excluded.actor,
        updated_at = excluded.updated_at
    `).run(issueId, actor, now, now);
  } catch (err) {
    throw new Error(`Could not record the exec hold for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ExecHoldClaim {
  /** A live hold existed before this claim wrote one: it belongs to an earlier deploy. */
  wasHeld: boolean;
  /** The `updated_at` this claim wrote. Strictly greater than any value the row held, so no two claims share one. */
  stamp: number;
}

/**
 * Write a hold and report, in the same transaction, whether one was already live.
 *
 * `exec --issue` used to read `isExecHeld` and then call `markExecHold`. Two orchestrators deploying
 * the same issue could both read "not held", both write, and when the first deploy was refused it
 * cleared a hold the second deploy still depended on, leaving that run for idle_fill to take. Reading
 * and writing under one `IMMEDIATE` transaction makes the second claim see the first, and the stamp
 * lets {@link releaseExecHoldIf} tell its own write from a later one.
 *
 * Throws like {@link markExecHold}: a run deployed without its hold is one idle_fill will re-run.
 */
export function claimExecHold(issueId: string, actor: string, now = Date.now()): ExecHoldClaim {
  const handle = connect();
  if (!handle) throw new Error('Could not open the automation database to record the exec hold');
  try {
    return handle.transaction((): ExecHoldClaim => {
      const prior = handle
        .prepare('SELECT updated_at FROM automation_exec_runs WHERE issue_id = ?')
        .get(issueId) as { updated_at: number } | undefined;
      const stamp = prior ? Math.max(now, prior.updated_at + 1) : now;
      handle.prepare(`
        INSERT INTO automation_exec_runs(issue_id, actor, created_at, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
          actor = excluded.actor,
          updated_at = excluded.updated_at
      `).run(issueId, actor, stamp, stamp);
      return { wasHeld: !!prior && now - prior.updated_at <= EXEC_HOLD_TTL_MS, stamp };
    }).immediate();
  } catch (err) {
    throw new Error(`Could not record the exec hold for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Release a hold only if it is still the one `stamp` names. Any later claim or `exec answer` re-mark
 * moved `updated_at`, so the row is someone else's now and is left alone. Never throws.
 */
export function releaseExecHoldIf(issueId: string, stamp: number): void {
  const handle = connect();
  if (!handle) return;
  try {
    handle.prepare('DELETE FROM automation_exec_runs WHERE issue_id = ? AND updated_at = ?').run(issueId, stamp);
  } catch (err) {
    console.warn('[ExecHold] Conditional release failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Release a hold.
 *
 * Never throws and never returns anything: it is called from tests and from an
 * operator cleaning up by hand, neither of which should be able to fail a run.
 * The CLI deliberately exposes no subcommand for it — the normal path is that a
 * hold expires, or that `exec answer` re-marks it.
 */
export function clearExecHold(issueId: string): void {
  const handle = connect();
  if (!handle) return;
  try {
    handle.prepare('DELETE FROM automation_exec_runs WHERE issue_id = ?').run(issueId);
  } catch (err) {
    console.warn('[ExecHold] Clear failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Whether this issue is currently held, i.e. whether an external orchestrator is
 * still the one that decides what happens next on it.
 *
 * Fail-open: an unreadable store reads as "not held", which is the behaviour
 * that existed before this module.
 */
export function isExecHeld(issueId: string, now = Date.now()): boolean {
  const handle = connect();
  if (!handle) return false;
  try {
    const row = handle
      .prepare('SELECT updated_at FROM automation_exec_runs WHERE issue_id = ?')
      .get(issueId) as { updated_at: number } | undefined;
    return !!row && now - row.updated_at <= EXEC_HOLD_TTL_MS;
  } catch (err) {
    console.warn('[ExecHold] Read failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Every issue whose hold is still in force, as the heartbeat reads it — once per
 * scheduling pass, rather than per task.
 *
 * Fail-open to the empty set: a store that cannot be read must leave idle_fill
 * exactly as it was before this existed.
 */
export function listHeldIssueIds(now = Date.now()): Set<string> {
  const handle = connect();
  if (!handle) return new Set();
  try {
    const rows = handle
      .prepare('SELECT issue_id FROM automation_exec_runs WHERE updated_at > ?')
      .all(now - EXEC_HOLD_TTL_MS) as Array<{ issue_id: string }>;
    return new Set(rows.map((row) => row.issue_id));
  } catch (err) {
    console.warn('[ExecHold] List failed:', err instanceof Error ? err.message : err);
    return new Set();
  }
}
