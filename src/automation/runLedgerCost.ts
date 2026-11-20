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
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import { DAEMON_COMMENT_LEAD } from '../linear/format.js';

/** Estimate per cost-less attempt when there is no recent known cost to average. */
export const DEFAULT_UNKNOWN_ATTEMPT_COST_USD = 0.1;
const ESTIMATE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Results that end an attempt before any model call: no cost to estimate. */
export const NO_SPEND_STATUSES = ['rate_limited', 'superseded', 'deferred'] as const;

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
  // An attempt that ended before any model call (rate limited at preflight,
  // superseded, deferred) spent nothing; estimating it turned a rate-limit storm
  // into a spend-circuit trip that holds until midnight (round-2 redteam B-F2).
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.cost_usd), 0) AS known,
           SUM(CASE WHEN a.cost_usd IS NULL
                     AND COALESCE(a.result_status, '') NOT IN (${NO_SPEND_STATUSES.map(() => '?').join(', ')})
                    THEN 1 ELSE 0 END) AS unknown
    FROM automation_attempts a
    JOIN automation_runs r ON r.issue_id = a.issue_id
    WHERE a.started_at >= ?
      AND COALESCE(a.result_status, '') != 'operator_remediated'
      ${scoped ? 'AND r.project_path = ?' : ''}
  `).get(...NO_SPEND_STATUSES, ...(scoped ? [since, options.projectPath] : [since])) as { known: number; unknown: number | null };
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

// ============================================
// Budgets (AGT-4807): one alert per tripped project day, and a per-issue cap
// ============================================
//
// On 2026-10-20 single issues were retried up to 18 times (AGT-4787). The daily
// ceilings above stop a project, but they did so silently, and nothing capped
// what one issue may spend.

/** NEEDS_HUMAN code for an issue whose own spend reached `autonomous.budget.perIssueUsd`. */
export const ISSUE_BUDGET_PARK_REASON = 'issue_budget_exhausted';

/** Where a budget alert goes. The daemon's notifier by default; tests replace it. */
export type BudgetAlertSink = (message: string) => void | Promise<void>;

const defaultBudgetAlertSink: BudgetAlertSink = async (message) => {
  // Loaded lazily: the notifier lives with the runner, and this module is also
  // loaded by the CLI and tests, which must not pull the runner in.
  const { reportToDiscord } = await import('./runnerExecution.js');
  await reportToDiscord(message);
};

let budgetAlertSink: BudgetAlertSink = defaultBudgetAlertSink;

/** Replace the alert sink (tests); `undefined` restores the notifier. */
export function setBudgetAlertSink(sink: BudgetAlertSink | undefined): void {
  budgetAlertSink = sink ?? defaultBudgetAlertSink;
}

const alertTables = new WeakSet<Database.Database>();

function ensureAlertTable(db: Database.Database): void {
  if (alertTables.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_budget_alerts (
      scope TEXT NOT NULL,
      day_start INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, day_start)
    )
  `);
  alertTables.add(db);
}

/**
 * Alert once per scope and UTC day that its daily budget tripped. The row is
 * written in the caller's transaction (the claim), so two daemons racing on
 * the same project still produce one row, and the alert is sent after the
 * current tick so a rolled-back claim cannot have alerted first.
 */
