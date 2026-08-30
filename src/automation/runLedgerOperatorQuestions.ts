// ============================================
// OpenSwarm - Exact operator-question ledger lifecycle
// ============================================

import type Database from 'better-sqlite3';
import {
  normalizeOperatorQuestionCorrelations,
  OPERATOR_PARK_REASON,
  OPERATOR_QUESTION_PARK_REASON,
} from '../coordination/operatorAnswers.js';
import { ALLOWED_TRANSITIONS, type RunState } from './runLedgerTypes.js';
import type { RunRow } from './runLedgerRows.js';

function event(
  db: Database.Database,
  issueId: string,
  attemptNo: number,
  kind: string,
  from: RunState,
  to: RunState,
  data: unknown,
  now: number,
): void {
  db.prepare(`
    INSERT INTO automation_events(
      issue_id, attempt_no, kind, from_state, to_state, data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(issueId, attemptNo, kind, from, to, JSON.stringify(data), now);
}

function parseCorrelations(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const data = JSON.parse(value) as { correlationIds?: unknown };
    return normalizeOperatorQuestionCorrelations(
      Array.isArray(data.correlationIds)
        ? data.correlationIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
  } catch {
    return [];
  }
}

export function markNeedsHumanForQuestionsInDb(
  db: Database.Database,
  issueId: string,
  correlationIds: readonly string[],
  reason: string,
  now: number,
): boolean {
  const exactIds = normalizeOperatorQuestionCorrelations(correlationIds);
  if (exactIds.length === 0) return false;
  const transition = db.transaction(() => {
    const row = db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
    if (
      !row
      || row.state !== 'RETRY_AT'
      || row.last_error_code !== OPERATOR_PARK_REASON
      || row.owner_instance_id != null
      || row.lease_token != null
    ) return false;
    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = 'NEEDS_HUMAN', state_version = state_version + 1,
          retry_at = NULL,
          owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE issue_id = ? AND state_version = ? AND state = 'RETRY_AT'
        AND last_error_code = ?
        AND owner_instance_id IS NULL AND lease_token IS NULL
    `).run(
      OPERATOR_QUESTION_PARK_REASON, reason, now, issueId, row.state_version,
      OPERATOR_PARK_REASON,
    );
    if (updated.changes !== 1) return false;
    event(db, issueId, row.attempt_no, 'operator_question_parked', 'RETRY_AT', 'NEEDS_HUMAN', {
      reason,
      correlationIds: exactIds,
    }, now);
    return true;
  });
  return transition.immediate();
}

export function resumeNeedsHumanForQuestionsInDb(
  db: Database.Database,
  issueId: string,
  now: number,
): RunState | null {
  const resume = db.transaction((): RunState | null => {
    const row = db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
    if (!row || row.state !== 'NEEDS_HUMAN' || row.last_error_code !== OPERATOR_QUESTION_PARK_REASON) {
      return null;
    }

    const park = db.prepare(`
      SELECT data_json FROM automation_events
      WHERE issue_id = ? AND kind = 'operator_question_parked'
      ORDER BY sequence DESC LIMIT 1
    `).get(issueId) as { data_json: string | null } | undefined;
    const correlationIds = parseCorrelations(park?.data_json);
    if (correlationIds.length === 0) return null;

    const hasTrace = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'coordination_trace'
    `).get() as { present: number } | undefined;
    if (!hasTrace) return null;
    const marks = correlationIds.map(() => '?').join(', ');
    const answers = db.prepare(`
      SELECT q.correlation_id, MIN(a.event_id) AS answer_event_id
      FROM coordination_trace q
      JOIN coordination_trace a
        ON a.task_id = q.task_id
       AND a.correlation_id = q.correlation_id
       AND a.kind = 'human-answer'
       AND a.status = 'completed'
      WHERE q.task_id = ?
        AND q.kind = 'human-question'
        AND q.correlation_id IN (${marks})
      GROUP BY q.correlation_id
    `).all(issueId, ...correlationIds) as Array<{ correlation_id: string; answer_event_id: string }>;
    const answered = new Map(answers.map((answer) => [answer.correlation_id, answer.answer_event_id]));
    if (!correlationIds.every((id) => answered.has(id))) return null;

    const deadEffects = (db.prepare(`
      SELECT COUNT(*) AS count FROM automation_effects
      WHERE issue_id = ? AND status = 'dead'
    `).get(issueId) as { count: number }).count;
    const to: RunState = deadEffects > 0 ? 'SYNC_PENDING' : 'READY';
    if (!ALLOWED_TRANSITIONS.NEEDS_HUMAN.includes(to)) return null;
    if (deadEffects > 0) {
      db.prepare(`
        UPDATE automation_effects
        SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL,
            owner_instance_id = NULL, delivery_token = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE issue_id = ? AND status = 'dead'
      `).run(now, now, issueId);
    }
    const updated = db.prepare(`
      UPDATE automation_runs
      SET state = ?, state_version = state_version + 1,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE issue_id = ? AND state = 'NEEDS_HUMAN' AND state_version = ?
        AND last_error_code = ?
    `).run(to, now, issueId, row.state_version, OPERATOR_QUESTION_PARK_REASON);
    if (updated.changes !== 1) return null;
    event(db, issueId, row.attempt_no, 'operator_resumed', 'NEEDS_HUMAN', to, {
      deadEffectsReset: deadEffects,
      correlationIds,
      answerEventIds: correlationIds.map((id) => answered.get(id)),
    }, now);
    return to;
  });
  return resume.immediate();
}
