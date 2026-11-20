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
// Disk space is not here: the AGT-4785 hold already stops dispatch below
// `autonomous.minFreeDiskGiB` and alerts once per change of state, and it lifts
// itself when space comes back.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { GLOBAL_PAUSE_SCOPE, PAUSE_TABLE_DDL, type FactoryPause } from './factoryPause.js';

export type AnomalySignal = 'pr_rate' | 'redispatch' | 'infra_error_share' | 'sandbox_network';

export interface AnomalyThresholds {
  /** Pause when this many PRs are opened from one repository within 60 minutes. */
  maxPrsPerHour: number;
  /** Pause when one issue is claimed this many times beyond its first within 24 hours. */
  maxRedispatchesPer24h: number;
  /** How many of the most recent finished runs the infra_error share is taken over. */
  infraErrorWindow: number;
  /** Trip when infra_error runs make up at least this share of that window (0..1). */
  maxInfraErrorShare: number;
  /** Trip on any sandbox EPERM for a non-loopback connect. */
  sandboxNetworkDenial: boolean;
}

/**
 * Defaults. Replaying the 2026-10-20 factory ledger against these trips the
 * PR-rate signal at 14:17:20Z, the third unreviewed PR in 39 minutes
 * (anomalyPause.test.ts).
 *
 * Re-dispatch is set high on purpose. Replayed over every project-day in the
 * same ledger (32 of them, 2026-07-21..10-20), a limit of 3 tripped on 22,
 * 6 on 20 and 10 on 13: retrying a failed issue a few times a day is normal
 * there. Which of those days were degenerate is the operator's call; tune per
 * repository in openswarm.json `automation.anomaly`.
 */
export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  maxPrsPerHour: 3,
  maxRedispatchesPer24h: 10,
  infraErrorWindow: 10,
  maxInfraErrorShare: 0.4,
  sandboxNetworkDenial: true,
};

export interface ProjectObservations {
  prOpenedAt: number[];
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

