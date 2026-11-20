// ============================================
// OpenSwarm - Anomaly auto-pause (AGT-4809)
// ============================================
//
// On 2026-10-20 the factory ran for hours in a degenerate state on one
// repository before anyone looked: 25 unreviewed PRs, the same issues claimed
// again and again, a growing share of infra_error runs. Every one of those
// signals was in the ledger; nothing acted on it.
//
// This module turns those signals into the kill switch (AGT-4808). Once per
// heartbeat, for each repository, it reads what the ledger and the signal
// table already hold and, when a threshold is crossed, writes an `auto:<signal>`
// pause for that repository and sends one alert. It never lifts a pause: an
// operator does, with `openswarm unpause` or the dashboard. Observations from
// before that lift are not counted again, so a resume is not undone by the
// next heartbeat re-reading the same history.
//
// Disk space is here too (`auto:disk`): the heartbeat hands over the AGT-4785
// free-disk measurement, and a reading below `autonomous.minFreeDiskGiB`
// writes a factory-wide pause, because a full disk is a host problem, not one
// repository's.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { GLOBAL_PAUSE_SCOPE, PAUSE_TABLE_DDL, listPausesInDb, type FactoryPause, type PauseMode } from './factoryPause.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';

export { nonLoopbackConnectDenial } from '../support/sandboxNetworkSignal.js';

export type AnomalySignal = 'pr_rate' | 'draft_pr_rate' | 'redispatch' | 'infra_error_share' | 'sandbox_network' | 'disk';

export interface AnomalyThresholds {
  /** Pause when this many PRs (draft or ready) are opened from one repository within 60 minutes. */
  maxPrsPerHour: number;
  /** Pause when this many DRAFT PRs (unreviewed work: parked or stuck runs) are opened within 60 minutes. */
  maxDraftPrsPerHour: number;
  /** Pause when one issue is claimed this many times beyond its first within 24 hours. */
  maxRedispatchesPer24h: number;
  /** How many of the most recent finished runs the infra_error share is taken over. */
  infraErrorWindow: number;
  /** Trip when infra_error runs make up at least this share of that window (0..1). */
  maxInfraErrorShare: number;
  /** Trip on any sandbox EPERM for a non-loopback connect. */
  sandboxNetworkDenial: boolean;
  /** What a trip pauses: this repository (default) or the whole factory (`*`). */
  pauseScope: 'project' | 'factory';
}

/**
 * Defaults.
 *
 * PR rate is two signals. On 2026-10-20 the factory published 25 DRAFT PRs for
 * runs that never finished (publishParkedWork / publishStuckWork open drafts);
 * a healthy factory opens ready PRs from approved runs. So drafts are the
 * degenerate signal and get the tight limit, 2 per hour: replaying that night
 * through the heartbeat path (15-minute default schedule) pauses at 14:00Z,
 * 43 minutes after the first claim, the AGT-4809 acceptance line. The same
 * timeline as ready PRs does not trip in the first hour under the all-PR limit.
 *
 * The all-PR limit stays 3. Measured on this repository's own swarm PRs
 * (12 days with any, 2026-03-07..09-29, `gh pr list`), the busiest hour held
 * 1 PR on 2 days, 2 on 4, 3 on 4, 4 on 1 and 9 on 1: a limit of 3 still trips
 * on 6 of those 12 days (2 would on 10). A busy repository should raise
 * `automation.anomaly.maxPrsPerHour` in its openswarm.json.
 *
 * Re-dispatch is set high on purpose. Replayed over every project-day in the
 * same ledger (32 of them, 2026-07-21..10-20), a limit of 3 tripped on 22,
 * 6 on 20 and 10 on 13: retrying a failed issue a few times a day is normal
 * there. Which of those days were degenerate is the operator's call; tune per
 * repository in openswarm.json `automation.anomaly`.
 */
