import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunLedger } from './runLedger.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { PAUSE_TABLE_DDL } from './factoryPause.js';
import { SIGNAL_TABLE_DDL } from './anomalyPause.js';
import { dailySpend } from './runLedgerCost.js';
import {
  computeFactoryDigest, fitForDiscord, formatFactoryDigest, readFactoryDigest, startFactoryDigest, KPI_HEADING, type FactoryDigest,
} from './factoryDigest.js';
import { FACTORY_DIGEST_MEMO_MS, handleFactoryDigest } from '../support/webFactoryDigest.js';
import { recordPullRequestStateInDb } from './factoryOutcomes.js';
import { runDefectCommand, runWrongDispatchCommand } from '../cli/outcomeCommand.js';
import type { ServerResponse } from 'node:http';

const cron = vi.hoisted(() => ({ calls: [] as Array<{ pattern: string; options: { timezone?: string }; fn: () => Promise<void>; stop: ReturnType<typeof vi.fn> }> }));
vi.mock('croner', () => ({
  Cron: vi.fn(function (pattern: string, options: { timezone?: string }, fn: () => Promise<void>) {
    const stop = vi.fn();
    cron.calls.push({ pattern, options, fn, stop });
    return { stop };
  }),
}));

// AGT-4810: the digest's numbers against a fixture whose expected values were
// counted by hand (the comments next to each row), not recomputed by the code.

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const T = Date.parse('2026-11-14T00:00:00Z');

function fixtureDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-digest-'));
  roots.push(root);
  const dbPath = join(root, 'automation.db');
  new RunLedger(dbPath).close(); // the real schema
  const db = new Database(dbPath);
  const run = db.prepare(`
    INSERT INTO automation_runs(issue_id, source, identifier, title, project_path, state, discovered_at, updated_at, completed_at, pr_url, tracker_state, tracker_state_type)
    VALUES (?, 'linear', ?, 'T', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  run.run('r1', 'AGT-1', '/a', 'DONE', T - 2 * H, T + H, T + 1 * H, 'pr/1', 'Done', 'completed');      // Done with a PR
  run.run('r2', 'AGT-2', '/b', 'DONE', T + 1 * H, T + 5 * H, T + 5 * H, 'pr/2', 'Done', 'completed');  // Done with a PR
  run.run('r3', 'AGT-3', '/a', 'DONE', T, T + 3 * H, T + 3 * H, 'pr/3', null, null);                  // published, not Done
  run.run('r4', 'AGT-4', '/a', 'DONE', T - 9 * H, T - H, T - 1 * H, 'pr/4', 'Done', 'completed');      // Done before the window
  run.run('r5', 'AGT-5', '/b', 'NEEDS_HUMAN', T, T + 9 * H, null, null, null, null);                   // parked now
  run.run('r6', 'AGT-6', '/a', 'EXECUTING', T, T + 10 * H, null, null, null, null);
  const attempt = db.prepare(`
    INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at, finished_at, result_status, success, cost_usd)
    VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?)
  `);
  attempt.run('r1', 1, 1, 'finished', T - 1 * H, T - 0.5 * H, 'approved', 1, 1.0);           // before the window; counts for r1's cost
  attempt.run('r1', 2, 2, 'finished', T + 0.5 * H, T + 0.9 * H, 'approved', 1, 2.0);          // /a $2.00
  attempt.run('r1', 3, 3, 'finished', T + 0.95 * H, T + 0.96 * H, 'operator_remediated', 1, null); // finished, never spend
  attempt.run('r2', 1, 1, 'finished', T + 2 * H, T + 4 * H, 'approved', 1, 3.5);              // /b $3.50
  attempt.run('r2', 2, 2, 'finished', T + 4.5 * H, T + 4.6 * H, 'rate_limited', 0, null);     // /b no spend (NO_SPEND_STATUSES)
  attempt.run('r2', 3, 3, 'finished', T + 4.7 * H, T + 4.8 * H, 'failed', 0, null);           // /b unpriced
  attempt.run('r5', 1, 1, 'finished', T + 6 * H, T + 7 * H, 'failed', 0, null);               // /b unpriced
  attempt.run('r5', 2, 2, 'finished', T + 8 * H, T + 9 * H, 'infra_error', 0, 0.5);           // /b $0.50
  attempt.run('r6', 1, 1, 'running', T + 10 * H, null, null, null, null);                     // /a unpriced, not finished
  attempt.run('r6', 2, 2, 'running', T + D + 1 * M, null, null, null, 9.0);                   // after the window: today's spend
  const event = db.prepare(`INSERT INTO automation_events(issue_id, attempt_no, kind, created_at) VALUES (?, 1, ?, ?)`);
  event.run('r5', 'parked', T + 7 * H);                    // in window
  event.run('r5', 'operator_parked', T - 1 * H);           // before the window
  event.run('r5', 'operator_question_parked', T + 8 * H);  // in window, same run: 1 parked run
  event.run('r5', 'claimed', T + 8 * H);                   // not a park
  db.exec(`
    CREATE TABLE coordination_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, correlation_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', task_label TEXT);
    ${PAUSE_TABLE_DDL}
    ${SIGNAL_TABLE_DDL}
  `);
  const q = db.prepare("INSERT INTO coordination_trace(timestamp, kind, status, correlation_id, task_id, task_label) VALUES (?, ?, ?, ?, ?, ?)");
  q.run(T - 30 * D, 'human-question', 'open', 'q7', '', null);     // opened 31 days ago ...
  q.run(T - 20 * D, 'human-question', 'waiting', 'q4', '', null);  // stale: opened 21 days ago, never closed
  q.run(T - 40 * D, 'human-question', 'waiting', 'q6', '', null);  // older than 28 days: not read at all
  q.run(T + 1 * H, 'human-question', 'open', 'q1', '', null);
  q.run(T + 2 * H, 'human-question', 'answered', 'q1', '', null);  // closed
  q.run(T + 3 * H, 'human-question', 'waiting', 'q2', '', null);   // open, oldest: 21 h at T+24h
  q.run(T + 4 * H, 'human-question', 'open', 'q5', 'r1', null);    // stale: its run is DONE (by issue id)
  q.run(T + 5 * H, 'human-question', 'waiting', 'q7', '', null);   // ... touched today: still stale (opened 31 days ago)
  q.run(T + 6 * H, 'human-question', 'open', 'q8', '', 'AGT-4');   // stale: its run is DONE (by identifier)
  q.run(T + 10 * H, 'human-question', 'open', 'q3', '', null);
  q.run(T + 11 * H, 'human-question', 'running', 'q3', '', null);  // open
  q.run(T + 12 * H, 'status', 'open', 'x1', '', null);             // not a question
  q.run(T + 20 * H, 'human-question', 'open', 'q9', '', 'AGT-5');  // open: its run is NEEDS_HUMAN
  db.prepare("INSERT INTO automation_pauses VALUES ('/b', 'drain', 'redispatch', 'auto:redispatch', ?)").run(T + 9 * H);
  const lift = db.prepare('INSERT INTO automation_pause_lifts(scope, lifted_at) VALUES (?, ?)');
  lift.run('/a', T + 6 * H); // lifted in the window
  lift.run('*', T - 2 * H);  // lifted before it
  const signal = db.prepare('INSERT INTO automation_factory_signals(project_path, kind, issue_id, detail, created_at) VALUES (?, ?, NULL, NULL, ?)');
  signal.run('/a', 'sandbox_network', T + 2 * H);
  signal.run('/a', 'sandbox_network', T + 3 * H);
  signal.run('/b', 'pr_opened', T + 5 * H);
  signal.run('/b', 'pr_opened', T - 1 * H); // before the window
  const circuit = db.prepare('INSERT INTO automation_repo_circuits(project_path, reason, opened_at, open_until, updated_at) VALUES (?, ?, ?, ?, ?)');
  circuit.run('/a', 'failure circuit open: 6/6 in 1h', T + 23 * H, T + 25 * H, T + 23 * H); // open at T+24h
  circuit.run('/b', 'old', T, T + 2 * H, T);                                                // expired
  db.close();
  return dbPath;
}

// The budget's estimate per unpriced attempt: the mean of known positive costs
// started in the 7 days before `to` = (1.0 + 2.0 + 3.5 + 0.5 + 9.0) / 5.
const EST = 3.2;

describe('computeFactoryDigest against hand counts', () => {
  it('counts runs, questions, spend, pauses and KPIs exactly', () => {
    const db = new Database(fixtureDb(), { readonly: true });
    const d = computeFactoryDigest(db, { from: T, to: T + D });
    db.close();

    expect(d.runs).toEqual({
      merged: { measured: false, reason: expect.stringContaining('records no merge') },
      doneWithPr: 2,
      publishedNotDone: 1,
      parkedNow: 1,
      parkedRunsInWindow: 1, // two park events, one run
      finishedByStatus: { approved: 2, failed: 2, infra_error: 1, operator_remediated: 1, rate_limited: 1 },
    });
    expect(d.questions).toEqual({ open: 3, oldestAgeMs: 21 * H, stale: 4, staleSince: T + D - 28 * D });
    expect(d.spend).toEqual([
      // /b: 3.50 + 0.50 known; r2#3 and r5#1 unpriced; r2#2 rate_limited spent nothing
      { projectPath: '/b', attempts: 5, knownUsd: 4.0, unpricedAttempts: 2, estimatePerUnpricedUsd: EST, usd: expect.closeTo(4.0 + 2 * EST, 9) },
      // /a: 2.00 known; r6#1 unpriced; r1#3 operator remediation is not spend; r6#2 is after the window
      { projectPath: '/a', attempts: 2, knownUsd: 2.0, unpricedAttempts: 1, estimatePerUnpricedUsd: EST, usd: expect.closeTo(2.0 + EST, 9) },
    ]);
    expect(d.pauses).toEqual([{ scope: '/b', mode: 'drain', reason: 'redispatch', actor: 'auto:redispatch', since: T + 9 * H }]);
    expect(d.pauseLifts).toEqual([{ scope: '/a', liftedAt: T + 6 * H }]);
    expect(d.signals).toEqual([
      { kind: 'sandbox_network', projectPath: '/a', count: 2 },
      { kind: 'pr_opened', projectPath: '/b', count: 1 },
    ]);
    expect(d.circuits).toEqual([{ projectPath: '/a', reason: 'failure circuit open: 6/6 in 1h', openUntil: T + 25 * H }]);
    // r1: 1.00 + 2.00 (remediation excluded); r2: 3.50 + one unpriced failed attempt
    expect(d.kpis.costPerDoneIssue).toMatchObject({ issues: 2, knownUsd: 3.25, unpricedAttempts: 1, estimatePerUnpricedUsd: EST });
    expect(d.kpis.costPerDoneIssue!.usd).toBeCloseTo((6.5 + EST) / 2, 9);
    expect(d.kpis.costPerDoneIssue!.basis).toMatch(/merge not verified/);
    for (const kpi of ['cycleTimePerIssue', 'mergedPerHumanMinute', 'postMergeDefectRate', 'wrongDispatchRate'] as const) {
      expect(d.kpis[kpi].measured).toBe(false);
    }
  });

  it('prices spend exactly as the budget does for the same day', () => {
    const dbPath = fixtureDb();
    const db = new Database(dbPath, { readonly: true });
    try {
      const d = computeFactoryDigest(db, { from: T, to: T + D });
      // /b has no attempts after the window, so the budget's open-ended day matches.
      const budget = dailySpend(db, T + D - 1, { projectPath: '/b' });
      const b = d.spend.find((s) => s.projectPath === '/b')!;
      expect(b.knownUsd).toBe(budget.knownUsd);
      expect(b.unpricedAttempts).toBe(budget.unknownAttempts);
      expect(b.usd).toBeCloseTo(budget.totalUsd, 9);
      // A configured estimate is used as the budget uses it.
      expect(computeFactoryDigest(db, { from: T, to: T + D }, T + D, { unknownAttemptCostUsd: 0.25 }).spend[0])
        .toMatchObject({ projectPath: '/b', estimatePerUnpricedUsd: 0.25, usd: 4.5 });
    } finally {
      db.close();
    }
  });

  it('reports the previous full UTC day, not the 24 hours before it fires', () => {
    // Fired at 00:05Z: the day is [T, T+24h). r6#2 (today, $9.00) is not in it.
    const d = readFactoryDigest(fixtureDb(), T + D + 5 * M);
    expect([d.from, d.to]).toEqual([T, T + D]);
    expect(d.spend.find((s) => s.projectPath === '/a')).toMatchObject({ attempts: 2, knownUsd: 2.0 });
    expect(d.runs.doneWithPr).toBe(2);
    expect(formatFactoryDigest(d)).toContain('UTC day 2026-11-14 (2026-11-14T00:00Z → 2026-11-15T00:00Z)');
  });

  it('renders not-measured KPIs as such, never as a number', () => {
    const text = formatFactoryDigest(readFactoryDigest(fixtureDb(), T + D));
    expect(text).toMatch(/\*\*Runs merged\*\*: not measured \(the automation database records no merge/);
    expect(text).toContain('Done with a PR 2 (tracker state; merge not verified), published not Done 1, parked runs 1 in window / 1 now');
    expect(text).toContain('Questions waiting on you**: 3, oldest 21.0h (4 stale threads never closed, active since 2026-10-18, not counted)');
    expect(text).toContain('  b $10.40 (2 unpriced at ~$3.20 est.), 5 attempts\n  a $5.20 (1 unpriced at ~$3.20 est.), 2 attempts');
    expect(text).toContain('⏸ b paused now (drain, auto:redispatch): redispatch');
    expect(text).toContain('▶ a pause lifted 06:00Z');
    expect(text).toContain('⚑ sandbox_network ×2 (a)');
    expect(text).toContain('⚑ pr_opened ×1 (b)');
    expect(text).toMatch(/cost per Done issue \(issues the tracker marks Done with a PR, merge not verified; all their attempts\): \$4\.85 \(1 unpriced across 2 issues at ~\$3\.20 est\.\) per issue/);
    expect(text).toMatch(/cycle time per issue: not measured \(needs the merge time/);
    expect(text).toMatch(/merged changes per human minute: not measured \(/);
    expect(text).toMatch(/wrong-dispatch rate: not measured \(/);
    expect(text).not.toMatch(/cycle time[^\n]*: [\d≤]/);
    expect(text).not.toMatch(/human minute: 0/);
  });

  it('a missing database is an empty digest, not an error', () => {
    const close = vi.spyOn(Database.prototype, 'close');
    const d = readFactoryDigest(join(tmpdir(), 'openswarm-digest-missing', 'none.db'), T);
    expect(close).toHaveBeenCalledTimes(1);
    expect(d.runs.doneWithPr).toBe(0);
    expect(d.pauseLifts).toEqual([]);
    expect(d.signals).toEqual([]);
    expect(formatFactoryDigest(d)).toContain('cost per Done issue (issues the tracker marks Done with a PR, merge not verified; all their attempts): n/a (nothing Done)');
  });
});

// AGT-4810: merges, defects and wrong dispatches from the recorded outcomes
// (factoryOutcomes.ts), written through the same paths the daemon and the
// `openswarm outcome` CLI use.
describe('recorded outcomes', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const quiet = { actor: 'test', out: () => {} };

  /** r3 merged in the window, r4 and r2 too (defect test), r1 closed unmerged, r6 merged the day before. */
  /** Recorded through the coordinator the merge sweep calls (reconcileMergedPublications). */
  function withPrStates(merges: Array<[string, string, 'OPEN' | 'CLOSED' | 'MERGED', number?]>): string {
    const dbPath = fixtureDb();
    const ledger = new RunLedger(dbPath);
    const runs = new DurableRunCoordinator({ mode: 'primary', ledger });
    for (const [issueId, prUrl, state, mergedAt] of merges) {
      expect(runs.recordPullRequestState(issueId, prUrl, { state, mergedAt: mergedAt === undefined ? undefined : iso(mergedAt) }, T + D)).toBe(true);
    }
    ledger.close();
    expect(new DurableRunCoordinator({ mode: 'off' }).recordPullRequestState('r1', 'pr/1', { state: 'MERGED' })).toBe(false);
    return dbPath;
  }

  it('counts a change as completed only from its GitHub state', () => {
    const dbPath = withPrStates([
      ['r3', 'pr/3', 'OPEN'],                 // first read: still open ...
      ['r3', 'pr/3', 'MERGED', T + 4 * H],    // ... then merged in the window: counts (tracker never Done)
      ['r1', 'pr/1', 'CLOSED'],               // tracker Done, PR closed unmerged: does not count
      // r2: tracker Done, no PR state recorded: does not count
      ['r6', 'pr/6', 'MERGED', T - 2 * H],    // merged before the window
      ['ghost', 'pr/9', 'MERGED', T + 5 * H], // no run in the ledger: does not count
    ]);
    const db = new Database(dbPath);
    db.prepare("UPDATE automation_runs SET started_at = ? WHERE issue_id = 'r3'").run(T + 1 * H);
    db.close();
    const d = readFactoryDigest(dbPath, T + D);
    expect(d.runs.merged).toEqual({ measured: true, count: 1 });
    expect(d.runs.doneWithPr).toBe(2); // the tracker figure stays separate and labelled
    expect(d.kpis.cycleTimePerIssue).toEqual({ measured: true, medianMs: 3 * H, issues: 1 });
    const text = formatFactoryDigest(d);
    expect(text).toContain('**Runs merged**: 1 (GitHub PR state recorded by the merge sweep, merged in the window)');
    expect(text).toContain('cycle time per issue: median 3.0h over 1 merged issues (first start to GitHub merge)');
    // Recording never throws into the merge sweep.
    const closed = new Database(':memory:');
    closed.close();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(recordPullRequestStateInDb(closed, 'r1', 'pr/1', { state: 'MERGED' })).toBe(false);
  });

  it('computes the defect rate from reverts within 7 days', () => {
    const merges: Array<[string, string, 'MERGED' | 'CLOSED', number?]> = [
      ['r3', 'pr/3', 'MERGED', T + 4 * H], ['r4', 'pr/4', 'MERGED', T + 10 * H], ['r2', 'pr/2', 'MERGED', T + 12 * H], ['r1', 'pr/1', 'CLOSED'],
    ];
    const dbPath = withPrStates(merges);
    const before = readFactoryDigest(dbPath, T + D);
    expect(before.kpis.postMergeDefectRate).toEqual({ measured: false, reason: expect.stringContaining('no revert or hotfix has been recorded') });
    const deps = { ...quiet, dbPath, now: T + 10 * D };
    runDefectCommand('AGT-3', { kind: 'revert', at: iso(T + 4 * H + 2 * D), ref: 'abc123' }, deps); // r3: 2 days after merge, counts
    runDefectCommand('r4', { kind: 'revert', at: iso(T + 10 * H + 8 * D) }, deps);                  // r4: day 8, outside 7 days
    runDefectCommand('r2', { kind: 'hotfix', at: iso(T + 11 * H) }, deps);                           // r2: before its merge
    runDefectCommand('r1', { kind: 'revert', at: iso(T + 5 * H) }, deps);                            // r1: never merged
    expect(() => runDefectCommand('r3', { kind: 'oops' }, deps)).toThrow(/--kind/);
    expect(() => runDefectCommand('AGT-404', { kind: 'revert' }, deps)).toThrow(/no run/);

    const db = new Database(dbPath, { readonly: true });
    const d = computeFactoryDigest(db, { from: T, to: T + D }, T + 10 * D);
    // Read at the day's end, r3's revert (two days later) has not happened yet: 0 of 3, measured.
    const early = computeFactoryDigest(db, { from: T, to: T + D }, T + D);
    // The day before has no merge: nothing to divide by.
    const empty = computeFactoryDigest(db, { from: T - D, to: T }, T + 10 * D);
    db.close();
    expect(d.kpis.postMergeDefectRate).toEqual({ measured: true, rate: 1 / 3, numerator: 1, denominator: 3 });
    expect(early.kpis.postMergeDefectRate).toEqual({ measured: true, rate: 0, numerator: 0, denominator: 3 });
    expect(empty.kpis.postMergeDefectRate).toEqual({ measured: false, reason: 'no run merged in the window (GitHub PR state)' });
    // Merged, but none of the fixture's runs was ever started: no cycle time, said so.
    expect(d.kpis.cycleTimePerIssue).toEqual({ measured: false, reason: 'no run merged in the window has a recorded start' });
    expect(formatFactoryDigest(d)).toContain('post-merge defect rate (7 d): 33.3% (1 of 3 runs merged in the window reverted or hotfixed within 7 days of the merge)');
  });

  it('computes wrong-dispatch rate from runs marked should-not-have-run', () => {
    const dbPath = fixtureDb();
    expect(readFactoryDigest(dbPath, T + D).kpis.wrongDispatchRate).toEqual({ measured: false, reason: expect.stringContaining('should not have run') });
    const deps = { ...quiet, dbPath, now: T + D + H };
    runWrongDispatchCommand('AGT-5', { reason: 'blocked on a design decision' }, deps); // r5: dispatched in the window
    runWrongDispatchCommand('r4', { reason: 'duplicate' }, deps);                       // r4: no attempt in the window
    runWrongDispatchCommand('AGT-5', { reason: 'blocked upstream' }, deps);             // marking again replaces, still one run
    expect(() => runWrongDispatchCommand('r6', { reason: ' ' }, deps)).toThrow(/reason/);
    // Dispatched in the window (an attempt started in it): r1, r2, r5, r6. Marked among them: r5.
    const d = readFactoryDigest(dbPath, T + D);
    expect(d.kpis.wrongDispatchRate).toEqual({ measured: true, rate: 0.25, numerator: 1, denominator: 4 });
    expect(formatFactoryDigest(d)).toContain('wrong-dispatch rate: 25.0% (1 of 4 runs dispatched in the window marked should-not-have-run)');
    // Merged per human minute stays unmeasured: human minutes are not recorded.
    expect(d.kpis.mergedPerHumanMinute.measured).toBe(false);
    expect(readFactoryDigest(dbPath, T + 30 * D).kpis.wrongDispatchRate).toEqual({ measured: false, reason: 'no run was dispatched in the window' });
  });
});

describe('Discord delivery', () => {
  function bigDigest(): FactoryDigest {
    const d = readFactoryDigest(fixtureDb(), T + D);
    const long = 'x'.repeat(80);
    d.spend = Array.from({ length: 30 }, (_, i) => ({
      projectPath: `/repos/project-with-a-long-name-${i}`, attempts: i, knownUsd: 30 - i, unpricedAttempts: 0, estimatePerUnpricedUsd: 0, usd: 30 - i,
    }));
    d.pauses = Array.from({ length: 30 }, (_, i) => ({ scope: `/p${i}`, mode: 'drain', reason: `**reason ${i}** ${long}`, actor: 'auto:x', since: T }));
    return d;
  }

  it('caps long lists and names how many were left out', () => {
    const text = formatFactoryDigest(bigDigest(), { maxItems: 5 });
    expect(text).toContain('project-with-a-long-name-4 $26.00');
    expect(text).not.toContain('project-with-a-long-name-5 ');
    expect(text).toContain('  … and 25 more');
  });

  it('cuts whole lines before the KPIs and keeps the KPI section', () => {
    const full = formatFactoryDigest(bigDigest());
    expect(full.length).toBeGreaterThan(1900);
    const fitted = fitForDiscord(full);
    expect(fitted.length).toBeLessThanOrEqual(1900);
    const original = new Set(full.split('\n'));
    const kept = fitted.split('\n');
    expect(kept.filter((line) => !original.has(line))).toEqual(['… (cut to fit Discord; full digest on the dashboard)']);
    expect(fitted.endsWith(full.slice(full.indexOf(KPI_HEADING)))).toBe(true);
    expect(fitForDiscord('short')).toBe('short');
  });

  it('schedules in UTC and sends the fitted, capped previous-day digest', async () => {
    cron.calls.length = 0;
    const dbPath = fixtureDb();
    const send = vi.fn(async () => {});
    const stop = startFactoryDigest({ dbPath: () => dbPath, send, unknownAttemptCostUsd: () => 0.25 });
    expect(cron.calls).toHaveLength(1);
    expect(cron.calls[0].pattern).toBe('5 0 * * *');
    expect(cron.calls[0].options).toEqual({ timezone: 'UTC' });
    vi.useFakeTimers();
    vi.setSystemTime(T + D + 5 * M);
    await cron.calls[0].fn();
    vi.useRealTimers();
    const text = (send.mock.calls[0] as unknown as [string])[0];
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain('UTC day 2026-11-14');
    expect(text).toContain('b $4.50 (2 unpriced at ~$0.25 est.)');
    stop();
    expect(cron.calls[0].stop).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard route', () => {
  function call(dbPath: string): { status?: number; body?: string } {
    const captured: { status?: number; body?: string } = {};
    const res = { writeHead(s: number) { captured.status = s; return res; }, end(b: string) { captured.body = b; } } as unknown as ServerResponse;
    expect(handleFactoryDigest('/api/factory/digest', 'GET', res, dbPath)).toBe(true);
    return captured;
  }

  it('serves the digest on the dashboard route', () => {
    const dbPath = fixtureDb();
    vi.useFakeTimers();
    vi.setSystemTime(T + D);
    const captured = call(dbPath);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body!).digest.runs.doneWithPr).toBe(2);
    const res = { writeHead() { return res; }, end() {} } as unknown as ServerResponse;
    expect(handleFactoryDigest('/api/factory/other', 'GET', res, dbPath)).toBe(false);
  });

  it('memoizes the computed digest for 60 s per database', () => {
    const dbPath = fixtureDb();
    vi.useFakeTimers();
    vi.setSystemTime(T + D);
    expect(JSON.parse(call(dbPath).body!).digest.runs.parkedNow).toBe(1);
    const db = new Database(dbPath);
    db.prepare("UPDATE automation_runs SET state = 'NEEDS_HUMAN' WHERE issue_id = 'r6'").run();
    db.close();
    vi.setSystemTime(T + D + FACTORY_DIGEST_MEMO_MS - 1);
    expect(JSON.parse(call(dbPath).body!).digest.runs.parkedNow).toBe(1); // cached
    vi.setSystemTime(T + D + FACTORY_DIGEST_MEMO_MS);
    expect(JSON.parse(call(dbPath).body!).digest.runs.parkedNow).toBe(2); // recomputed
  });
});
