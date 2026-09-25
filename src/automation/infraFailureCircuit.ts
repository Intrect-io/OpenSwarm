// ============================================
// OpenSwarm - Same-fingerprint infrastructure failure circuit
// ============================================

import type Database from 'better-sqlite3';

/** Default number of consecutive identical infrastructure failures that parks a run. */
export const DEFAULT_INFRA_FAILURE_CIRCUIT = 6;

export const INFRA_CIRCUIT_PARK_REASON = 'infra_circuit_open';

/**
 * Reduce an infrastructure failure message to what identifies its cause.
 *
 * Sandbox roots, worktree ids, timings and byte counts change on every
 * attempt; the tool, the command and the error class do not. Two attempts
 * that agree on this string failed for the same reason.
 */
export function infraFailureFingerprint(message: string | undefined): string {
  return (message ?? '')
    .replace(/\/work\/\.openswarm-verify-(?:base|head)-[A-Za-z0-9]+/g, '<SANDBOX>')
    .replace(/worktree\/[0-9a-f]{8}[0-9a-f-]*/g, 'worktree/<ID>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|MB|KB|bytes?)\b/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * How many of the most recent finished attempts, walking back from the
 * newest, ended as `infra_error` with this same fingerprint. Stops at the
 * first attempt that differs, so an intervening success or a different
 * failure resets the count.
 */
export function consecutiveIdenticalInfraFailuresInDb(
  db: Database.Database,
  issueId: string,
  fingerprint: string,
  limit = 32,
): number {
  if (!fingerprint) return 0;
  const rows = db.prepare(`
    SELECT result_status, error_message FROM automation_attempts
    WHERE issue_id = ? AND finished_at IS NOT NULL
    ORDER BY attempt_no DESC, lease_epoch DESC
    LIMIT ?
  `).all(issueId, limit) as Array<{ result_status: string | null; error_message: string | null }>;
  let streak = 0;
  for (const row of rows) {
    if (row.result_status !== 'infra_error') break;
    if (infraFailureFingerprint(row.error_message ?? undefined) !== fingerprint) break;
    streak += 1;
  }
  return streak;
}

/**
 * Finished attempts, newest first, that ended `superseded` before anything
 * else. The supersession backoff is keyed on this streak, not on the run's
 * total attempt number: a run with eight earlier attempts of any kind used to
 * wait six hours after ONE sibling PR claimed its files, and an explicit
 * redispatch that hit the same PR only pushed it further out (vela
 * AGT-3597/4165/3502 → 19:27–20:07 on 2026-09-02).
 */
export function consecutiveSupersessionsInDb(db: Database.Database, issueId: string, limit = 32): number {
  const rows = db.prepare(`
    SELECT result_status FROM automation_attempts
    WHERE issue_id = ? AND finished_at IS NOT NULL
    ORDER BY attempt_no DESC, lease_epoch DESC
    LIMIT ?
  `).all(issueId, limit) as Array<{ result_status: string | null }>;
  let streak = 0;
  for (const row of rows) {
    if (row.result_status !== 'superseded') break;
    streak += 1;
  }
  return streak;
}

/** How many identical verdicts in a row make a run's next verdict a foregone conclusion. */
export const REPEATED_VERDICT_STREAK = 2;

/**
 * How long idle fill leaves a run alone once its verdict has repeated. Long
 * enough that a free slot cannot spin it, short enough that a fix deployed
 * overnight is picked up without an operator's hand.
 */
export const REPEATED_VERDICT_IDLE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Attempt outcomes that are a judgement on the work, as opposed to noise around it. */
const VERDICT_STATUSES = new Set(['failed', 'rejected']);
/** Outcomes that end a streak: the run got somewhere. */
const PROGRESS_STATUSES = new Set(['approved', 'decomposed']);

/**
 * How many of the most recent verdicts on this run, newest first, are the
 * same verdict: same error code, same fingerprinted message.
 *
 * Restarts, provider timeouts and supersessions between two verdicts are
 * skipped rather than treated as a break. cgf-portal AX-1027 was refused for
 * one out-of-scope path at attempt 25 and again at attempt 33 with two
 * orphaned executors, a shutdown and four tester timeouts in between; none of
 * those changed the branch, so the second refusal was the same refusal.
 *
 * A free-prose reviewer verdict differs on every attempt and never builds a
 * streak. That is intended: only a deterministic gate returns the same string
 * for the same input, and only that is safe to call a foregone conclusion.
 */
export function consecutiveIdenticalVerdictsInDb(db: Database.Database, issueId: string, limit = 48): number {
  const rows = db.prepare(`
    SELECT result_status, error_code, error_message FROM automation_attempts
    WHERE issue_id = ? AND finished_at IS NOT NULL
    ORDER BY attempt_no DESC, lease_epoch DESC
    LIMIT ?
  `).all(issueId, limit) as Array<{ result_status: string | null; error_code: string | null; error_message: string | null }>;
  let key: string | undefined;
  let streak = 0;
  for (const row of rows) {
    const status = row.result_status ?? '';
    if (PROGRESS_STATUSES.has(status)) break;
    if (!VERDICT_STATUSES.has(status)) continue;
    const fingerprint = infraFailureFingerprint(row.error_message ?? undefined);
    if (!fingerprint) break;
    const rowKey = `${row.error_code ?? ''}\u0000${fingerprint}`;
    if (key === undefined) key = rowKey;
    else if (rowKey !== key) break;
    streak += 1;
  }
  return streak;
}
