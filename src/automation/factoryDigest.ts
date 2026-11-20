// ============================================
// OpenSwarm - Daily factory digest (AGT-4810)
// ============================================
//
// For lights-out operation the operator should have one thing to read a day,
// and stage graduation (shadow -> canary -> expand -> lights-out) is decided
// on numbers. This computes those numbers from what the automation database
// already records, and renders them for Discord and the dashboard.
//
// Every figure says where it comes from. A figure whose input is not recorded
// anywhere yet is reported as "not measured" with the reason, never as 0, never
// estimated and never replaced by a proxy:
// - merges: the automation database records no merge. PR merge state is read
//   from GitHub only to move the tracker (reconcileMergedPublications), and the
//   integration coordinator's merge log lives in the PR processor's state file,
//   baselined per repository and not linked to runs;
// - cycle time: needs the merge time, which is not recorded (see above);
// - human minutes (review, answer, intervention time) are not recorded;
// - post-merge reverts/hotfixes are not linked back to runs;
// - nobody can mark a run "should not have run" yet.
//
// The window is the previous full UTC day [00:00Z, 00:00Z), the same day the
// spend ceiling counts against (runLedgerCost.ts). Definitions within it:
// - Done with a PR: a DONE run with a PR whose tracker state is Done, by the
//   time the ledger recorded it (completed_at). This is NOT a merge count:
//   checked against GitHub on the 2026-10 ledger, 3 of the 5 newest such rows
//   had PRs that were closed unmerged (the issue was moved to Done by hand);
// - published, not Done: a DONE run with a PR whose tracker state is not Done;
// - parked: distinct runs with a `parked`/`operator_parked`/
//   `operator_question_parked` event in the window, and NEEDS_HUMAN runs now;
// - failed by class: attempts finished in the window, by result status;
// - spend: attempts started in the window, per repository, aggregated exactly
//   as the budget does: recorded cost plus each cost-less attempt (other than
//   NO_SPEND_STATUSES and operator remediation) at the budget's estimate;
// - open questions: human-question threads on the coordination trace whose
//   latest status is open, waiting or running, opened in the last 14 days and
//   not attached to a finished run. The trace keeps every thread ever opened
//   and many are never closed (on the 2026-10-20 ledger: 372 "open", 359 with
//   no run at all, the oldest 54 days); those are reported as stale, apart,
//   and only threads active in the last 28 days are read at all;
// - pauses and anomalies: kill-switch rows active now, scopes whose latest
//   lift fell in the window, anomaly-monitor input signals recorded in the
//   window (AGT-4809), and repository circuits open now.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { Cron } from 'croner';
import { NO_SPEND_STATUSES, unknownAttemptEstimateUsd } from './runLedgerCost.js';

/** Money that includes cost-less attempts at an estimate, so the unpriced part stays visible. */
export interface CostFigure {
  /** knownUsd + unpricedAttempts × estimatePerUnpricedUsd. */
  usd: number;
  knownUsd: number;
  unpricedAttempts: number;
  estimatePerUnpricedUsd: number;
}

export interface FactoryDigest {
  from: number;
  to: number;
  runs: {
    merged: NotMeasured;
    doneWithPr: number;
    publishedNotDone: number;
    parkedNow: number;
    /** Distinct runs parked in the window (not park events). */
    parkedRunsInWindow: number;
    finishedByStatus: Record<string, number>;
  };
  /** `staleSince`: threads with no activity after this are not read, so not counted as stale. */
  questions: { open: number; oldestAgeMs?: number; stale: number; staleSince: number };
  spend: Array<{ projectPath: string; attempts: number } & CostFigure>;
  /** Pauses active when the digest was read. */
  pauses: Array<{ scope: string; mode: string; reason: string; actor: string; since: number }>;
  /** Scopes whose latest lift fell in the window (the table keeps one row per scope). */
  pauseLifts: Array<{ scope: string; liftedAt: number }>;
  /** Anomaly-monitor input signals recorded in the window, by kind and repository. */
  signals: Array<{ kind: string; projectPath: string; count: number }>;
  circuits: Array<{ projectPath: string; reason: string; openUntil: number }>;
  kpis: {
    mergedPerHumanMinute: NotMeasured;
    postMergeDefectRate: NotMeasured;
    wrongDispatchRate: NotMeasured;
    cycleTimePerIssue: NotMeasured;
    /** All attempts ever of the issues counted as Done with a PR in the window. */
    costPerDoneIssue?: CostFigure & { issues: number; basis: string };
  };
}

