import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunLedger } from './runLedger.js';
import { FactoryPauseStore, pauseScopeKey } from './factoryPause.js';
import {
  DEFAULT_ANOMALY_THRESHOLDS,
  checkAnomalies,
  evaluateAnomalies,
  nonLoopbackConnectDenial,
  recordFactorySignal,
  type AnomalyThresholds,
  type ProjectObservations,
} from './anomalyPause.js';
import { RunnerPauseControl } from './runnerPauseControl.js';

// AGT-4809: each signal trips on its own, one trip writes one pause and one
// alert, a resume is not undone by the history it already acted on, and the
// 2026-10-20 run trips early.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tempRepo(): { root: string; repo: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-anomaly-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  return { root, repo: pauseScopeKey(repo), dbPath: join(root, 'automation.db') };
}

const T0 = Date.parse('2026-10-20T13:00:00Z');
const MIN = 60_000;
const none = (): ProjectObservations => ({ prOpenedAt: [], claims: [], finished: [], networkDenials: [] });
const quiet: AnomalyThresholds = { ...DEFAULT_ANOMALY_THRESHOLDS };

describe('evaluateAnomalies — one test per signal', () => {
  it('PR rate trips at the configured count within 60 minutes, not across a wider spread', () => {
    const spread = { ...none(), prOpenedAt: [T0, T0 + 40 * MIN, T0 + 80 * MIN] };
    expect(evaluateAnomalies(spread, quiet, T0 + 90 * MIN)).toBeUndefined();
    const burst = { ...none(), prOpenedAt: [T0, T0 + 10 * MIN, T0 + 20 * MIN] };
    expect(evaluateAnomalies(burst, quiet, T0 + 30 * MIN)).toMatchObject({ signal: 'pr_rate', at: T0 + 20 * MIN });
  });

  it('re-dispatch trips on the same issue, not on many issues claimed once', () => {
    const many = { ...none(), claims: Array.from({ length: 10 }, (_, i) => ({ issueId: `I-${i}`, at: T0 + i * MIN })) };
    expect(evaluateAnomalies(many, quiet, T0 + 60 * MIN)).toBeUndefined();
    const same = { ...none(), claims: [0, 5, 10, 15].map((m) => ({ issueId: 'I-1', at: T0 + m * MIN })) };
    expect(evaluateAnomalies(same, quiet, T0 + 20 * MIN)).toMatchObject({ signal: 'redispatch', at: T0 + 15 * MIN });
  });

  it('infra_error share trips only over a full window', () => {
    const statuses = ['infra_error', 'infra_error', 'infra_error', 'infra_error', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved'];
    const finished = statuses.map((status, i) => ({ status, at: T0 + i * MIN }));
    expect(evaluateAnomalies({ ...none(), finished: finished.slice(0, 9) }, quiet, T0 + 60 * MIN)).toBeUndefined();
    expect(evaluateAnomalies({ ...none(), finished }, quiet, T0 + 60 * MIN)).toMatchObject({ signal: 'infra_error_share' });
    const fewer = finished.map((f, i) => (i === 0 ? { ...f, status: 'approved' } : f));
    expect(evaluateAnomalies({ ...none(), finished: fewer }, quiet, T0 + 60 * MIN)).toBeUndefined();
  });

  it('a sandbox network denial trips immediately, and can be switched off', () => {
    const obs = { ...none(), networkDenials: [{ at: T0, command: 'curl https://example.com', target: '93.184.216.34:443' }] };
    expect(evaluateAnomalies(obs, quiet, T0 + MIN)).toMatchObject({ signal: 'sandbox_network' });
    expect(evaluateAnomalies(obs, { ...quiet, sandboxNetworkDenial: false }, T0 + MIN)).toBeUndefined();
  });
});

describe('nonLoopbackConnectDenial', () => {
  it('reads Node and curl refusals and ignores loopback', () => {
    expect(nonLoopbackConnectDenial('Error: connect EPERM 140.82.112.3:443\n    at TCPConnectWrap')).toBe('140.82.112.3:443');
    expect(nonLoopbackConnectDenial('curl: (7) Failed to connect to api.github.com port 443 after 2 ms: Operation not permitted')).toBe('api.github.com:443');
    expect(nonLoopbackConnectDenial('Error: connect EPERM 127.0.0.1:5432')).toBeUndefined();
    expect(nonLoopbackConnectDenial('curl: (7) Failed to connect to localhost port 3000: Operation not permitted')).toBeUndefined();
    expect(nonLoopbackConnectDenial('touch: /etc/x: Operation not permitted')).toBeUndefined();
  });
});

describe('checkAnomalies against the ledger', () => {
  function seedRedispatches(dbPath: string, projectPath: string, at: number): void {
    const ledger = new RunLedger(dbPath); // creates the schema
    ledger.registerRun({ issueId: 'uuid-1', source: 'linear', identifier: 'AGT-1', title: 'T', projectPath }, at);
    ledger.close();
    const db = new Database(dbPath);
    const insert = db.prepare(`
      INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at, finished_at, result_status, success)
      VALUES ('uuid-1', ?, ?, 'finished', 'worker', ?, ?, 'failed', 0)
    `);
    for (let i = 1; i <= 4; i++) insert.run(i, i, at + i * MIN, at + i * MIN + 1);
    db.close();
  }

  it('pauses once, alerts once, never overrides a standing pause, and does not re-trip on old history after a resume', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    seedRedispatches(dbPath, repo, now - 10 * MIN);
    const projects = [{ projectPath: repo, thresholds: quiet }];

    const first = checkAnomalies(dbPath, projects, now);
    expect(first).toEqual([expect.objectContaining({ projectPath: repo, paused: true, trip: expect.objectContaining({ signal: 'redispatch' }) })]);
    expect(first[0].trip.detail).toContain('AGT-1');
    const second = checkAnomalies(dbPath, projects, now + MIN);
    expect(second[0].paused).toBe(false);

    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: repo, actor: 'auto:redispatch' })]);
    store.clear(repo, now + 2 * MIN);
    expect(checkAnomalies(dbPath, projects, now + 3 * MIN)).toEqual([]);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('counts a PR once however many runs report it, and counts signals from a worktree under the repo', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    for (const url of ['pr/1', 'pr/1', 'pr/1', 'pr/2']) recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: url }, dbPath, now - MIN);
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now)).toEqual([]);
    recordFactorySignal({ projectPath: join(repo, 'worktree', 'x'), kind: 'pr_opened', detail: 'pr/3' }, dbPath, now - MIN);
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now)[0]).toMatchObject({ paused: true, trip: { signal: 'pr_rate' } });
  });
});

