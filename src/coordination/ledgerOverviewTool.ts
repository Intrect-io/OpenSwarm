// ============================================
// OpenSwarm - ledger_overview coordination tool (AGT-4184)
// ============================================
//
// Gives the orchestrator role read access to what the operator saw on
// 2026-09-02 while triaging the daemon by hand: parked runs and why, the
// day's failure buckets, and runs stuck cycling with unusually high attempt
// counts. Read-only, bounded, and never throws into the agent loop.

import Database from 'better-sqlite3';
import { defaultAutomationDbPath } from '../automation/automationDbPath.js';
import { aggregateFailureBuckets, type FailureBucket } from '../automation/ledgerRetrospective.js';
import type { ToolDefinition } from '../adapters/tools.js';

/** Runs that have reached a terminal or human-owned state; excluded from attempt-outlier ranking. */
const NON_CYCLING_STATES = new Set(['DONE', 'CANCELLED', 'DECOMPOSED', 'NEEDS_HUMAN']);

const FAILURE_BUCKET_WINDOW_MS = 24 * 60 * 60 * 1000;
const PARKED_RUNS_LIMIT = 20;
const ATTEMPT_OUTLIERS_LIMIT = 5;
const FAILURE_BUCKETS_LIMIT = 5;

export interface ParkedRunSummary {
  identifier: string | null;
  parkedUnder: string | null;
  reason: string;
  ageMinutes: number;
  prUrl: string | null;
}

export interface AttemptOutlierSummary {
  identifier: string | null;
  attemptNo: number;
  state: string;
}

export interface LedgerOverview {
  parkedRuns: ParkedRunSummary[];
  failureBuckets: Array<Pick<FailureBucket, 'fingerprint' | 'attempts' | 'distinctIssues' | 'identifiers'>>;
  attemptOutliers: AttemptOutlierSummary[];
}

interface ParkedRunRow {
  identifier: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: number;
  pr_url: string | null;
}

interface AttemptOutlierRow {
  identifier: string | null;
  attempt_no: number;
  state: string;
}

export function buildLedgerOverview(dbPath?: string, now: number = Date.now()): LedgerOverview {
  const db = new Database(dbPath ?? defaultAutomationDbPath(), { readonly: true });
  try {
    const parkedRows = db.prepare(`
      SELECT identifier, last_error_code, last_error_message, updated_at, pr_url
      FROM automation_runs
      WHERE state = 'NEEDS_HUMAN'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(PARKED_RUNS_LIMIT) as ParkedRunRow[];

    const parkedRuns: ParkedRunSummary[] = parkedRows.map((row) => ({
      identifier: row.identifier,
      parkedUnder: row.last_error_code,
      reason: (row.last_error_message ?? '').slice(0, 200),
      ageMinutes: Math.max(0, Math.round((now - row.updated_at) / 60_000)),
      prUrl: row.pr_url,
    }));

    const failureBuckets = aggregateFailureBuckets(db, now - FAILURE_BUCKET_WINDOW_MS)
      .slice(0, FAILURE_BUCKETS_LIMIT)
      .map(({ fingerprint, attempts, distinctIssues, identifiers }) => ({ fingerprint, attempts, distinctIssues, identifiers }));

    const placeholders = [...NON_CYCLING_STATES].map(() => '?').join(', ');
    const outlierRows = db.prepare(`
      SELECT identifier, attempt_no, state
      FROM automation_runs
      WHERE state NOT IN (${placeholders})
      ORDER BY attempt_no DESC
      LIMIT ?
    `).all(...NON_CYCLING_STATES, ATTEMPT_OUTLIERS_LIMIT) as AttemptOutlierRow[];

    const attemptOutliers: AttemptOutlierSummary[] = outlierRows.map((row) => ({
      identifier: row.identifier,
      attemptNo: row.attempt_no,
      state: row.state,
    }));

    return { parkedRuns, failureBuckets, attemptOutliers };
  } finally {
    db.close();
  }
}

export const LEDGER_OVERVIEW_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ledger_overview',
    description:
      'Read-only snapshot of this deployment\'s own run ledger: parked (NEEDS_HUMAN) runs and why, the last 24h\'s failure buckets, and runs with unusually high attempt counts still cycling. Use this before asking the operator what is stuck — it is what they would look up by hand.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** `{error}` on any failure — a broken or absent ledger must not throw into the agent loop. */
export function executeLedgerOverview(): { content: string; isError: boolean } {
  try {
    return { content: JSON.stringify(buildLedgerOverview()), isError: false };
  } catch (error) {
    return {
      content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      isError: true,
    };
  }
}