export interface NotMeasured {
  measured: false;
  reason: string;
}

const NO_MERGE_RECORD = 'the automation database records no merge (GitHub merge state only moves the tracker; the PR processor keeps its merge log in its own state file, not linked to runs)';

const NOT_MEASURED = {
  mergedPerHumanMinute: { measured: false, reason: 'human review/answer/intervention minutes are not recorded anywhere yet' },
  postMergeDefectRate: { measured: false, reason: 'reverts and hotfixes are not linked back to the run that merged' },
  wrongDispatchRate: { measured: false, reason: 'there is no way yet to mark a run "should not have run"' },
  cycleTimePerIssue: { measured: false, reason: `needs the merge time: ${NO_MERGE_RECORD}` },
} as const satisfies Record<string, NotMeasured>;

const COST_PER_DONE_BASIS = 'issues the tracker marks Done with a PR, merge not verified; all their attempts';

const DAY_MS = 24 * 60 * 60_000;
/** An unanswered question older than this, or on a finished run, is reported as stale, not as waiting. */
const QUESTION_HORIZON_MS = 14 * DAY_MS;
/** Threads with no activity in twice the horizon are not read at all: the trace is never pruned. */
const QUESTION_READ_BOUND_MS = 2 * QUESTION_HORIZON_MS;
/** Attempts counted as spend: not operator remediation (the budget's filter, runLedgerCost.ts). */
const SPEND_ATTEMPT = "COALESCE(a.result_status, '') != 'operator_remediated'";
const UNPRICED = `CASE WHEN a.cost_usd IS NULL AND COALESCE(a.result_status, '') NOT IN (${NO_SPEND_STATUSES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END`;

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function utcDayStart(now: number): number {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

/** The previous full UTC day before `now`: the digest's window. */
export function previousUtcDay(now: number): { from: number; to: number } {
  const to = utcDayStart(now);
  return { from: to - DAY_MS, to };
}

export interface DigestOptions {
  /** `autonomous.spend.unknownAttemptCostUsd`; unset = the budget's recent-mean estimate. */
  unknownAttemptCostUsd?: number;
}

function emptyDigest(from: number, to: number, now: number): FactoryDigest {
  return {
    from,
    to,
    runs: { merged: { measured: false, reason: NO_MERGE_RECORD }, doneWithPr: 0, publishedNotDone: 0, parkedNow: 0, parkedRunsInWindow: 0, finishedByStatus: {} },
    questions: { open: 0, stale: 0, staleSince: now - QUESTION_READ_BOUND_MS },
    spend: [],
    pauses: [],
    pauseLifts: [],
    signals: [],
    circuits: [],
    kpis: { ...NOT_MEASURED },
  };
}

/** Compute the digest for [from, to) from an open automation database. Read-only. */
export function computeFactoryDigest(
  db: Database.Database,
  window: { from: number; to: number },
  now = window.to,
  options: DigestOptions = {},
): FactoryDigest {
  const { from, to } = window;
  const digest = emptyDigest(from, to, now);
  const estimate = (() => {
    let value: number | undefined;
    return () => (value ??= unknownAttemptEstimateUsd(db, to, options.unknownAttemptCostUsd));
  })();
  const cost = (knownUsd: number, unpriced: number | null): CostFigure => {
    const unpricedAttempts = unpriced ?? 0;
    const each = unpricedAttempts > 0 ? estimate() : 0;
    return { usd: knownUsd + unpricedAttempts * each, knownUsd, unpricedAttempts, estimatePerUnpricedUsd: each };
  };

  if (hasTable(db, 'automation_runs')) {
    const doneWithPr = `state = 'DONE' AND pr_url IS NOT NULL AND tracker_state_type = 'completed' AND completed_at >= ? AND completed_at < ?`;
    digest.runs.doneWithPr = (db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE ${doneWithPr}`).get(from, to) as { n: number }).n;
    digest.runs.publishedNotDone = (db.prepare(`
      SELECT COUNT(*) AS n FROM automation_runs
      WHERE state = 'DONE' AND pr_url IS NOT NULL AND COALESCE(tracker_state_type, '') <> 'completed'
        AND completed_at >= ? AND completed_at < ?
    `).get(from, to) as { n: number }).n;
    digest.runs.parkedNow = (db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE state = 'NEEDS_HUMAN'").get() as { n: number }).n;

    if (hasTable(db, 'automation_events')) {
      digest.runs.parkedRunsInWindow = (db.prepare(`
        SELECT COUNT(DISTINCT issue_id) AS n FROM automation_events
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
      const spendRows = db.prepare(`
        SELECT r.project_path AS projectPath, COUNT(*) AS attempts,
               COALESCE(SUM(a.cost_usd), 0) AS knownUsd, SUM(${UNPRICED}) AS unpriced
        FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
        WHERE a.started_at >= ? AND a.started_at < ? AND ${SPEND_ATTEMPT}
        GROUP BY r.project_path
      `).all(...NO_SPEND_STATUSES, from, to) as Array<{ projectPath: string; attempts: number; knownUsd: number; unpriced: number | null }>;
      digest.spend = spendRows
        .map((row) => ({ projectPath: row.projectPath, attempts: row.attempts, ...cost(row.knownUsd, row.unpriced) }))
        .sort((a, b) => b.usd - a.usd || a.projectPath.localeCompare(b.projectPath));

      if (digest.runs.doneWithPr > 0) {
        const row = db.prepare(`
          SELECT COALESCE(SUM(a.cost_usd), 0) AS knownUsd, SUM(${UNPRICED}) AS unpriced
          FROM automation_attempts a
          WHERE a.issue_id IN (SELECT issue_id FROM automation_runs WHERE ${doneWithPr}) AND ${SPEND_ATTEMPT}
        `).get(...NO_SPEND_STATUSES, from, to) as { knownUsd: number; unpriced: number | null };
        const total = cost(row.knownUsd, row.unpriced);
        const issues = digest.runs.doneWithPr;
        digest.kpis.costPerDoneIssue = {
          usd: total.usd / issues,
          knownUsd: total.knownUsd / issues,
          unpricedAttempts: total.unpricedAttempts,
          estimatePerUnpricedUsd: total.estimatePerUnpricedUsd,
          issues,
          basis: COST_PER_DONE_BASIS,
        };
      }
    }
  }

  if (hasTable(db, 'coordination_trace')) countQuestions(db, digest, now);
  collectPausesAndAnomalies(db, digest, now);
  return digest;
}

/** Active pauses, lifts and signals in the window, and circuits open now. Each table is optional. */
function collectPausesAndAnomalies(db: Database.Database, digest: FactoryDigest, now: number): void {
  const { from, to } = digest;
  if (hasTable(db, 'automation_pauses')) {
    digest.pauses = (db.prepare('SELECT scope, mode, reason, actor, created_at AS since FROM automation_pauses ORDER BY created_at').all() as FactoryDigest['pauses']);
  }
  if (hasTable(db, 'automation_pause_lifts')) {
    digest.pauseLifts = db.prepare(`
      SELECT scope, lifted_at AS liftedAt FROM automation_pause_lifts WHERE lifted_at >= ? AND lifted_at < ? ORDER BY lifted_at, scope
    `).all(from, to) as FactoryDigest['pauseLifts'];
  }
  if (hasTable(db, 'automation_factory_signals')) {
    digest.signals = db.prepare(`
      SELECT kind, project_path AS projectPath, COUNT(*) AS count FROM automation_factory_signals
      WHERE created_at >= ? AND created_at < ? GROUP BY kind, project_path ORDER BY count DESC, kind, project_path
    `).all(from, to) as FactoryDigest['signals'];
  }
  if (hasTable(db, 'automation_repo_circuits')) {
    digest.circuits = db.prepare(`
      SELECT project_path AS projectPath, reason, open_until AS openUntil FROM automation_repo_circuits WHERE open_until > ? ORDER BY open_until
    `).all(now) as FactoryDigest['circuits'];
  }
}

const FINISHED_RUN_STATES = ['DONE', 'CANCELLED', 'DECOMPOSED'];

/**
 * Open and stale human questions. Only threads with a row since
 * `now - QUESTION_READ_BOUND_MS` are read (the time index bounds the scan);
 * the opening time is still the thread's first row, read through the
 * correlation index, so a thread opened long ago and touched lately is stale.
 * Run states are resolved in two batched lookups, not an OR join per thread.
 */
function countQuestions(db: Database.Database, digest: FactoryDigest, now: number): void {
  const threads = db.prepare(`
    WITH recent AS (
      SELECT correlation_id, MAX(id) AS last_id FROM coordination_trace
      WHERE timestamp >= ? GROUP BY correlation_id
    )
    SELECT r.correlation_id AS id, l.status AS status, l.task_id AS taskId, l.task_label AS taskLabel,
           (SELECT MIN(f.timestamp) FROM coordination_trace f WHERE f.correlation_id = r.correlation_id) AS openedAt
    FROM recent r JOIN coordination_trace l ON l.id = r.last_id
    WHERE l.kind = 'human-question' AND l.status IN ('open', 'waiting', 'running')
  `).all(digest.questions.staleSince) as Array<{ id: string; status: string; taskId: string | null; taskLabel: string | null; openedAt: number }>;

  const byIssue = new Map<string, string>();
  const byLabel = new Map<string, string>();
  if (threads.length > 0 && hasTable(db, 'automation_runs')) {
    const lookup = (column: 'issue_id' | 'identifier', keys: string[], into: Map<string, string>) => {
      for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500);
        const rows = db.prepare(`SELECT ${column} AS k, state FROM automation_runs WHERE ${column} IN (${chunk.map(() => '?').join(', ')})`)
          .all(...chunk) as Array<{ k: string; state: string }>;
        for (const row of rows) if (!into.has(row.k)) into.set(row.k, row.state);
      }
    };
    lookup('issue_id', [...new Set(threads.map((t) => t.taskId).filter((v): v is string => !!v))], byIssue);
    lookup('identifier', [...new Set(threads.map((t) => t.taskLabel).filter((v): v is string => !!v))], byLabel);
  }
  const runState = (t: { taskId: string | null; taskLabel: string | null }) =>
    (t.taskId ? byIssue.get(t.taskId) : undefined) ?? (t.taskLabel ? byLabel.get(t.taskLabel) : undefined) ?? '';

  const live = threads.filter((t) => now - t.openedAt <= QUESTION_HORIZON_MS && !FINISHED_RUN_STATES.includes(runState(t)));
  digest.questions.open = live.length;
  digest.questions.stale = threads.length - live.length;
  if (live.length > 0) digest.questions.oldestAgeMs = now - Math.min(...live.map((t) => t.openedAt));
}