export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  maxPrsPerHour: 3,
  maxDraftPrsPerHour: 2,
  maxRedispatchesPer24h: 10,
  infraErrorWindow: 10,
  maxInfraErrorShare: 0.4,
  sandboxNetworkDenial: true,
  pauseScope: 'project',
};

export interface ProjectObservations {
  prOpenedAt: number[];
  /** The subset of `prOpenedAt` opened as drafts. Optional for callers that know none. */
  draftPrOpenedAt?: number[];
  claims: Array<{ issueId: string; at: number }>;
  /** Finished runs, oldest first. */
  finished: Array<{ status: string; at: number }>;
  networkDenials: Array<{ at: number; command: string; target: string }>;
}

export interface AnomalyTrip {
  signal: AnomalySignal;
  /** When the threshold was crossed. */
  at: number;
  detail: string;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The first threshold these observations cross, or undefined. Pure: the replay
 * test and the daemon call the same function. Only observations at or before
 * `now` count.
 */
export function evaluateAnomalies(obs: ProjectObservations, thresholds: AnomalyThresholds, now: number): AnomalyTrip | undefined {
  const trips: AnomalyTrip[] = [];

  if (thresholds.sandboxNetworkDenial) {
    const denial = obs.networkDenials.find((d) => d.at <= now && d.at > now - DAY_MS);
    if (denial) trips.push({ signal: 'sandbox_network', at: denial.at, detail: `sandbox refused a network connect to ${denial.target}: ${denial.command}` });
  }

  const rate = (opened: number[], limit: number, signal: 'pr_rate' | 'draft_pr_rate', noun: string): void => {
    const prs = opened.filter((t) => t <= now).sort((a, b) => a - b);
    for (let i = 0; i < prs.length; i++) {
      const inHour = prs.filter((t) => t > prs[i] - HOUR_MS && t <= prs[i]).length;
      if (inHour >= limit && prs[i] > now - DAY_MS) {
        trips.push({ signal, at: prs[i], detail: `${inHour} ${noun} opened within 60 minutes (pauses at ${limit})` });
        return;
      }
    }
  };
  rate(obs.prOpenedAt, thresholds.maxPrsPerHour, 'pr_rate', 'PRs');
  rate(obs.draftPrOpenedAt ?? [], thresholds.maxDraftPrsPerHour, 'draft_pr_rate', 'draft PRs');

  const claimsByIssue = new Map<string, number[]>();
  for (const claim of obs.claims) {
    if (claim.at > now || claim.at <= now - DAY_MS) continue;
    const list = claimsByIssue.get(claim.issueId) ?? [];
    list.push(claim.at);
    claimsByIssue.set(claim.issueId, list);
  }
  for (const [issueId, times] of claimsByIssue) {
    if (times.length - 1 < thresholds.maxRedispatchesPer24h) continue;
    times.sort((a, b) => a - b);
    trips.push({
      signal: 'redispatch',
      at: times[thresholds.maxRedispatchesPer24h],
      detail: `issue ${issueId} claimed ${times.length} times in 24 hours (pauses at ${thresholds.maxRedispatchesPer24h} re-dispatches)`,
    });
  }

  const finished = obs.finished.filter((f) => f.at <= now && f.at > now - DAY_MS);
  const window = Math.max(1, thresholds.infraErrorWindow);
  if (finished.length >= window) {
    const recent = finished.slice(-window);
    const infra = recent.filter((f) => f.status === 'infra_error').length;
    // infra > 0: a share of 0 means "any infra_error", not "always".
    if (infra > 0 && infra / window >= thresholds.maxInfraErrorShare) {
      trips.push({
        signal: 'infra_error_share',
        at: recent[recent.length - 1].at,
        detail: `${infra} of the last ${window} runs ended infra_error (pauses at ${Math.round(thresholds.maxInfraErrorShare * 100)}%)`,
      });
    }
  }

  return trips.sort((a, b) => a.at - b.at)[0];
}

// --------------------------------------------
// Durable signals the ledger does not already hold
// --------------------------------------------

export const SIGNAL_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS automation_factory_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    issue_id TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_factory_signals ON automation_factory_signals(project_path, kind, created_at);
`;

function open(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(PAUSE_TABLE_DDL);
  migrateSignalTable(db);
  return db;
}

/** Create the signal table, and add `draft` to one created before it existed (old rows read as not draft). */
function migrateSignalTable(db: Database.Database): void {
  db.exec(SIGNAL_TABLE_DDL);
  const columns = db.prepare('PRAGMA table_info(automation_factory_signals)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'draft')) db.exec('ALTER TABLE automation_factory_signals ADD COLUMN draft INTEGER');
}

/**
 * Record a signal (`pr_opened`, `sandbox_network`). Never throws: it is called
 * from the publish path and the bash tool, neither of which may fail because
 * the factory's bookkeeping could not be written.
 */
export function recordFactorySignal(
  input: { projectPath: string; kind: 'pr_opened' | 'sandbox_network'; issueId?: string; detail?: string; draft?: boolean },
  dbPath = defaultAutomationDbPath(),
  now = Date.now(),
): void {
  let db: Database.Database | undefined;
  try {
    db = open(dbPath);
    // Normalized like the ledger's project_path, so a relative or symlinked cwd still counts.
    db.prepare('INSERT INTO automation_factory_signals(project_path, kind, issue_id, detail, created_at, draft) VALUES (?, ?, ?, ?, ?, ?)')
      .run(normalizeProjectPath(input.projectPath), input.kind, input.issueId ?? null, input.detail ?? null, now, input.draft === undefined ? null : input.draft ? 1 : 0);
  } catch (error) {
    console.warn('[AnomalyPause] Could not record signal:', error instanceof Error ? error.message : error);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** The exact path and a LIKE pattern for everything under it, `_`/`%` escaped (used with ESCAPE '\\'). */
function under(projectPath: string): [string, string] {
  const base = projectPath.replace(/\/+$/, '').replace(/[\\%_]/g, (c) => `\\${c}`);
  return [projectPath, `${base}/%`];
}

/**
 * Observations for one (normalized) repository since `since`. Signals recorded
 * from a worktree path count toward the repository that holds it.
 */
export function readProjectObservations(db: Database.Database, projectPath: string, since: number, infraWindow: number, now = Date.now()): ProjectObservations {
  migrateSignalTable(db);
  const [exact, prefix] = under(projectPath);
  const signals = db.prepare(`
    SELECT kind, detail, created_at, draft FROM automation_factory_signals
    WHERE (project_path = ? OR project_path LIKE ? ESCAPE '\\') AND created_at > ? AND created_at <= ?
    ORDER BY created_at
  `).all(exact, prefix, since, now) as Array<{ kind: string; detail: string | null; created_at: number; draft: number | null }>;
  // A database the run ledger never opened (ledger mode off, a fresh install) has signals but no attempts.
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automation_attempts'").get();
  const claims = !hasLedger ? [] : db.prepare(`
    SELECT COALESCE(r.identifier, a.issue_id) AS issueId, a.started_at AS at
    FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE r.project_path = ? AND a.started_at > ? AND a.started_at <= ?
  `).all(projectPath, since, now) as Array<{ issueId: string; at: number }>;
  const finished = !hasLedger ? [] : (db.prepare(`
    SELECT COALESCE(a.result_status, a.status) AS status, a.finished_at AS at
    FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE r.project_path = ? AND a.finished_at IS NOT NULL AND a.finished_at > ? AND a.finished_at <= ?
    ORDER BY a.finished_at DESC LIMIT ?
  `).all(projectPath, since, now, Math.max(1, infraWindow)) as Array<{ status: string; at: number }>).reverse();
  return {
    // One PR is counted once, however many runs report it back (the earliest report wins).
    prOpenedAt: firstOpenPerPr(signals.filter((s) => s.kind === 'pr_opened')),
    draftPrOpenedAt: firstOpenPerPr(signals.filter((s) => s.kind === 'pr_opened' && s.draft === 1)),
    claims,
    finished,
    networkDenials: signals.filter((s) => s.kind === 'sandbox_network').map((s) => {
      const [target, ...command] = (s.detail ?? '').split('\n');
      return { at: s.created_at, target: target || 'unknown', command: command.join('\n') || 'unknown' };
    }),
  };
}

function firstOpenPerPr(rows: Array<{ detail: string | null; created_at: number }>): number[] {
  return [...new Map([...rows].reverse().map((s) => [s.detail ?? `${s.created_at}`, s.created_at])).values()];
}

function liftedAt(db: Database.Database, scope: string): number {
  const row = db.prepare('SELECT lifted_at FROM automation_pause_lifts WHERE scope = ?').get(scope) as { lifted_at: number } | undefined;
  return row?.lifted_at ?? 0;
}

const META_DDL = 'CREATE TABLE IF NOT EXISTS automation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
/** One row per automatic pause whose alert went out; keyed by the pause it alerted on. */
const ALERT_DDL = `
  CREATE TABLE IF NOT EXISTS automation_pause_alerts (
    scope TEXT NOT NULL,
    pause_created_at INTEGER NOT NULL,
    alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, pause_created_at)
  );
