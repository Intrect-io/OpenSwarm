import Database from 'better-sqlite3';
import type { RunRow } from './runLedgerRows.js';
import type { RunRecord, RunState } from './runLedgerTypes.js';

export type MissingWorktreeDisposition = 'published' | 'needs_human' | 'clear';

/** CAS reconciliation for a ledger row whose recorded worktree vanished. */
export function reconcileMissingWorktreeInDb(
  db: Database.Database,
  expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'worktreePath'>,
  disposition: MissingWorktreeDisposition,
  reason: string,
  clearHeadSha: boolean,
  now: number,
  insertEvent: (issueId: string, attemptNo: number, kind: string, from: RunState, to: RunState, data: unknown, at: number) => void,
): boolean {
  if (!expected.worktreePath) return false;
  const reconcile = db.transaction(() => {
    const row = db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(expected.issueId) as RunRow | undefined;
    if (!row || row.worktree_path !== expected.worktreePath || row.state !== expected.state
      || row.state_version !== expected.stateVersion || row.owner_instance_id != null || row.lease_token != null) return false;
    const target = disposition === 'published' ? 'NEEDS_RECONCILE'
      : disposition === 'needs_human' ? 'NEEDS_HUMAN' : row.state as RunState;
    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = ?, state_version = state_version + 1, worktree_path = NULL,
          head_sha = CASE WHEN ? THEN NULL ELSE head_sha END,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE issue_id = ? AND state = ? AND state_version = ? AND worktree_path = ?
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).run(
      target, clearHeadSha ? 1 : 0,
      disposition === 'published' ? 'missing_worktree_published' : disposition === 'needs_human' ? 'missing_worktree' : row.last_error_code,
      reason, now, expected.issueId, row.state, row.state_version, expected.worktreePath,
    );
    if (updated.changes !== 1) return false;
    insertEvent(expected.issueId, row.attempt_no, 'missing_worktree_reconciled', row.state as RunState, target, {
      disposition, reason, worktreePath: expected.worktreePath, clearHeadSha,
    }, now);
    return true;
  });
  return reconcile.immediate();
}
