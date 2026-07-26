// ============================================
// OpenSwarm - SQLite WAL negotiation
// ============================================
//
// Every store here is opened by more than one process — the daemon, the CLI,
// the dashboard — and often at the same moment, on a machine already saturated
// with agent work. That makes the one-time conversion to WAL a contended
// operation, and it is not covered by `busy_timeout`: measured in this repo, a
// connection holding a read transaction makes `PRAGMA journal_mode = WAL` wait
// out the entire timeout and then throw SQLITE_BUSY.
//
// A single attempt therefore turns "someone else opened the store at the same
// moment" into a hard crash in a constructor. Before this helper existed, the
// multi-process cases in runLedger.test.ts failed 6/6 runs at load ~11 and 0/6
// with the retry loop in place.

import type Database from 'better-sqlite3';

/** Wait policy for stores that have no reason to pick their own. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Block the current thread. Store constructors are synchronous, so this must be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a SQLite error means "someone else holds it, try again".
 *
 * Matched by prefix rather than equality: SQLite also defines extended busy
 * codes (SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_RECOVERY, SQLITE_BUSY_TIMEOUT), and
 * better-sqlite3 does surface extended codes for other classes. One of those
 * reaching an exact-match check would be rethrown instead of retried — exactly
 * the startup crash this module exists to prevent. Local probing only ever
 * produced the bare code, so the prefix is defensive rather than observed, but
 * it is the cheap direction to be wrong in.
 */
export function isRetryableBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * Switch a database to WAL, tolerating a concurrent opener.
 *
 * Only the very first conversion contends: WAL is a persistent property of the
 * file, so once any process has flipped it every later `journal_mode = WAL` is
 * a no-op that returns 'wal' without taking the lock. Retrying is enough. The
 * loop is bounded so a database that genuinely cannot convert — a permanently
 * held read transaction, say — still fails with an explicit error instead of
 * hanging.
 *
 * `busyTimeoutMs` is both the caller's steady-state wait policy (restored on
 * the way out) and the budget for the conversion.
 */
export function enableWalWithRetry(db: Database.Database, busyTimeoutMs: number): void {
  const totalBudgetMs = Math.max(busyTimeoutMs, 1_000);
  const deadline = Date.now() + totalBudgetMs;
  let backoffMs = 25;
  let lastError: unknown;

  // Shorten the wait policy for the duration of the conversion. Left at the
  // caller's value, the very first attempt burns the whole budget inside one
  // blocking call and the retry loop never gets a second turn; a short timeout
  // trades one long wait for many cheap attempts across the same budget.
  db.pragma('busy_timeout = 100');
  try {
    for (;;) {
      try {
        const rows = db.pragma('journal_mode = WAL') as Array<{ journal_mode?: string }>;
        const mode = rows[0]?.journal_mode?.toLowerCase();
        if (mode === 'wal') return;
        // An in-memory or temp database reports 'memory' and can never be WAL.
        // That is a legitimate configuration, not contention: retrying would
        // spin for the whole budget and then fail an open that used to work.
        if (mode === 'memory') return;
        lastError = new Error(`journal_mode stayed '${mode ?? 'unknown'}'`);
      } catch (error) {
        if (!isRetryableBusyError(error)) throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not switch the database to WAL within ${totalBudgetMs}ms: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      }
      sleepSync(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 250);
    }
  } finally {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  }
}
