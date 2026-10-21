// ============================================
// OpenSwarm - Re-dispatch only when the issue's input changed (AGT-4787)
// ============================================
//
// On 2026-10-20 one issue was dispatched 18 times in 14 hours and 52 issues were
// touched, mostly after an infra_error or a "parked for operator decision" — two
// outcomes that retrying cannot change. Nothing compared the issue as the last
// run saw it with the issue as it is now, so idle_fill lifted every park a free
// slot allowed.
//
// What counts as new input is what a person can change: the title, the
// description, and the comments the daemon did not write. Two keys that look
// natural are wrong:
//
//   - `trackerUpdatedAt` bumps on the daemon's own tracker writes (progress
//     comments, state transitions). AGT-4300 measured that key driving
//     attempt_no to 40 on an unchanged issue, and a fingerprint on it would
//     change after every comment the daemon posts.
//   - a comment count rises with every daemon comment for the same reason.
//
// Tracker comments carry no author (`user` is unresolved in linear.ts) and the
// daemon writes as the operator, so "human comments only" cannot come from
// authorship. The daemon's own comments are recognised by their signature
// instead. That signature can be copied by a person, which is the safe
// direction here: a copied signature leaves an issue parked, it never lifts a
// park the input did not earn.
//
// Its own table rather than `automation_runs.metadata_json`, which `registerRun`
// replaces whole (see execHold.ts and draftCache.ts for the same reason). Reads
// fail OPEN — an unreadable store must not stop the heartbeat, so it degrades to
// today's behaviour — and writes fail CLOSED, since a park that is not recorded
// cannot be held.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { defaultAutomationDbPath } from './automationDbPath.js';

export interface FingerprintInput {
  title: string;
  description?: string;
  comments?: ReadonlyArray<{ body: string }>;
}

/** The two shapes the daemon signs its comments with: task-state sync headings and `formatAutomationComment`'s tail. */
const DAEMON_SIGNATURES: readonly RegExp[] = [
  /^🧭 \*\*\[OpenSwarm\] /,
  /^\*\*\[OpenSwarm\]/,
  /_via OpenSwarm(?: ·[^_]*)?_\s*$/,
];

/** True for a comment the daemon wrote, by its signature. */
export function isDaemonComment(body: string): boolean {
  const text = body.trim();
  return DAEMON_SIGNATURES.some((pattern) => pattern.test(text));
}

/**
 * A stable digest of everything a person can change about an issue. Comments are
 * hashed in the order the tracker returns them, so reordering is a change but
 * the daemon's own comments, wherever they sit, are not.
 */
export function inputFingerprint(issue: FingerprintInput): string {
  const human = (issue.comments ?? []).map((c) => c.body.trim()).filter((body) => body && !isDaemonComment(body));
  return createHash('sha256')
    .update(JSON.stringify([issue.title.trim(), (issue.description ?? '').trim(), human]))
    .digest('hex');
}

let db: Database.Database | undefined;
let openedPath: string | undefined;

function connect(): Database.Database | undefined {
  const path = defaultAutomationDbPath();
  if (db && openedPath === path) return db;
  if (db) { try { db.close(); } catch { /* already closed */ } db = undefined; }
  try {
    const next = new Database(path);
    next.pragma('journal_mode = WAL');
    next.exec(`
      CREATE TABLE IF NOT EXISTS automation_parked_inputs (
        issue_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db = next;
    openedPath = path;
    return db;
  } catch (err) {
    console.warn('[DispatchFingerprint] Unavailable:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Drop the handle so the next call re-resolves the path. Tests redirect the DB. */
export function resetDispatchFingerprintForTests(): void {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = undefined;
  openedPath = undefined;
}

/**
 * Remember the input a run parked on. Re-recording replaces it: the latest park
 * is the one a future change is measured against.
 */
export function recordParkedInput(issueId: string, fingerprint: string, now = Date.now()): void {
  const handle = connect();
  if (!handle) throw new Error('Could not open the automation database to record the parked input');
  try {
    handle.prepare(`
      INSERT INTO automation_parked_inputs(issue_id, fingerprint, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at
    `).run(issueId, fingerprint, now);
  } catch (err) {
    throw new Error(`Could not record the parked input for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whether a parked issue may be dispatched again. False only when this issue was
 * recorded as parked on exactly this input; an issue with no record, a different
 * input, or an unreadable store passes.
 */
export function mayRedispatch(issueId: string, fingerprint: string): boolean {
  const handle = connect();
  if (!handle) return true;
  try {
    const row = handle
      .prepare('SELECT fingerprint FROM automation_parked_inputs WHERE issue_id = ?')
      .get(issueId) as { fingerprint: string } | undefined;
    return !row || row.fingerprint !== fingerprint;
  } catch (err) {
    console.warn('[DispatchFingerprint] Read failed:', err instanceof Error ? err.message : err);
    return true;
  }
}

/**
 * Record the input a run starts on. Called once, where the pipeline starts, so
 * every later park or backoff — wherever in the ledger it happens — is measured
 * against the issue as the run saw it. A failure here must not stop the run: it
 * only means a later park cannot be held, which is the behaviour before this
 * existed.
 */
export function recordRunInput(task: { issueId?: string; id: string; title: string; description?: string }): void {
  try {
    recordParkedInput(task.issueId || task.id, inputFingerprint({ title: task.title, description: task.description }));
  } catch (err) {
    console.warn('[DispatchFingerprint] Could not record the run input:', err instanceof Error ? err.message : err);
  }
}