`;
const ARMED_KEY = 'anomaly_armed_at';
const SIGNAL_RETENTION_MS = 30 * DAY_MS;

/**
 * When the monitor first ran against this database, writing it on the first
 * call. Nothing observed before it counts: enabling the feature on a ledger
 * with a bad yesterday must not pause on the first heartbeat after deploy.
 */
export function anomalyArmedAt(db: Database.Database, now = Date.now()): number {
  db.exec(META_DDL);
  db.prepare('INSERT OR IGNORE INTO automation_meta(key, value) VALUES (?, ?)').run(ARMED_KEY, String(now));
  const row = db.prepare('SELECT value FROM automation_meta WHERE key = ?').get(ARMED_KEY) as { value: string };
  return Number(row.value) || now;
}

/** Arm the monitor at `now` unless it already is (tests and the replay seed history after arming). */
export function armAnomalyMonitor(dbPath = defaultAutomationDbPath(), now = Date.now()): number {
  const db = open(dbPath);
  try {
    return anomalyArmedAt(db, now);
  } finally {
    db.close();
  }
}

export interface AnomalyCheckResult {
  projectPath: string;
  /** The pause scope the trip wrote: the repository, or `*`. */
  scope: string;
  trip: AnomalyTrip;
  /** A new pause was written; false when one already stood. */
  paused: boolean;
}

/** A network reach pauses `now`: in-flight runs are the ones reaching out. Everything else drains. */
function modeFor(signal: AnomalySignal): PauseMode {
  return signal === 'sandbox_network' ? 'now' : 'drain';
}

/**
 * Check every repository once and pause the ones that crossed a threshold;
 * pause the factory when `disk` (the heartbeat's low free-disk line) is given.
 * An existing pause (operator or automatic) is left exactly as it is. Alerts
 * are not sent here: `pendingAnomalyAlerts` lists the automatic pauses whose
 * alert has not gone out, so a failed send is retried next heartbeat.
 */
export function checkAnomalies(
  dbPath: string,
  projects: Array<{ projectPath: string; thresholds: AnomalyThresholds }>,
  now = Date.now(),
  disk?: { line: string },
): AnomalyCheckResult[] {
  const db = open(dbPath);
  try {
    const armedAt = anomalyArmedAt(db, now);
    db.prepare('DELETE FROM automation_factory_signals WHERE created_at < ?').run(now - SIGNAL_RETENTION_MS);
    const results: AnomalyCheckResult[] = [];
    const insert = db.prepare(`
      INSERT OR IGNORE INTO automation_pauses(scope, mode, reason, actor, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    if (disk) {
      const trip: AnomalyTrip = { signal: 'disk', at: now, detail: disk.line };
      const paused = insert.run(GLOBAL_PAUSE_SCOPE, 'drain', trip.detail, 'auto:disk', now).changes > 0;
      results.push({ projectPath: GLOBAL_PAUSE_SCOPE, scope: GLOBAL_PAUSE_SCOPE, trip, paused });
    }
    const globalLift = liftedAt(db, GLOBAL_PAUSE_SCOPE);
    for (const { projectPath, thresholds } of projects) {
      const scope = thresholds.pauseScope === 'factory' ? GLOBAL_PAUSE_SCOPE : projectPath;
      const since = Math.max(now - DAY_MS, armedAt, globalLift, liftedAt(db, projectPath));
      const trip = evaluateAnomalies(readProjectObservations(db, projectPath, since, thresholds.infraErrorWindow, now), thresholds, now);
      if (!trip) continue;
      const detail = scope === GLOBAL_PAUSE_SCOPE ? `${projectPath}: ${trip.detail}` : trip.detail;
      const paused = insert.run(scope, modeFor(trip.signal), detail, `auto:${trip.signal}`, now).changes > 0;
      results.push({ projectPath, scope, trip, paused });
    }
    return results;
  } finally {
    db.close();
  }
}

