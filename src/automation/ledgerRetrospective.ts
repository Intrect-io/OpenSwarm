// ============================================
// OpenSwarm - Ledger retrospective lane
// ============================================
//
// The daemon files its own top-failure-bucket issue. On 2026-09-02 the
// deployed runner spent hundreds of attempts publishing zero PRs while every
// underlying defect was visible in three fixed ledger queries; the operator's
// per-tick steering — aggregate failures, pick the largest bucket, file one
// evidence-rich issue, let the normal pipeline work it — is algorithmic, so
// it runs here as a deterministic job. No LLM is involved in measurement: the
// intelligence is spent by the worker that picks the filed issue up.

import Database from 'better-sqlite3';
import { normalizeErrorForLoop } from '../support/stuckDetector.js';
import { defaultAutomationDbPath } from './automationDbPath.js';
import type { TaskState } from './taskSource.js';

/** How far back a run's attempts count toward a bucket. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most one filed issue per this interval, whatever the ledger holds. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A fingerprint that was already filed stays quiet for this long. */
const DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Noise floor: a bucket is only worth an issue when it repeats across issues.
 * Eagerly filed findings measured 79% noise on AGT-4088 (2026-09-02); a
 * systemic defect shows up as the same failure on unrelated tasks.
 */
const MIN_ATTEMPTS = 6;
const MIN_DISTINCT_ISSUES = 2;

const LAST_RUN_KEY = 'retrospective_last_run_at';
const FINGERPRINT_KEY_PREFIX = 'retrospective_filed:';

export interface FailureBucket {
  fingerprint: string;
  attempts: number;
  distinctIssues: number;
  maxAttemptNo: number;
  /** Up to five example issue identifiers, most-attempted first. */
  identifiers: string[];
  /** One raw error message, verbatim, as evidence. */
  example: string;
}

interface AttemptRow {
  identifier: string | null;
  attempt_no: number;
  error_message: string;
}

/** Aggregate the window's failed attempts into normalized failure buckets, largest first. */
export function aggregateFailureBuckets(db: Database.Database, since: number): FailureBucket[] {
  const rows = db.prepare(`
    SELECT r.identifier, a.attempt_no, a.error_message
    FROM automation_attempts a JOIN automation_runs r USING (issue_id)
    WHERE a.finished_at >= ? AND a.error_message IS NOT NULL AND a.error_message != ''
      AND (a.success IS NULL OR a.success = 0)
  `).all(since) as AttemptRow[];

  const buckets = new Map<string, FailureBucket & { issueAttempts: Map<string, number> }>();
  for (const row of rows) {
    const fingerprint = normalizeErrorForLoop(row.error_message).slice(0, 160);
    if (!fingerprint) continue;
    let bucket = buckets.get(fingerprint);
    if (!bucket) {
      bucket = { fingerprint, attempts: 0, distinctIssues: 0, maxAttemptNo: 0, identifiers: [], example: row.error_message, issueAttempts: new Map() };
      buckets.set(fingerprint, bucket);
    }
    bucket.attempts += 1;
    bucket.maxAttemptNo = Math.max(bucket.maxAttemptNo, row.attempt_no);
    const id = row.identifier ?? 'unknown';
    bucket.issueAttempts.set(id, (bucket.issueAttempts.get(id) ?? 0) + 1);
  }

  return [...buckets.values()]
    .map(({ issueAttempts, ...bucket }) => ({
      ...bucket,
      distinctIssues: issueAttempts.size,
      identifiers: [...issueAttempts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id),
    }))
    .sort((a, b) => b.attempts - a.attempts || b.distinctIssues - a.distinctIssues);
}

