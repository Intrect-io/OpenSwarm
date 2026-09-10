// ============================================
// OpenSwarm — the draft analysis, kept across retries (AGT-4286)
// ============================================
//
// Measured on vela over 24h: the draft stage made 13,122 calls costing $56.38,
// a third of the $168.32 total, at a 30.5% prompt-cache hit rate while every
// other stage sat at 83-88%. The ledger for the same window recorded 2,797
// attempts across 275 runs — 4.7 draft calls per attempt. The analysis was
// being recomputed on nearly every retry of the same task.
//
// It was already cached by the right key. `autonomousRunner` fingerprints a task
// as [title, description] (trackerUpdatedAt was dropped in AGT-4300 — it bumps on
// the daemon's own tracker mutations, not just content edits, and was causing the
// exact self-inflicted misses this cache exists to prevent), which deliberately
// omits the attempt number so a retry reuses the previous analysis. What failed
// was the storage: an in-memory Map, capped at 256 entries against 275 active
// runs, wiped by every daemon restart — twice on the day this was measured, both
// from autodeploy — while RETRY_AT backoff is counted in hours. Nothing in memory
// outlives the gap it needs to cross.
//
// Its own table rather than `automation_runs.metadata_json`: that column is
// written whole, as `metadata_json = COALESCE(?, metadata_json)`, and
// `observeTask` rewrites it on every scheduling pass. A key parked there would
// be erased by the next observation.
//
// Ruled out first, by measurement, so the next reader does not re-litigate:
// the model is not the expensive one (qwen is $0.270/1M uncached against
// deepseek's $0.414); prompt ordering has nothing to hoist (the static
// template is ~378 of 22,896 tokens); and the provider does cache — two direct
// calls with an identical prefix returned 24,221 of 24,222 tokens cached.

import Database from 'better-sqlite3';
import { defaultAutomationDbPath } from './automationDbPath.js';

/** What the pre-admission pass computed, and the inputs it was computed from. */
export interface CachedDraftEntry<TDraft = unknown> {
  fingerprint: string;
  draft: TDraft;
  fileScope: string[];
  description?: string;
  executionCommentsLoaded?: boolean;
}

/**
 * How long a stored analysis stays usable.
 *
 * The fingerprint covers the issue text, not the tree, so a reused draft can
 * describe an older working copy. The in-memory cache had the same property
 * within one scheduling cycle; persisting it widens that window, and this is
 * the bound on how far. Long enough to span RETRY_AT backoff and a redeploy,
 * short enough that a branch cannot drift a whole day underneath it.
 */
export const DRAFT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

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
      CREATE TABLE IF NOT EXISTS draft_cache (
        issue_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_cache_updated ON draft_cache(updated_at);
    `);
    db = next;
    openedPath = path;
    return db;
  } catch (err) {
    // A cache is an optimisation. If the database cannot be opened — a
    // read-only mount, a full disk — the caller recomputes, which is exactly
    // what it did before this existed. Never fail a run over a cache.
    console.warn('[DraftCache] Unavailable, drafts will be recomputed:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Drop the handle so the next call re-resolves the path. Tests redirect the DB. */
export function resetDraftCacheForTests(): void {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = undefined;
  openedPath = undefined;
}

/**
 * The stored analysis for this task, if it was computed from the same inputs
 * and is still inside the TTL.
 *
 * A fingerprint mismatch is a miss, NOT a delete. The reader cannot tell
 * whether its own fingerprint is the newer one or the older one — a caller
 * holding a stale task object would otherwise destroy a freshly written entry
 * and force the next attempt to recompute, which is the cost this exists to
 * remove. Expiry is different: a row past the TTL is stale for every reader,
 * so that one is dropped on sight and swept by `pruneDraftCache`.
 */
export function readDraftCache<TDraft>(
  issueId: string,
  fingerprint: string,
  now: number = Date.now(),
): CachedDraftEntry<TDraft> | undefined {
  const handle = connect();
  if (!handle || !issueId) return undefined;
  try {
    const row = handle
      .prepare('SELECT fingerprint, payload_json, updated_at FROM draft_cache WHERE issue_id = ?')
      .get(issueId) as { fingerprint: string; payload_json: string; updated_at: number } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) return undefined;
    if (now - row.updated_at > DRAFT_CACHE_TTL_MS) {
      handle.prepare('DELETE FROM draft_cache WHERE issue_id = ?').run(issueId);
      return undefined;
    }
    const parsed = JSON.parse(row.payload_json) as CachedDraftEntry<TDraft>;
    // A payload without a draft is not a hit — recomputing is correct, and
    // returning a half-entry would hand the pipeline an undefined analysis.
    if (!parsed || typeof parsed !== 'object' || parsed.draft === undefined) return undefined;
    return { ...parsed, fingerprint: row.fingerprint };
  } catch (err) {
    console.warn('[DraftCache] Read failed, recomputing:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Store the analysis for later attempts. Best-effort: a failed write just costs one recompute. */
export function writeDraftCache<TDraft>(
  issueId: string,
  entry: CachedDraftEntry<TDraft>,
  now: number = Date.now(),
): void {
  const handle = connect();
  if (!handle || !issueId || entry.draft === undefined) return;
  try {
    handle.prepare(`
      INSERT INTO draft_cache(issue_id, fingerprint, payload_json, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(issueId, entry.fingerprint, JSON.stringify(entry), now);
  } catch (err) {
    console.warn('[DraftCache] Write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Delete entries past the TTL.
 *
 * Called from the heartbeat rather than on every read: a read only knows about
 * the one row it asked for, so without a sweep the table keeps every task the
 * daemon ever drafted. Returns the number removed.
 */
export function pruneDraftCache(now: number = Date.now()): number {
  const handle = connect();
  if (!handle) return 0;
  try {
    const cutoff = now - DRAFT_CACHE_TTL_MS;
    return handle.prepare('DELETE FROM draft_cache WHERE updated_at < ?').run(cutoff).changes;
  } catch (err) {
    console.warn('[DraftCache] Prune failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