/** Automatic pauses written since arming whose one alert has not been sent yet. */
export function pendingAnomalyAlerts(dbPath: string, now = Date.now()): FactoryPause[] {
  const db = open(dbPath);
  try {
    db.exec(ALERT_DDL);
    const armedAt = anomalyArmedAt(db, now);
    // A lifted pause takes its marker with it; the next trip on that scope alerts again.
    db.exec('DELETE FROM automation_pause_alerts WHERE scope NOT IN (SELECT scope FROM automation_pauses)');
    const sent = db.prepare('SELECT 1 FROM automation_pause_alerts WHERE scope = ? AND pause_created_at = ?');
    return listPausesInDb(db).filter((p) => p.actor.startsWith('auto:') && p.createdAt >= armedAt && !sent.get(p.scope, p.createdAt));
  } finally {
    db.close();
  }
}

/** Record that this pause's alert went out. */
export function markAnomalyAlerted(dbPath: string, pause: Pick<FactoryPause, 'scope' | 'createdAt'>, now = Date.now()): void {
  const db = open(dbPath);
  try {
    db.exec(ALERT_DDL);
    db.prepare('INSERT OR IGNORE INTO automation_pause_alerts(scope, pause_created_at, alerted_at) VALUES (?, ?, ?)').run(pause.scope, pause.createdAt, now);
  } finally {
    db.close();
  }
}

