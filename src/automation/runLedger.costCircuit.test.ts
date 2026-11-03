// Round-1 redteam B-F2 (2026-11-03): the cost ceiling was per-repository
// opt-in, read NULL cost as free (75% of live attempts had none), and dropped
// the cost of any attempt whose lease expired before its result landed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RunLedger, type RunClaim } from './runLedger.js';
import { DEFAULT_UNKNOWN_ATTEMPT_COST_USD, dailySpend, unknownCostRatio } from './runLedgerCost.js';
import { spendVisibility } from '../cli/doctorHandler.js';

const roots: string[] = [];
function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-cost-circuit-'));
  roots.push(root);
  return join(root, 'automation.db');
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function register(ledger: RunLedger, issueId: string, projectPath: string): void {
  ledger.registerRun({ issueId, source: 'linear', identifier: issueId, title: issueId, projectPath }, 1_000);
}

function claim(ledger: RunLedger, issueId: string, now: number, extra: Record<string, unknown> = {}): RunClaim | null {
  return ledger.claimRun(issueId, { ownerInstanceId: 'daemon', leaseMs: 1_000, now, ...extra });
}

/** Claim, record a result with `costUsd`, and release the run. */
function spend(ledger: RunLedger, issueId: string, projectPath: string, now: number, costUsd: number | undefined): void {
  register(ledger, issueId, projectPath);
  const c = claim(ledger, issueId, now);
  expect(c).not.toBeNull();
  expect(ledger.recordAttemptResult(c!, { success: true, finalStatus: 'approved', costUsd }, now + 10)).toBe(true);
  expect(ledger.transition(c!, 'CANCELLED', {}, now + 11)).toBe(true);
}

describe('spend ceiling', () => {
  it('records cost from an attempt whose lease expired', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    register(ledger, 'LATE-1', '/repo-a');
    const c = claim(ledger, 'LATE-1', 2_000)!;

    // The lease (1 s) ran out before the result came back: the result is
    // refused, as before — but the $50 it spent is now on the books.
    expect(ledger.recordAttemptResult(c, { success: true, finalStatus: 'approved', costUsd: 50 }, 5_000)).toBe(false);
    const db = new Database(path, { readonly: true });
    const row = db.prepare('SELECT result_status, cost_usd FROM automation_attempts WHERE issue_id = ?').get('LATE-1') as { result_status: string | null; cost_usd: number | null };
    db.close();
    expect(row).toEqual({ result_status: null, cost_usd: 50 });

    // And the ceiling sees it. (Another repository, so the expired lease in
    // /repo-a is not what stops the claim.) Control first: no ceiling, admitted.
    register(ledger, 'CTRL-1', '/repo-z');
    expect(claim(ledger, 'CTRL-1', 6_000)).not.toBeNull();
    register(ledger, 'NEXT-1', '/repo-y');
    expect(claim(ledger, 'NEXT-1', 6_000, { globalMaxCostUsdPerDay: 10, unknownAttemptCostUsd: 0, circuitCooldownMs: 60_000 })).toBeNull();
    ledger.close();
  });

  it('global maxCostUsdPerDay trips across repositories', () => {
    const ledger = new RunLedger(dbPath());
    spend(ledger, 'A-1', '/repo-a', 2_000, 4);
    spend(ledger, 'B-1', '/repo-b', 3_000, 4);

    // Each repository alone is under its own $5 ceiling...
    register(ledger, 'C-1', '/repo-c');
    expect(claim(ledger, 'C-1', 4_000, { maxCostUsdPerDay: 5 })).not.toBeNull();
    // ...but the daemon spent $8 today against a $6 daemon-wide ceiling.
    register(ledger, 'D-1', '/repo-d');
    expect(claim(ledger, 'D-1', 5_000, { maxCostUsdPerDay: 5, globalMaxCostUsdPerDay: 6, circuitCooldownMs: 60_000 })).toBeNull();
    const circuits = (ledger as unknown as { db: Database.Database }).db
      .prepare('SELECT reason FROM automation_repo_circuits WHERE project_path = ?').get('/repo-d') as { reason: string };
    expect(circuits.reason).toContain('daemon-wide daily cost budget exhausted');
    ledger.close();
  });

  it('does not treat unknown-cost attempts as free', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    // Three attempts with no recorded cost — an adapter that does not report it.
    for (const id of ['U-1', 'U-2', 'U-3']) spend(ledger, id, '/repo-u', 2_000, undefined);

    // Estimated at the configured price, they exhaust a $1 ceiling.
    register(ledger, 'U-4', '/repo-u');
    expect(claim(ledger, 'U-4', 3_000, { maxCostUsdPerDay: 1, unknownAttemptCostUsd: 0.5, circuitCooldownMs: 60_000 })).toBeNull();

    // Without a configured price and with no known cost to average, the default applies.
    const db = new Database(path, { readonly: true });
    const today = dailySpend(db, 3_000, { projectPath: '/repo-u' });
    expect(today).toMatchObject({ knownUsd: 0, unknownAttempts: 3, estimatePerUnknownUsd: DEFAULT_UNKNOWN_ATTEMPT_COST_USD });
    expect(today.totalUsd).toBeCloseTo(3 * DEFAULT_UNKNOWN_ATTEMPT_COST_USD);
    expect(unknownCostRatio(db, 3_000)).toEqual({ attempts: 3, unknown: 3, ratio: 1 });
    db.close();
    ledger.close();
  });

  it('estimates an unknown cost from the recent mean of known ones', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    spend(ledger, 'K-1', '/repo-k', 2_000, 2);
    spend(ledger, 'K-2', '/repo-k', 2_100, 4);
    spend(ledger, 'K-3', '/repo-k', 2_200, undefined);
    const db = new Database(path, { readonly: true });
    expect(dailySpend(db, 3_000)).toMatchObject({ knownUsd: 6, unknownAttempts: 1, estimatePerUnknownUsd: 3, totalUsd: 9 });
    db.close();
    ledger.close();
  });

  it('doctor reports the share of attempts without a recorded cost', async () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    spend(ledger, 'D-1', '/repo', 2_000, 1);
    spend(ledger, 'D-2', '/repo', 2_100, undefined);
    spend(ledger, 'D-3', '/repo', 2_200, undefined);
    ledger.close();

    const report = await spendVisibility(path, 3_000);
    expect(report).toEqual({ status: 'warn', detail: expect.stringContaining('2/3 attempts in 7 days have no recorded cost (67%)') });
    expect(await spendVisibility(join(tmpdir(), 'openswarm-no-such-ledger', 'automation.db'))).toBeNull();
  });
});
