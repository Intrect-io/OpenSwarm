// ============================================
// OpenSwarm - Claim-owner history for a durable run
// ============================================

import type Database from 'better-sqlite3';

/**
 * Every executor instance that ever claimed this run, newest first.
 *
 * Read from the `claimed` events rather than the run row: once a lease is
 * released or expires the row's `owner_instance_id` is cleared, and it is
 * exactly that released owner the caller wants to name.
 */
export function listClaimOwnersInDb(db: Database.Database, issueId: string): string[] {
  const rows = db.prepare(`
    SELECT data_json FROM automation_events
    WHERE issue_id = ? AND kind = 'claimed'
    ORDER BY sequence DESC
  `).all(issueId) as Array<{ data_json: string | null }>;
  const owners: string[] = [];
  for (const row of rows) {
    let owner: unknown;
    try {
      owner = row.data_json ? (JSON.parse(row.data_json) as { ownerInstanceId?: unknown }).ownerInstanceId : undefined;
    } catch {
      continue;
    }
    if (typeof owner === 'string' && owner && !owners.includes(owner)) owners.push(owner);
  }
  return owners;
}