/**
 * Open the database read-only (the daemon is the writer) and compute the
 * digest for the previous full UTC day before `now`.
 */
export function readFactoryDigest(dbPath: string, now = Date.now(), options: DigestOptions = {}): FactoryDigest {
  const window = previousUtcDay(now);
  const db = existsSync(dbPath)
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : new Database(':memory:');
  try {
    db.pragma('busy_timeout = 5000');
    return computeFactoryDigest(db, window, now, options);
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

/** `across`: the figure is a per-issue mean, and the unpriced count is over that many issues. */
function usd(figure: CostFigure, across?: number): string {
  const scope = across !== undefined ? ` across ${across} issues` : '';
  const unpriced = figure.unpricedAttempts > 0
    ? ` (${figure.unpricedAttempts} unpriced${scope} at ~$${figure.estimatePerUnpricedUsd.toFixed(2)} est.)`
    : '';
  return `$${figure.usd.toFixed(2)}${unpriced}`;
}

function capped(items: string[], max: number): string[] {
  return items.length > max ? [...items.slice(0, max), `… and ${items.length - max} more`] : items;
}

function windowLabel(from: number, to: number): string {
  const range = `${new Date(from).toISOString().slice(0, 16)}Z → ${new Date(to).toISOString().slice(0, 16)}Z`;
  return to - from === DAY_MS && utcDayStart(from) === from ? `UTC day ${new Date(from).toISOString().slice(0, 10)} (${range})` : range;
}

export const KPI_HEADING = '**KPIs**';

/**
 * The digest as text. Plain lines, one section per question the operator
 * asks. `maxItems` caps each list (the JSON digest keeps every row).
 */
export function formatFactoryDigest(d: FactoryDigest, options: { maxItems?: number } = {}): string {
  const max = options.maxItems ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  lines.push(`📋 **Factory digest** ${windowLabel(d.from, d.to)}`);
  const finished = Object.entries(d.runs.finishedByStatus).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
  lines.push(`**Runs merged**: not measured (${d.runs.merged.reason})`);
  lines.push(`**Runs**: Done with a PR ${d.runs.doneWithPr} (tracker state; merge not verified), published not Done ${d.runs.publishedNotDone}, parked runs ${d.runs.parkedRunsInWindow} in window / ${d.runs.parkedNow} now`);
  lines.push(`**Attempts finished**: ${finished}`);
  const staleSince = new Date(d.questions.staleSince).toISOString().slice(0, 10);
  lines.push(`**Questions waiting on you**: ${d.questions.open}${d.questions.oldestAgeMs !== undefined ? `, oldest ${hours(d.questions.oldestAgeMs)}` : ''}${d.questions.stale ? ` (${d.questions.stale} stale threads never closed, active since ${staleSince}, not counted)` : ''}`);
  lines.push(`**Spend** (attempts started in the window; unpriced attempts at the budget's estimate): ${d.spend.length ? '' : 'none'}`);
  for (const line of capped(d.spend.map((s) => `${repoName(s.projectPath)} ${usd(s)}, ${s.attempts} attempts`), max)) lines.push(`  ${line}`);
  const stops = [
    ...d.pauses.map((p) => `⏸ ${repoName(p.scope)} paused now (${p.mode}, ${p.actor}): ${p.reason}`),
    ...d.pauseLifts.map((l) => `▶ ${repoName(l.scope)} pause lifted ${new Date(l.liftedAt).toISOString().slice(11, 16)}Z`),
    ...d.signals.map((s) => `⚑ ${s.kind} ×${s.count} (${repoName(s.projectPath)})`),
    ...d.circuits.map((c) => `⚡ ${repoName(c.projectPath)} circuit until ${new Date(c.openUntil).toISOString().slice(11, 16)}Z: ${c.reason}`),
  ];
  lines.push(`**Pauses / anomalies**: ${stops.length ? '' : 'none'}`);
  for (const stop of capped(stops, max)) lines.push(`  ${stop}`);
  const k = d.kpis;
  lines.push(KPI_HEADING);
  lines.push(`  cost per Done issue (${COST_PER_DONE_BASIS}): ${k.costPerDoneIssue ? `${usd(k.costPerDoneIssue, k.costPerDoneIssue.issues)} per issue` : 'n/a (nothing Done)'}`);
  for (const [name, value] of [
    ['cycle time per issue', k.cycleTimePerIssue],
    ['merged changes per human minute', k.mergedPerHumanMinute],
    ['post-merge defect rate (7 d)', k.postMergeDefectRate],
    ['wrong-dispatch rate', k.wrongDispatchRate],
  ] as const) {
    lines.push(`  ${name}: not measured (${value.reason})`);
  }
  return lines.join('\n');
}

/** Discord rejects a message over 2,000 characters. */
export const DISCORD_DIGEST_LIMIT = 1900;
const CUT_MARKER = '… (cut to fit Discord; full digest on the dashboard)';

/**
 * Fit the digest into one Discord message by dropping whole lines from the
 * end of the sections before the KPIs, so no line or markdown span is cut and
 * the KPI section is always kept.
 */
export function fitForDiscord(text: string, limit = DISCORD_DIGEST_LIMIT): string {
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  const at = lines.indexOf(KPI_HEADING);
  const head = at >= 0 ? lines.slice(0, at) : lines;
  const tail = at >= 0 ? lines.slice(at) : [];
  const join = () => [...head, CUT_MARKER, ...tail].join('\n');
  while (head.length > 1 && join().length > limit) head.pop();
  // Last resort (the KPI section alone over the limit): drop its last lines.
  while (tail.length > 1 && join().length > limit) tail.pop();
  return join();
}

/** Default: shortly after 00:00 UTC, once the previous UTC day is complete. */
export const DEFAULT_FACTORY_DIGEST_SCHEDULE = '5 0 * * *';
const DISCORD_LIST_ITEMS = 5;

/**
 * Send the digest once a day, evaluated in UTC (the window is a UTC day).
 * Returns a stop function. A failed read or send is logged and retried at the
 * next tick; it never throws into the daemon.
 */
export function startFactoryDigest(opts: {
  schedule?: string;
  timezone?: string;
  dbPath: () => string;
  send: (text: string) => Promise<void>;
  unknownAttemptCostUsd?: () => number | undefined;
}): () => void {
  const job = new Cron(opts.schedule ?? DEFAULT_FACTORY_DIGEST_SCHEDULE, { timezone: opts.timezone ?? 'UTC' }, async () => {
    try {
      const digest = readFactoryDigest(opts.dbPath(), Date.now(), { unknownAttemptCostUsd: opts.unknownAttemptCostUsd?.() });
      await opts.send(fitForDiscord(formatFactoryDigest(digest, { maxItems: DISCORD_LIST_ITEMS })));
    } catch (error) {
      console.warn('[FactoryDigest] Digest failed:', error instanceof Error ? error.message : error);
    }
  });
  return () => job.stop();
}
