// ============================================
// OpenSwarm - parked publication ledger mutations (AGT-4124)
// ============================================
// Kept outside runLedger.ts: this is a one-shot maintenance path, not normal
// execution, and the ledger's core state machine is at its file-size boundary.

import type Database from 'better-sqlite3';
import type { RunLedger } from './runLedger.js';
import type { RunRecord, RunState } from './runLedger.js';

type LedgerInternals = {
  db: Database.Database;
  insertEvent(issueId: string, attemptNo: number, kind: string, from: RunState | null, to: RunState | null, data: unknown, now: number): void;
};

type ParkedExpected = Pick<RunRecord, 'issueId' | 'state' | 'stateVersion' | 'branchName'>;

/** Attach a discovered draft PR only to the exact unowned parked row scanned. */
export function attachParkedPublication(
  ledger: RunLedger,
  expected: ParkedExpected,
  publication: { prUrl: string; headSha: string },
  now = Date.now(),
): boolean {
  if (expected.state !== 'NEEDS_HUMAN' || !expected.branchName) return false;
  const internal = ledger as unknown as LedgerInternals;
  const attach = internal.db.transaction(() => {
    const result = internal.db.prepare(`
      UPDATE automation_runs
      SET pr_url = ?, head_sha = ?, state_version = state_version + 1, updated_at = ?
      WHERE issue_id = ? AND state = 'NEEDS_HUMAN' AND state_version = ?
        AND branch_name = ? AND pr_url IS NULL
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).run(publication.prUrl, publication.headSha, now, expected.issueId, expected.stateVersion, expected.branchName);
    if (result.changes !== 1) return false;
    const row = internal.db.prepare('SELECT attempt_no FROM automation_runs WHERE issue_id = ?')
      .get(expected.issueId) as { attempt_no: number };
    internal.insertEvent(expected.issueId, row.attempt_no, 'parked_publication_attached', 'NEEDS_HUMAN', 'NEEDS_HUMAN', publication, now);
    return true;
  });
  return attach.immediate();
}

/** Record why a parked row was intentionally left without a PR. */
export function recordParkedPublicationSkip(
  ledger: RunLedger,
  expected: ParkedExpected,
  reason: string,
  now = Date.now(),
): boolean {
  if (expected.state !== 'NEEDS_HUMAN') return false;
  const internal = ledger as unknown as LedgerInternals;
  const record = internal.db.transaction(() => {
    const row = internal.db.prepare(`
      SELECT attempt_no FROM automation_runs
      WHERE issue_id = ? AND state = 'NEEDS_HUMAN' AND state_version = ?
        AND branch_name IS ? AND pr_url IS NULL
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).get(expected.issueId, expected.stateVersion, expected.branchName ?? null) as { attempt_no: number } | undefined;
    if (!row) return false;
    internal.insertEvent(expected.issueId, row.attempt_no, 'parked_publication_skipped', 'NEEDS_HUMAN', 'NEEDS_HUMAN', { reason }, now);
    return true;
  });
  return record.immediate();
}
