import type Database from 'better-sqlite3';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import { assertRunState, type RunRow } from './runLedgerRows.js';
import { placeholders } from './runLedgerUtils.js';

/** Caller must already hold a SQLite writer transaction. */
export function reconcileExpiredRowsInDb(db: Database.Database, rows: readonly RunRow[], now: number, onExpired: (row: RunRow) => void): string[] {
  const reconciledIssueIds: string[] = [];
  for (const row of rows) {
    assertRunState(row.state);
    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = 'NEEDS_RECONCILE', state_version = state_version + 1,
          lease_expires_at = NULL,
          last_error_code = 'lease_expired',
          last_error_message = 'Execution lease expired before a terminal transition',
          updated_at = ?
      WHERE issue_id = ? AND state_version = ? AND lease_epoch = ?
        AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(
      now,
      row.issue_id,
      row.state_version,
      row.lease_epoch,
      ...ACTIVE_LEASE_STATES,
      now,
    );
    if (updated.changes !== 1) continue;
    reconciledIssueIds.push(row.issue_id);
    db.prepare(`
      UPDATE automation_attempts
      SET status = 'orphaned', finished_at = ?, error_code = 'lease_expired',
          error_message = 'Execution lease expired before a terminal transition'
      WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ? AND status = 'running'
    `).run(now, row.issue_id, row.attempt_no, row.lease_epoch);
    onExpired(row);
  }
  return reconciledIssueIds;
}