function alertOncePerDay(db: Database.Database, scope: string, reason: string, now: number): void {
  ensureAlertTable(db);
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO automation_budget_alerts(scope, day_start, reason, created_at) VALUES (?, ?, ?, ?)
  `).run(scope, utcDayStart(now), reason, now);
  if (inserted.changes !== 1) return;
  const sink = budgetAlertSink;
  setImmediate(() => {
    Promise.resolve(sink(`${DAEMON_COMMENT_LEAD} ${reason} — dispatch for ${scope} is paused until 00:00 UTC.`))
      .catch((err) => console.warn('[Budget] Alert delivery failed:', err instanceof Error ? err.message : err));
  });
}

/**
 * `costCeilingReason`, plus the one alert per tripped day. The claim path calls
 * this one; the alert is a side effect `costCeilingReason` itself stays free of.
 */
export function costCeilingReasonWithAlert(
  db: Database.Database,
  options: CostCeilingOptions,
  projectPath: string,
  now: number,
): string | null {
  const reason = costCeilingReason(db, options, projectPath, now);
  if (reason) alertOncePerDay(db, reason.startsWith('daemon-wide') ? 'daemon-wide' : projectPath, reason, now);
  return reason;
}

/**
 * What one issue has spent since an operator last lifted ITS BUDGET PARK. Only
 * a resume of an `issue_budget_exhausted` park resets the count: every other
 * resume (idle fill, an ephemeral-path park, an answered question) also writes
 * `operator_resumed`, and letting those reset it would let the AGT-4787 retry
 * loop spend forever. The attempt now being claimed is excluded:
 * it has spent nothing yet, and counting it at the estimate would park an
 * issue for money it never spent.
 */
export function issueSpend(
  db: Database.Database,
  issueId: string,
  now: number,
  options: { excludeAttemptNo?: number; unknownAttemptCostUsd?: number } = {},
): DailySpend {
  const resumed = db.prepare(`
    SELECT MAX(created_at) AS at FROM automation_events
    WHERE issue_id = ? AND kind = 'operator_resumed'
      AND json_extract(data_json, '$.parkedUnder') = ?
  `).get(issueId, ISSUE_BUDGET_PARK_REASON) as { at: number | null };
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS known,
           SUM(CASE WHEN cost_usd IS NULL
                     AND COALESCE(result_status, '') NOT IN (${NO_SPEND_STATUSES.map(() => '?').join(', ')})
                    THEN 1 ELSE 0 END) AS unknown
    FROM automation_attempts
    WHERE issue_id = ? AND started_at >= ? AND attempt_no != ?
      AND COALESCE(result_status, '') != 'operator_remediated'
  `).get(...NO_SPEND_STATUSES, issueId, resumed.at ?? 0, options.excludeAttemptNo ?? -1) as { known: number; unknown: number | null };
  const unknownAttempts = row.unknown ?? 0;
  const estimate = unknownAttempts > 0 ? unknownAttemptEstimateUsd(db, now, options.unknownAttemptCostUsd) : 0;
  return { knownUsd: row.known, unknownAttempts, totalUsd: row.known + unknownAttempts * estimate, estimatePerUnknownUsd: estimate };
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The park for an issue over its budget, or null. Returned in place of running
 * the pipeline: the coordinator parks the run NEEDS_HUMAN under
 * `ISSUE_BUDGET_PARK_REASON`, and the runner posts the one tracker comment
 * every operator park gets, carrying the spend below. The attempt records a
 * cost of zero — it ran no model — so the park itself adds no spend.
 */
export function issueBudgetPark(
  spend: DailySpend,
  capUsd: number | undefined,
  task: { issueId?: string; id: string; issueIdentifier?: string; title: string },
  projectPath: string,
): PipelineResult | null {
  if (capUsd == null || spend.totalUsd < capUsd) return null;
  const unknown = spend.unknownAttempts > 0
    ? ` — ${usd(spend.knownUsd)} recorded plus ${spend.unknownAttempts} attempt(s) without a recorded cost at ~${usd(spend.estimatePerUnknownUsd)} each`
    : '';
  const reason = `${DAEMON_COMMENT_LEAD} This issue has spent ${usd(spend.totalUsd)} of its ${usd(capUsd)} budget`
    + ` (autonomous.budget.perIssueUsd)${unknown}. Raise the budget or narrow the issue, then dispatch it from the dashboard issue board to resume; moving it back to Todo alone does not lift a budget park.`;
  return {
    success: false,
    sessionId: `issue-budget-${Date.now()}`,
    stages: [],
    finalStatus: 'failed',
    totalDuration: 0,
    iterations: 0,
    totalCost: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 },
    failureDetail: reason,
    operatorPark: { code: ISSUE_BUDGET_PARK_REASON, reason },
    taskContext: { issueIdentifier: task.issueIdentifier || task.issueId, projectPath, taskTitle: task.title },
  };
}
