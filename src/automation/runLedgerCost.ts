// ============================================
// OpenSwarm — a spend ceiling that sees every attempt
// ============================================
//
// Round-1 redteam B-F2 (2026-11-03): the daily cost ceiling was per-repository
// opt-in only, summed `cost_usd` as if NULL were free, and lost the cost of
// any attempt whose lease expired before its result landed (the result UPDATE
// is fenced on a live lease). On the live ledger 6,193 of 8,291 attempts
// (75%) had no cost recorded, so the ceiling saw a quarter of the spend at
// best.
//
// This module is the cost side of admission:
//   - a daemon-wide ceiling across every repository (`autonomous.spend`),
//     next to the per-repository one;
//   - an attempt without a recorded cost — still running, crashed, or from an
//     adapter that does not report cost — counts at an estimate instead of
//     zero: the configured `unknownAttemptCostUsd`, else the mean of the
//     known costs of the last seven days, else DEFAULT_UNKNOWN_ATTEMPT_COST_USD;
//   - a result that lost its lease still records its cost (it is a fact about
//     money spent, not a claim about the run).

import type Database from 'better-sqlite3';

/** Estimate per cost-less attempt when there is no recent known cost to average. */
export const DEFAULT_UNKNOWN_ATTEMPT_COST_USD = 0.1;
const ESTIMATE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface CostCeilingOptions {
  /** Per-repository daily ceiling (openswarm.json `automation.maxCostUsdPerDay`). */
  maxCostUsdPerDay?: number;
  /** Daemon-wide daily ceiling across repositories (config `autonomous.spend.maxCostUsdPerDay`). */
  globalMaxCostUsdPerDay?: number;
  /** Estimate for an attempt with no recorded cost; default: recent mean of known costs. */
  unknownAttemptCostUsd?: number;
}

export interface DailySpend {
  /** Recorded cost. */
  knownUsd: number;
  /** Attempts started in the window with no recorded cost. */
  unknownAttempts: number;
  /** knownUsd + unknownAttempts × estimate. */
  totalUsd: number;
  estimatePerUnknownUsd: number;
}

function utcDayStart(now: number): number {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

/** The estimate used for one attempt that has no recorded cost. */
export function unknownAttemptEstimateUsd(db: Database.Database, now: number, configured?: number): number {
  if (configured != null) return configured;
  const row = db.prepare(`
    SELECT AVG(cost_usd) AS mean FROM automation_attempts
    WHERE cost_usd IS NOT NULL AND cost_usd > 0 AND started_at >= ?
  `).get(now - ESTIMATE_WINDOW_MS) as { mean: number | null };
  return row.mean != null && Number.isFinite(row.mean) ? row.mean : DEFAULT_UNKNOWN_ATTEMPT_COST_USD;
}

/** Spend since the start of the UTC day, for one repository or (no path) the whole daemon. */
export function dailySpend(
  db: Database.Database,
  now: number,
  options: { projectPath?: string; unknownAttemptCostUsd?: number } = {},
): DailySpend {
  const since = utcDayStart(now);
  const scoped = options.projectPath !== undefined;
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.cost_usd), 0) AS known,
           SUM(CASE WHEN a.cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM automation_attempts a
    JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE a.started_at >= ?
      AND COALESCE(a.result_status, '') != 'operator_remediated'
      ${scoped ? 'AND r.project_path = ?' : ''}
  `).get(...(scoped ? [since, options.projectPath] : [since])) as { known: number; unknown: number | null };
  const unknownAttempts = row.unknown ?? 0;
  const estimate = unknownAttempts > 0 ? unknownAttemptEstimateUsd(db, now, options.unknownAttemptCostUsd) : 0;
  return {
    knownUsd: row.known,
    unknownAttempts,
    totalUsd: row.known + unknownAttempts * estimate,
    estimatePerUnknownUsd: estimate,
  };
}

function describe(spend: DailySpend, ceiling: number, scope: string): string {
  const unknown = spend.unknownAttempts > 0
    ? ` (incl. ${spend.unknownAttempts} attempt(s) without a recorded cost at ~$${spend.estimatePerUnknownUsd.toFixed(4)} each)`
    : '';
  return `${scope} daily cost budget exhausted: $${spend.totalUsd.toFixed(4)}/$${ceiling.toFixed(4)}${unknown}`;
}

/** The reason admission must stop for cost, or null. Checked per claim. */
export function costCeilingReason(
  db: Database.Database,
  options: CostCeilingOptions,
  projectPath: string,
  now: number,
): string | null {
  if (options.maxCostUsdPerDay != null) {
    const spend = dailySpend(db, now, { projectPath, unknownAttemptCostUsd: options.unknownAttemptCostUsd });
    if (spend.totalUsd >= options.maxCostUsdPerDay) return describe(spend, options.maxCostUsdPerDay, 'repository');
  }
  if (options.globalMaxCostUsdPerDay != null) {
    const spend = dailySpend(db, now, { unknownAttemptCostUsd: options.unknownAttemptCostUsd });
    if (spend.totalUsd >= options.globalMaxCostUsdPerDay) return describe(spend, options.globalMaxCostUsdPerDay, 'daemon-wide');
  }
  return null;
}

/**
 * Record the cost of an attempt whose fenced result was refused (its lease
 * expired or was replaced). The result stays unrecorded — that executor no
 * longer speaks for the run — but the money it spent is real and the ceiling
 * must see it. Only fills a cost that is still missing.
 */
export function recordUnfencedAttemptCost(
  db: Database.Database,
  claim: { issueId: string; attemptNo: number; leaseEpoch: number },
  costUsd: number | undefined,
): void {
  if (costUsd == null || !Number.isFinite(costUsd)) return;
  db.prepare(`
    UPDATE automation_attempts SET cost_usd = ?
    WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ? AND cost_usd IS NULL
  `).run(costUsd, claim.issueId, claim.attemptNo, claim.leaseEpoch);
}

/** Share of attempts in the last `windowMs` with no recorded cost, for doctor. */
export function unknownCostRatio(db: Database.Database, now: number, windowMs = ESTIMATE_WINDOW_MS): { attempts: number; unknown: number; ratio: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS attempts, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM automation_attempts WHERE started_at >= ?
  `).get(now - windowMs) as { attempts: number; unknown: number | null };
  const unknown = row.unknown ?? 0;
  return { attempts: row.attempts, unknown, ratio: row.attempts > 0 ? unknown / row.attempts : 0 };
}