  const prs = obs.prOpenedAt.filter((t) => t <= now).sort((a, b) => a - b);
  for (let i = 0; i < prs.length; i++) {
    const inHour = prs.filter((t) => t > prs[i] - HOUR_MS && t <= prs[i]).length;
    if (inHour >= thresholds.maxPrsPerHour && prs[i] > now - DAY_MS) {
      trips.push({ signal: 'pr_rate', at: prs[i], detail: `${inHour} PRs opened within 60 minutes (pauses at ${thresholds.maxPrsPerHour})` });
      break;
    }
  }

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
    if (infra / window >= thresholds.maxInfraErrorShare) {
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
  db.exec(SIGNAL_TABLE_DDL);
  return db;
}

/**
 * Record a signal (`pr_opened`, `sandbox_network`). Never throws: it is called
 * from the publish path and the bash tool, neither of which may fail because
 * the factory's bookkeeping could not be written.
 */
export function recordFactorySignal(
  input: { projectPath: string; kind: 'pr_opened' | 'sandbox_network'; issueId?: string; detail?: string },
  dbPath = defaultAutomationDbPath(),
  now = Date.now(),
): void {
  let db: Database.Database | undefined;
  try {
    db = open(dbPath);
    db.prepare('INSERT INTO automation_factory_signals(project_path, kind, issue_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.projectPath, input.kind, input.issueId ?? null, input.detail ?? null, now);
  } catch (error) {
    console.warn('[AnomalyPause] Could not record signal:', error instanceof Error ? error.message : error);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function under(projectPath: string): [string, string] {
  return [projectPath, `${projectPath.replace(/\/+$/, '')}/%`];
}

/**
 * Observations for one (normalized) repository since `since`. Signals recorded
 * from a worktree path count toward the repository that holds it.
 */
export function readProjectObservations(db: Database.Database, projectPath: string, since: number, infraWindow: number): ProjectObservations {
  db.exec(SIGNAL_TABLE_DDL);
  const [exact, prefix] = under(projectPath);
  const signals = db.prepare(`
    SELECT kind, detail, created_at FROM automation_factory_signals
    WHERE (project_path = ? OR project_path LIKE ?) AND created_at > ?
    ORDER BY created_at
  `).all(exact, prefix, since) as Array<{ kind: string; detail: string | null; created_at: number }>;
  // A database the run ledger never opened (ledger mode off, a fresh install) has signals but no attempts.
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automation_attempts'").get();
  const claims = !hasLedger ? [] : db.prepare(`
    SELECT COALESCE(r.identifier, a.issue_id) AS issueId, a.started_at AS at
    FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE r.project_path = ? AND a.started_at > ?
  `).all(projectPath, since) as Array<{ issueId: string; at: number }>;
  const finished = !hasLedger ? [] : (db.prepare(`
    SELECT COALESCE(a.result_status, a.status) AS status, a.finished_at AS at
    FROM automation_attempts a JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE r.project_path = ? AND a.finished_at IS NOT NULL AND a.finished_at > ?
    ORDER BY a.finished_at DESC LIMIT ?
  `).all(projectPath, since, Math.max(1, infraWindow)) as Array<{ status: string; at: number }>).reverse();
  return {
    // One PR is counted once, however many runs report it back.
    prOpenedAt: [...new Map(signals.filter((s) => s.kind === 'pr_opened').reverse().map((s) => [s.detail ?? `${s.created_at}`, s.created_at])).values()],
    claims,
    finished,
    networkDenials: signals.filter((s) => s.kind === 'sandbox_network').map((s) => {
      const [target, ...command] = (s.detail ?? '').split('\n');
      return { at: s.created_at, target: target || 'unknown', command: command.join('\n') || 'unknown' };
    }),
  };
}

function liftedAt(db: Database.Database, scope: string): number {
  const row = db.prepare('SELECT lifted_at FROM automation_pause_lifts WHERE scope = ?').get(scope) as { lifted_at: number } | undefined;
  return row?.lifted_at ?? 0;
}

export interface AnomalyCheckResult {
  projectPath: string;
  trip: AnomalyTrip;
  /** A new pause was written (and so an alert is due); false when one already stood. */
  paused: boolean;
}

/**
 * Check every repository once and pause the ones that crossed a threshold.
 * An existing pause (operator or automatic) is left exactly as it is, and no
 * alert is sent for it: one trip, one alert.
 */
export function checkAnomalies(
  dbPath: string,
  projects: Array<{ projectPath: string; thresholds: AnomalyThresholds }>,
  now = Date.now(),
): AnomalyCheckResult[] {
  const db = open(dbPath);
  try {
    const results: AnomalyCheckResult[] = [];
    const globalLift = liftedAt(db, GLOBAL_PAUSE_SCOPE);
    for (const { projectPath, thresholds } of projects) {
      const since = Math.max(now - DAY_MS, globalLift, liftedAt(db, projectPath));
      const trip = evaluateAnomalies(readProjectObservations(db, projectPath, since, thresholds.infraErrorWindow), thresholds, now);
      if (!trip) continue;
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO automation_pauses(scope, mode, reason, actor, created_at)
        VALUES (?, 'drain', ?, ?, ?)
      `).run(projectPath, trip.detail, `auto:${trip.signal}`, now).changes > 0;
      results.push({ projectPath, trip, paused: inserted });
    }
    return results;
  } finally {
    db.close();
  }
}

/** The one alert a new automatic pause sends. */
export function formatAnomalyAlert(result: AnomalyCheckResult): string {
  const repo = result.projectPath.split('/').pop() || result.projectPath;
  return `⏸ Auto-paused ${repo} (${result.trip.signal}): ${result.trip.detail}. `
    + `In-flight runs finish; nothing new is claimed. Resume with \`openswarm unpause --project ${result.projectPath}\` or the dashboard.`;
}

// --------------------------------------------
// Sandbox network denials
// --------------------------------------------

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|localhost|\[::1\])$/i;

/**
 * The non-loopback address a sandboxed command was refused a connect to, if
 * its output says so. The refusal differs by sandbox: macOS sandbox-exec
 * answers EPERM, Linux bwrap's empty network namespace ENETUNREACH (measured
 * on vela: Node `connect ENETUNREACH 192.168.x.x:443`, curl exit 7 "Could not
 * connect to server"). Only called for a fenced shell, where every
 * non-loopback connect is a worker reaching for the network.
 */
export function nonLoopbackConnectDenial(output: string): string | undefined {
  const node = /connect (?:EPERM|ENETUNREACH|EACCES) (\[[^\]]+\]|[0-9A-Fa-f:.]+?)(?::(\d+))?(?=\s|$)/.exec(output);
  if (node && !LOOPBACK.test(node[1])) return node[2] ? `${node[1]}:${node[2]}` : node[1];
  const curl = /Failed to connect to (\S+) port (\d+)[^\n]*(?:Operation not permitted|Network is unreachable|Could not connect to server)/i.exec(output);
  if (curl && !LOOPBACK.test(curl[1])) return `${curl[1]}:${curl[2]}`;
  return undefined;
}

export type { FactoryPause };
