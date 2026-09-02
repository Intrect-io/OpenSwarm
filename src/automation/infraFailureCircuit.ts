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
