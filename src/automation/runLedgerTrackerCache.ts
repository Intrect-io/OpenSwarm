import type Database from 'better-sqlite3';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import type {
  LedgerMetrics,
  RunRecord,
  RunState,
  TrackerStateObservation,
} from './runLedgerTypes.js';

export type TrackerTerminalState = 'DONE' | 'CANCELLED';

/** States with neither a live execution lease nor pending tracker side effects. */
export const TRACKER_RECONCILABLE_STATES: readonly RunState[] = [
  'DISCOVERED', 'READY', 'RETRY_AT', 'WAITING_EXTERNAL',
  'NEEDS_SPEC', 'NEEDS_ENV', 'NEEDS_HUMAN',
];

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/**
 * Persist one explicit tracker observation, optionally closing the run.
 *
 * Both paths compare the state version and require an unowned row. A worker
 * that claims the run while the network lookup is in flight therefore wins;
 * stale tracker data can never close an active execution.
 */
export function cacheTrackerObservation(
  db: Database.Database,
  expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion'>,
  observation: TrackerStateObservation,
  terminalState: TrackerTerminalState | undefined,
  now: number,
): boolean {
  if (!TRACKER_RECONCILABLE_STATES.includes(expected.state)) return false;
  const state = observation.lookupError ? 'lookup_error' : (observation.state ?? 'not_found');
  const stateType = observation.stateType ?? null;
  const apply = db.transaction(() => {
    if (!terminalState) {
      return db.prepare(`
        UPDATE automation_runs
        SET tracker_state = ?, tracker_state_type = ?, tracker_checked_at = ?
        WHERE issue_id = ? AND state = ? AND state_version = ?
          AND owner_instance_id IS NULL AND lease_token IS NULL
      `).run(state, stateType, now, expected.issueId, expected.state, expected.stateVersion).changes === 1;
    }

    const row = db.prepare(`
      SELECT attempt_no FROM automation_runs
      WHERE issue_id = ? AND state = ? AND state_version = ?
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).get(expected.issueId, expected.state, expected.stateVersion) as { attempt_no: number } | undefined;
    if (!row) return false;
    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = ?, state_version = state_version + 1, retry_at = NULL,
          lease_expires_at = NULL, completed_at = ?, updated_at = ?,
          tracker_state = ?, tracker_state_type = ?, tracker_checked_at = ?
      WHERE issue_id = ? AND state = ? AND state_version = ?
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).run(
      terminalState, now, now, state, stateType, now,
      expected.issueId, expected.state, expected.stateVersion,
    );
    if (updated.changes !== 1) return false;
    db.prepare(`
      INSERT INTO automation_events(
        issue_id, attempt_no, kind, from_state, to_state, data_json, created_at
      ) VALUES (?, ?, 'tracker_terminal_reconciled', ?, ?, ?, ?)
    `).run(
      expected.issueId,
      row.attempt_no,
      expected.state,
      terminalState,
      JSON.stringify({ trackerState: state, trackerStateType: stateType }),
      now,
    );
    return true;
  });
  return apply.immediate();
}

/** Kept outside RunLedger so adding tracker caching does not grow its 1500-line gate. */
export function readLedgerMetrics(db: Database.Database, now: number): LedgerMetrics {
  const byState: Record<string, number> = {};
  for (const row of db.prepare('SELECT state, COUNT(*) AS count FROM automation_runs GROUP BY state').all() as { state: string; count: number }[]) {
    byState[row.state] = row.count;
  }
  const effectsByStatus: Record<string, number> = {};
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM automation_effects GROUP BY status').all() as { status: string; count: number }[]) {
    effectsByStatus[row.status] = row.count;
  }
  const expiredActiveLeases = (db.prepare(`
    SELECT COUNT(*) AS count FROM automation_runs
    WHERE state IN (${placeholders(ACTIVE_LEASE_STATES)})
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).get(...ACTIVE_LEASE_STATES, now) as { count: number }).count;
  const oldest = db.prepare(`
    SELECT MIN(created_at) AS created_at FROM automation_effects
    WHERE status IN ('pending', 'in_flight')
  `).get() as { created_at: number | null };
  const openCircuits = (db.prepare(`
    SELECT COUNT(*) AS count FROM automation_repo_circuits WHERE open_until > ?
  `).get(now) as { count: number }).count;
  return {
    byState,
    effectsByStatus,
    expiredActiveLeases,
    oldestPendingEffectAgeMs: oldest.created_at == null ? 0 : Math.max(0, now - oldest.created_at),
    openCircuits,
  };
}
