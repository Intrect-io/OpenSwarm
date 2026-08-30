import type Database from 'better-sqlite3';
import type { EffectInput, RunState } from './runLedgerTypes.js';

type IntegrationRunRow = {
  state: RunState;
  state_version: number;
  attempt_no: number;
  owner_instance_id: string | null;
  lease_token: string | null;
};

type IntegrationEffectRow = {
  issue_id: string;
  kind: string;
  payload_json: string;
  status: string;
};

const ELIGIBLE_STATES: readonly RunState[] = [
  'READY', 'DONE', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_HUMAN', 'NEEDS_RECONCILE',
];

/**
 * Atomically park a safe, unleased run in SYNC_PENDING with its tracker
 * requeue effect. External Todo/comment delivery can then retry without
 * splitting tracker truth from the local state transition.
 */
export function queueIntegrationRequeueInDb(
  db: Database.Database,
  issueId: string,
  expectedStateVersion: number,
  effect: EffectInput,
  now: number,
): boolean {
  const queue = db.transaction(() => {
    const row = db.prepare(`
      SELECT state, state_version, attempt_no, owner_instance_id, lease_token
      FROM automation_runs WHERE issue_id = ?
    `).get(issueId) as IntegrationRunRow | undefined;
    if (!row) return false;
    const existing = db.prepare(`
      SELECT issue_id, kind, payload_json, status
      FROM automation_effects WHERE dedupe_key = ?
    `).get(effect.dedupeKey) as IntegrationEffectRow | undefined;
    if (existing) {
      const sameEffect = existing.issue_id === issueId
        && existing.kind === effect.kind
        && existing.payload_json === JSON.stringify(effect.payload);
      if (!sameEffect) throw new Error(`Outbox dedupe key collision: ${effect.dedupeKey}`);
      return row.state === 'SYNC_PENDING' || (row.state === 'READY' && existing.status === 'applied');
    }
    if (!ELIGIBLE_STATES.includes(row.state) || row.state_version !== expectedStateVersion) return false;
    if (row.owner_instance_id != null || row.lease_token != null) return false;

    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = 'SYNC_PENDING', state_version = state_version + 1,
          retry_at = NULL, completed_at = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE issue_id = ? AND state_version = ? AND state = ?
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).run(now, issueId, row.state_version, row.state);
    if (updated.changes !== 1) return false;

    db.prepare(`
      INSERT INTO automation_effects(
        issue_id, attempt_no, kind, dedupe_key, payload_json,
        status, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      issueId, row.attempt_no, effect.kind, effect.dedupeKey,
      JSON.stringify(effect.payload), effect.availableAt ?? now, now, now,
    );
    db.prepare(`
      INSERT INTO automation_events(
        issue_id, attempt_no, kind, from_state, to_state, data_json, created_at
      ) VALUES (?, ?, 'integration_requeue_queued', ?, 'SYNC_PENDING', ?, ?)
    `).run(issueId, row.attempt_no, row.state, JSON.stringify({ dedupeKey: effect.dedupeKey }), now);
    return true;
  });
  return queue.immediate();
}