/** The openswarm.json key that tunes each signal, named in its alert. */
const THRESHOLD_KEY: Record<string, keyof AnomalyThresholds> = {
  pr_rate: 'maxPrsPerHour',
  draft_pr_rate: 'maxDraftPrsPerHour',
  redispatch: 'maxRedispatchesPer24h',
  infra_error_share: 'maxInfraErrorShare',
  sandbox_network: 'sandboxNetworkDenial',
};

/** The one alert an automatic pause sends. */
export function formatAnomalyAlert(pause: FactoryPause): string {
  const factory = pause.scope === GLOBAL_PAUSE_SCOPE;
  const what = factory ? 'the factory' : pause.scope.split('/').pop() || pause.scope;
  const inFlight = pause.mode === 'now' ? 'In-flight runs are cancelled and retried after the resume' : 'In-flight runs finish';
  const resume = factory ? '`openswarm unpause`' : `\`openswarm unpause --project ${pause.scope}\``;
  const signal = pause.actor.replace(/^auto:/, '');
  const key = THRESHOLD_KEY[signal];
  const tune = key ? ` Threshold: \`automation.anomaly.${key}\` in openswarm.json.` : '';
  return `⏸ Auto-paused ${what} (${signal}): ${pause.reason}. `
    + `${inFlight}; nothing new is claimed. Resume with ${resume} or the dashboard.${tune}`;
}

export type { FactoryPause };