/** The filed issue's title and body, templated from measured numbers only. */
export function composeRetrospectiveIssue(bucket: FailureBucket, windowHours: number): { title: string; description: string } {
  const title = `[Retrospective] ${bucket.fingerprint.slice(0, 90)}`;
  const description = [
    '## Measured (auto-filed by the ledger retrospective lane)',
    '',
    `The largest failure bucket of the last ${windowHours}h on this deployment's own run ledger:`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Failed attempts | ${bucket.attempts} |`,
    `| Distinct issues | ${bucket.distinctIssues} (${bucket.identifiers.join(', ')}) |`,
    `| Highest attempt number | ${bucket.maxAttemptNo} |`,
    '',
    '**Verbatim example:**',
    '',
    '```',
    bucket.example.slice(0, 600),
    '```',
    '',
    '## Task',
    '',
    'Find the systemic cause of this bucket in the runner/pipeline code — not in the individual tasks that hit it — and fix it at the root. The attempts above are symptoms; a fix that merely retries them differently is not done.',
    '',
    '## DoD',
    '',
    '- [ ] Root cause named, with the code path that produced the bucket',
    '- [ ] Fix with a regression test that reproduces the bucket shape',
    '- [ ] typecheck / lint / tests green',
  ].join('\n');
  return { title, description };
}

export interface RetrospectiveTaskSource {
  createTask(title: string, description: string, projectId?: string): Promise<{ id: string; identifier?: string; title?: string } | { error: string }>;
  updateState(issueId: string, state: TaskState): Promise<boolean>;
}

export interface RetrospectiveResult {
  filed: boolean;
  reason: string;
  identifier?: string;
}

/**
 * Run one retrospective pass: gate on interval, aggregate, gate on noise floor
 * and fingerprint dedupe, then file exactly one issue and put it in Todo so
 * the heartbeat works it like any other task. Every gate is recorded in the
 * returned reason so a silent pass is still explainable from the log line.
 */
export async function runLedgerRetrospective(options: {
  taskSource: RetrospectiveTaskSource;
  projectId: string;
  dbPath?: string;
  now?: number;
}): Promise<RetrospectiveResult> {
  const now = options.now ?? Date.now();
  const db = new Database(options.dbPath ?? defaultAutomationDbPath());
  try {
    // The ledger owns this table; a retrospective running against a fresh
    // database before the first RunLedger open must not crash on it.
    db.exec('CREATE TABLE IF NOT EXISTS automation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const readMeta = db.prepare('SELECT value FROM automation_meta WHERE key = ?');
    const writeMeta = db.prepare('INSERT INTO automation_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    const lastRun = Number((readMeta.get(LAST_RUN_KEY) as { value: string } | undefined)?.value ?? 0);
    if (now - lastRun < INTERVAL_MS) return { filed: false, reason: 'interval' };

    const buckets = aggregateFailureBuckets(db, now - WINDOW_MS);
    const eligible = buckets.find((bucket) => {
      if (bucket.attempts < MIN_ATTEMPTS || bucket.distinctIssues < MIN_DISTINCT_ISSUES) return false;
      const filedAt = Number((readMeta.get(FINGERPRINT_KEY_PREFIX + bucket.fingerprint) as { value: string } | undefined)?.value ?? 0);
      return now - filedAt >= DEDUPE_MS;
    });
    // The interval stamp is written on every completed pass, found bucket or
    // not — a quiet day must not make the next pass run early.
    writeMeta.run(LAST_RUN_KEY, String(now));
    if (!eligible) return { filed: false, reason: buckets.length === 0 ? 'no failures in window' : 'no bucket above the noise floor' };

    const issue = composeRetrospectiveIssue(eligible, WINDOW_MS / 3_600_000);
    const created = await options.taskSource.createTask(issue.title, issue.description, options.projectId);
    if ('error' in created) return { filed: false, reason: `createTask: ${created.error}` };
    // Todo is what admits it to the heartbeat; a filing that stays in the
    // default triage state would be a report, not a lane.
    await options.taskSource.updateState(created.id, 'Todo');
    writeMeta.run(FINGERPRINT_KEY_PREFIX + eligible.fingerprint, String(now));
    return { filed: true, reason: `filed for bucket "${eligible.fingerprint.slice(0, 60)}" (${eligible.attempts} attempts / ${eligible.distinctIssues} issues)`, identifier: created.identifier ?? created.id };
  } finally {
    db.close();
  }
}