describe('RunnerPauseControl with the anomaly hook', () => {
  it('a trip in one heartbeat pauses that repository in the same heartbeat and alerts exactly once', async () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    recordFactorySignal({ projectPath: repo, kind: 'sandbox_network', detail: '1.2.3.4:443\ncurl http://1.2.3.4' }, dbPath, now - MIN);
    const control = new RunnerPauseControl(() => dbPath);
    const alert = vi.fn(async () => {});
    const scheduler = { getRunningTasks: () => [], cancelTask: () => false, cancelProjectTasks: vi.fn(() => 0) };
    const lines: string[] = [];
    const hook = { projects: [repo], alert, thresholds: async () => quiet };

    expect(await control.apply(scheduler, (l) => lines.push(l), hook, now)).toBe(true); // project pause, not global
    expect(control.blocks(repo)).toBe(true);
    await control.apply(scheduler, (l) => lines.push(l), hook, now + MIN);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String((alert.mock.calls[0] as unknown[])[0])).toContain('curl http://1.2.3.4');
    control.close();
  });
});

describe('replay of the 2026-10-20 run', () => {
  interface Fixture {
    attempts: Array<{ issue: string; startedAt: string; finishedAt: string | null; status: string }>;
    prsOpenedAt: string[];
  }
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/anomaly-replay-20261020.json', import.meta.url), 'utf8')) as Fixture;

  function observationsAt(now: number): ProjectObservations {
    return {
      prOpenedAt: fixture.prsOpenedAt.map(Date.parse).filter((t) => t <= now),
      claims: fixture.attempts.map((a) => ({ issueId: a.issue, at: Date.parse(a.startedAt) })).filter((c) => c.at <= now),
      finished: fixture.attempts
        .filter((a) => a.finishedAt && Date.parse(a.finishedAt) <= now)
        .map((a) => ({ status: a.status, at: Date.parse(a.finishedAt!) }))
        .sort((a, b) => a.at - b.at),
      networkDenials: [],
    };
  }

  function firstTrip(thresholds: AnomalyThresholds) {
    const start = Date.parse(fixture.attempts[0].startedAt);
    for (let now = start; now <= start + 6 * 60 * MIN; now += 10_000) {
      const trip = evaluateAnomalies(observationsAt(now), thresholds, now);
      if (trip) return { trip, minutesAfterFirstClaim: (trip.at - start) / MIN, minutesAfterFirstPr: (trip.at - Date.parse(fixture.prsOpenedAt[0])) / MIN };
    }
    return undefined;
  }

  it('is the run the issue describes: 187 attempts, 25 PRs between 13:38Z and 18:39Z', () => {
    expect(fixture.attempts).toHaveLength(187);
    expect(fixture.prsOpenedAt).toHaveLength(25);
    expect(fixture.prsOpenedAt[0]).toBe('2026-10-20T13:38:11Z');
    expect(fixture.prsOpenedAt.at(-1)).toBe('2026-10-20T18:39:21Z');
  });

  it('with the defaults, trips on PR rate at the third PR, 39 minutes into the PR flood', () => {
    const result = firstTrip(DEFAULT_ANOMALY_THRESHOLDS)!;
    expect(result.trip.signal).toBe('pr_rate');
    expect(new Date(result.trip.at).toISOString()).toBe('2026-10-20T14:17:20.000Z');
    // Leaving 22 of the 25 PRs unopened. Measured from the first claim this is
    // 60.7 minutes: the acceptance line's "first hour" is missed by 41 s.
    expect(result.minutesAfterFirstPr).toBeCloseTo(39.15, 1);
    expect(result.minutesAfterFirstClaim).toBeCloseTo(60.7, 1);
    expect(fixture.prsOpenedAt.filter((t) => Date.parse(t) > result.trip.at)).toHaveLength(22);
  });

  it('each other signal also trips on that run, later', () => {
    const off = { ...DEFAULT_ANOMALY_THRESHOLDS, maxPrsPerHour: 1_000 };
    expect(firstTrip(off)?.trip.signal).toBe('infra_error_share');
    expect(firstTrip(off)!.minutesAfterFirstClaim).toBeLessThan(90);
    expect(firstTrip({ ...off, maxInfraErrorShare: 1.1 })?.trip.signal).toBe('redispatch');
  });
});
