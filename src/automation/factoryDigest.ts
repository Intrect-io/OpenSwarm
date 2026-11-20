// ============================================
// OpenSwarm - Daily factory digest (AGT-4810)
// ============================================
//
// For lights-out operation the operator should have one thing to read a day,
// and stage graduation (shadow -> canary -> expand -> lights-out) is decided
// on numbers. This computes those numbers from what the automation database
// already records, and renders them for Discord and the dashboard.
//
// Every figure says where it comes from. A KPI whose input is not recorded
// anywhere yet is reported as "not measured" with the reason, never as 0 and
// never estimated:
// - human minutes (review, answer, intervention time) are not recorded;
// - post-merge reverts/hotfixes are not linked back to runs;
// - nobody can mark a run "should not have run" yet.
//
// Definitions (the window is [from, to)):
// - done with a PR: a DONE run with a PR whose tracker state is Done, by the
//   time the ledger recorded it (completed_at). This is NOT a merge count:
//   checked against GitHub on the 2026-10 ledger, 3 of the 5 newest such rows
//   had PRs that were closed unmerged (the issue was moved to Done by hand)
//   and completed_at is when the tracker was read, weeks after the merge for
//   the other two. A merge count needs the PR state read back (follow-up);
// - published, not Done: a DONE run with a PR whose tracker state is not Done;
// - parked: NEEDS_HUMAN runs now, and `parked`/`operator_parked`/
//   `operator_question_parked` events in the window;
// - failed by class: attempts finished in the window, by result status;
// - spend: attempt cost_usd started in the window, per repository; attempts
//   with no recorded cost are counted, not priced;
// - open questions: human-question threads on the coordination trace whose
//   latest status is open, waiting or running, opened in the last 14 days and
//   not attached to a finished run. The trace keeps every thread ever opened
//   and many are never closed (on the 2026-10-20 ledger: 372 "open", 359 with
//   no run at all, the oldest 54 days); those are reported as stale, apart;
// - pauses and anomalies: kill-switch rows (AGT-4808/4809, when that table
//   exists) and repository circuits open now.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { Cron } from 'croner';

export interface FactoryDigest {
  from: number;
  to: number;
  runs: {
    doneWithPr: number;
    publishedNotDone: number;
    parkedNow: number;
    parkedInWindow: number;
    finishedByStatus: Record<string, number>;
  };
  questions: { open: number; oldestAgeMs?: number; stale: number };
  spend: Array<{ projectPath: string; costUsd: number; attempts: number; attemptsWithoutCost: number }>;
  pauses: Array<{ scope: string; mode: string; reason: string; actor: string; since: number }>;
  circuits: Array<{ projectPath: string; reason: string; openUntil: number }>;
  kpis: {
    mergedPerHumanMinute: NotMeasured;
    postMergeDefectRate: NotMeasured;
    wrongDispatchRate: NotMeasured;
    costPerDoneIssueUsd?: number;
    medianCycleTimeMs?: number;
  };
}

export interface NotMeasured {
  measured: false;
  reason: string;
}

const NOT_MEASURED = {
  mergedPerHumanMinute: { measured: false, reason: 'human review/answer/intervention minutes are not recorded anywhere yet' },
  postMergeDefectRate: { measured: false, reason: 'reverts and hotfixes are not linked back to the run that merged' },
  wrongDispatchRate: { measured: false, reason: 'there is no way yet to mark a run "should not have run"' },
} as const satisfies Record<string, NotMeasured>;

/** An unanswered question older than this, or on a finished run, is reported as stale, not as waiting. */
const QUESTION_HORIZON_MS = 14 * 24 * 60 * 60_000;

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute the digest for [from, to) from an open automation database. Read-only. */
export function computeFactoryDigest(db: Database.Database, window: { from: number; to: number }, now = window.to): FactoryDigest {
  const { from, to } = window;
  const digest: FactoryDigest = {
    from,
    to,
    runs: { doneWithPr: 0, publishedNotDone: 0, parkedNow: 0, parkedInWindow: 0, finishedByStatus: {} },
    questions: { open: 0, stale: 0 },
    spend: [],
    pauses: [],
    circuits: [],
    kpis: { ...NOT_MEASURED },
  };

  if (hasTable(db, 'automation_runs')) {
    const merged = db.prepare(`
      SELECT issue_id, discovered_at, completed_at FROM automation_runs
      WHERE state = 'DONE' AND pr_url IS NOT NULL AND tracker_state_type = 'completed'
        AND completed_at >= ? AND completed_at < ?
    `).all(from, to) as Array<{ issue_id: string; discovered_at: number; completed_at: number }>;
    digest.runs.doneWithPr = merged.length;
    digest.runs.publishedNotDone = (db.prepare(`
      SELECT COUNT(*) AS n FROM automation_runs
      WHERE state = 'DONE' AND pr_url IS NOT NULL AND COALESCE(tracker_state_type, '') <> 'completed'
        AND completed_at >= ? AND completed_at < ?
    `).get(from, to) as { n: number }).n;
    digest.runs.parkedNow = (db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE state = 'NEEDS_HUMAN'").get() as { n: number }).n;

    if (hasTable(db, 'automation_events')) {
      digest.runs.parkedInWindow = (db.prepare(`
        SELECT COUNT(*) AS n FROM automation_events
        WHERE kind IN ('parked', 'operator_parked', 'operator_question_parked') AND created_at >= ? AND created_at < ?
      `).get(from, to) as { n: number }).n;
    }

    if (hasTable(db, 'automation_attempts')) {
      for (const row of db.prepare(`
        SELECT COALESCE(result_status, status) AS status, COUNT(*) AS n FROM automation_attempts
        WHERE finished_at >= ? AND finished_at < ? GROUP BY 1 ORDER BY 2 DESC, 1
      `).all(from, to) as Array<{ status: string; n: number }>) {
        digest.runs.finishedByStatus[row.status] = row.n;
      }
      digest.spend = (db.prepare(`
        SELECT r.project_path AS projectPath,
               COALESCE(SUM(a.cost_usd), 0) AS costUsd,
               COUNT(*) AS attempts,
               SUM(CASE WHEN a.cost_usd IS NULL THEN 1 ELSE 0 END) AS attemptsWithoutCost
        FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
        WHERE a.started_at >= ? AND a.started_at < ?
        GROUP BY r.project_path ORDER BY costUsd DESC, r.project_path
      `).all(from, to) as FactoryDigest['spend']);

      if (merged.length > 0) {
        const cost = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM automation_attempts WHERE issue_id = ?`);
        const total = merged.reduce((sum, run) => sum + (cost.get(run.issue_id) as { c: number }).c, 0);
        digest.kpis.costPerDoneIssueUsd = total / merged.length;
      }
    }
    digest.kpis.medianCycleTimeMs = median(merged.map((run) => run.completed_at - run.discovered_at));
  }

  if (hasTable(db, 'coordination_trace')) {
    const runState = hasTable(db, 'automation_runs')
      ? '(SELECT r.state FROM automation_runs r WHERE r.issue_id = t.task_id OR r.identifier = t.task_label LIMIT 1)'
      : 'NULL';
    const threads = db.prepare(`
      SELECT t.correlation_id AS id, t.status AS status, ${runState} AS runState,
             (SELECT MIN(timestamp) FROM coordination_trace f WHERE f.correlation_id = t.correlation_id) AS openedAt
      FROM coordination_trace t
      WHERE t.kind = 'human-question'
        AND t.id = (SELECT MAX(id) FROM coordination_trace l WHERE l.correlation_id = t.correlation_id)
    `).all() as Array<{ id: string; status: string; runState: string | null; openedAt: number }>;
    const unanswered = threads.filter((t) => ['open', 'waiting', 'running'].includes(t.status));
    const live = unanswered.filter((t) => now - t.openedAt <= QUESTION_HORIZON_MS
      && !['DONE', 'CANCELLED', 'DECOMPOSED'].includes(t.runState ?? ''));
    digest.questions.open = live.length;
    digest.questions.stale = unanswered.length - live.length;
    if (live.length > 0) digest.questions.oldestAgeMs = now - Math.min(...live.map((t) => t.openedAt));
  }

  if (hasTable(db, 'automation_pauses')) {
    digest.pauses = (db.prepare('SELECT scope, mode, reason, actor, created_at AS since FROM automation_pauses ORDER BY created_at').all() as FactoryDigest['pauses']);
  }
  if (hasTable(db, 'automation_repo_circuits')) {
    digest.circuits = db.prepare(`
      SELECT project_path AS projectPath, reason, open_until AS openUntil FROM automation_repo_circuits WHERE open_until > ? ORDER BY open_until
    `).all(now) as FactoryDigest['circuits'];
  }
  return digest;
}

/** Open the database read-only (the daemon is the writer) and compute the digest for the 24 hours before `now`. */
export function readFactoryDigest(dbPath: string, now = Date.now()): FactoryDigest {
  const window = { from: now - 24 * 60 * 60_000, to: now };
  if (!existsSync(dbPath)) return computeFactoryDigest(new Database(':memory:'), window, now);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return computeFactoryDigest(db, window, now);
  } finally {
    db.close();
  }
}

function hours(ms: number): string {
  return ms < 60 * 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / (60 * 60_000)).toFixed(1)}h`;
}

function repoName(path: string): string {
  return path === '*' ? 'factory' : path.split('/').pop() || path;
}

/** The Discord text. Plain lines, one section per question the operator asks. */
export function formatFactoryDigest(d: FactoryDigest): string {
  const lines: string[] = [];
  lines.push(`📋 **Factory digest** ${new Date(d.from).toISOString().slice(0, 16)}Z → ${new Date(d.to).toISOString().slice(0, 16)}Z`);
  const finished = Object.entries(d.runs.finishedByStatus).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
  lines.push(`**Runs**: Done with a PR ${d.runs.doneWithPr} (tracker; merge not verified), published not Done ${d.runs.publishedNotDone}, parked ${d.runs.parkedInWindow} in window / ${d.runs.parkedNow} now`);
  lines.push(`**Attempts finished**: ${finished}`);
  lines.push(`**Questions waiting on you**: ${d.questions.open}${d.questions.oldestAgeMs !== undefined ? `, oldest ${hours(d.questions.oldestAgeMs)}` : ''}${d.questions.stale ? ` (${d.questions.stale} stale threads never closed, not counted)` : ''}`);
  const spend = d.spend.map((s) => `${repoName(s.projectPath)} $${s.costUsd.toFixed(2)} (${s.attempts} attempts${s.attemptsWithoutCost ? `, ${s.attemptsWithoutCost} unpriced` : ''})`);
  lines.push(`**Spend**: ${spend.length ? spend.join('; ') : 'none'}`);
  const stops = [
    ...d.pauses.map((p) => `⏸ ${repoName(p.scope)} (${p.mode}, ${p.actor}): ${p.reason}`),
    ...d.circuits.map((c) => `⚡ ${repoName(c.projectPath)} circuit until ${new Date(c.openUntil).toISOString().slice(11, 16)}Z: ${c.reason}`),
  ];
  lines.push(`**Pauses / anomalies**: ${stops.length ? '' : 'none'}`);
  for (const stop of stops) lines.push(`  ${stop}`);
  const k = d.kpis;
  lines.push('**KPIs**');
  lines.push(`  cost per Done issue: ${k.costPerDoneIssueUsd !== undefined ? `$${k.costPerDoneIssueUsd.toFixed(2)}` : 'n/a (nothing Done)'}`);
  lines.push(`  median cycle time (discovered → Done recorded): ${k.medianCycleTimeMs !== undefined ? hours(k.medianCycleTimeMs) : 'n/a (nothing Done)'}`);
  for (const [name, value] of [
    ['merged changes per human minute', k.mergedPerHumanMinute],
    ['post-merge defect rate (7 d)', k.postMergeDefectRate],
    ['wrong-dispatch rate', k.wrongDispatchRate],
  ] as const) {
    lines.push(`  ${name}: not measured (${value.reason})`);
  }
  return lines.join('\n');
}

/**
 * Send the digest once a day. Returns a stop function. A failed read or send
 * is logged and retried at the next tick; it never throws into the daemon.
 */
export function startFactoryDigest(opts: { schedule: string; dbPath: () => string; send: (text: string) => Promise<void> }): () => void {
  const job = new Cron(opts.schedule, async () => {
    try {
      const text = formatFactoryDigest(readFactoryDigest(opts.dbPath()));
      // Discord rejects a message over 2,000 characters; the dashboard has the full digest.
      await opts.send(text.length > 1900 ? `${text.slice(0, 1880)}\n… (full digest on the dashboard)` : text);
    } catch (error) {
      console.warn('[FactoryDigest] Digest failed:', error instanceof Error ? error.message : error);
    }
  });
  return () => job.stop();
}
