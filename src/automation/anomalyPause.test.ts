import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunLedger } from './runLedger.js';
import { FactoryPauseStore, pauseScopeKey } from './factoryPause.js';
import {
  DEFAULT_ANOMALY_THRESHOLDS,
  armAnomalyMonitor,
  checkAnomalies,
  evaluateAnomalies,
  nonLoopbackConnectDenial,
  pendingAnomalyAlerts,
  readProjectObservations,
  recordFactorySignal,
  type AnomalyThresholds,
  type ProjectObservations,
} from './anomalyPause.js';
import { RunnerPauseControl, defaultThresholdsFor } from './runnerPauseControl.js';

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
// Re-dispatch at 3 so the small fixtures below can reach it; the default is higher (see anomalyPause.ts).
const quiet: AnomalyThresholds = { ...DEFAULT_ANOMALY_THRESHOLDS, maxRedispatchesPer24h: 3 };

describe('evaluateAnomalies — one test per signal', () => {
  it('PR rate trips at the configured count within 60 minutes, not across a wider spread', () => {
    const spread = { ...none(), prOpenedAt: [T0, T0 + 40 * MIN, T0 + 80 * MIN] };
    expect(evaluateAnomalies(spread, quiet, T0 + 90 * MIN)).toBeUndefined();
    const burst = { ...none(), prOpenedAt: [T0, T0 + 10 * MIN, T0 + 20 * MIN] };
    expect(evaluateAnomalies(burst, quiet, T0 + 30 * MIN)).toMatchObject({ signal: 'pr_rate', at: T0 + 20 * MIN });
  });

  it('draft PR rate trips at its own lower count; the same opens as ready PRs do not', () => {
    const times = [T0, T0 + 12 * MIN];
    expect(evaluateAnomalies({ ...none(), prOpenedAt: times, draftPrOpenedAt: times }, quiet, T0 + 20 * MIN)).toMatchObject({ signal: 'draft_pr_rate', at: T0 + 12 * MIN });
    expect(evaluateAnomalies({ ...none(), prOpenedAt: times }, quiet, T0 + 20 * MIN)).toBeUndefined();
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

  it('a share of 0 means "any infra_error", never a trip on a window with none', () => {
    const clean = Array.from({ length: 10 }, (_, i) => ({ status: 'approved', at: T0 + i * MIN }));
    const zero = { ...quiet, maxInfraErrorShare: 0 };
    expect(evaluateAnomalies({ ...none(), finished: clean }, zero, T0 + 60 * MIN)).toBeUndefined();
    const one = clean.map((f, i) => (i === 9 ? { ...f, status: 'infra_error' } : f));
    expect(evaluateAnomalies({ ...none(), finished: one }, zero, T0 + 60 * MIN)).toMatchObject({ signal: 'infra_error_share' });
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
    // Linux bwrap, as measured on vela.
    expect(nonLoopbackConnectDenial('E ENETUNREACH connect ENETUNREACH 192.168.75.50:443 - Local (0.0.0.0:0)')).toBe('192.168.75.50:443');
    expect(nonLoopbackConnectDenial('curl: (7) Failed to connect to 140.82.112.3 port 443 after 0 ms: Could not connect to server')).toBe('140.82.112.3:443');
  });

  it('reads the name-resolution failures bwrap --unshare-net produces, with the hostname as target', () => {
    expect(nonLoopbackConnectDenial('curl: (6) Could not resolve host: github.com')).toBe('github.com');
    expect(nonLoopbackConnectDenial("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com")).toBe('github.com');
    expect(nonLoopbackConnectDenial('npm error request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org')).toBe('registry.npmjs.org');
    expect(nonLoopbackConnectDenial('Error: getaddrinfo EAI_AGAIN api.openai.com')).toBe('api.openai.com');
    expect(nonLoopbackConnectDenial('ssh: Could not resolve hostname x: Temporary failure in name resolution\nwget: unable to resolve host address; pypi.org: Temporary failure in name resolution')).toBe('pypi.org');
    expect(nonLoopbackConnectDenial('curl: (6) Could not resolve host: localhost')).toBeUndefined();
    expect(nonLoopbackConnectDenial("urllib3.exceptions.NewConnectionError: <...>: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution\nHTTPSConnectionPool(host='pypi.org', port=443)")).toBe('pypi.org');
    expect(nonLoopbackConnectDenial('socket.gaierror: [Errno -3] Temporary failure in name resolution')).toBe('unresolved host');
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
    armAnomalyMonitor(dbPath, now - 60 * MIN);
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
    armAnomalyMonitor(dbPath, now - 60 * MIN);
    for (const url of ['pr/1', 'pr/1', 'pr/1', 'pr/2']) recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: url }, dbPath, now - MIN);
    const three = { ...quiet, maxPrsPerHour: 3 };
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: three }], now)).toEqual([]);
    recordFactorySignal({ projectPath: join(repo, 'worktree', 'x'), kind: 'pr_opened', detail: 'pr/3' }, dbPath, now - MIN);
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: three }], now)[0]).toMatchObject({ paused: true, trip: { signal: 'pr_rate' } });
  });

  it('does not trip on history from before the monitor was armed (no retroactive pause after deploy)', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    seedRedispatches(dbPath, repo, now - 10 * MIN); // yesterday's bad day, already in the ledger
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now)).toEqual([]); // first run arms at `now`
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now + MIN)).toEqual([]);
    recordFactorySignal({ projectPath: repo, kind: 'sandbox_network', detail: '1.2.3.4:443\ncurl' }, dbPath, now + 2 * MIN);
    expect(checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now + 3 * MIN)[0]).toMatchObject({ paused: true, trip: { signal: 'sandbox_network' } });
  });

  it('a sandbox network trip pauses `now`; other signals drain', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    armAnomalyMonitor(dbPath, now - 60 * MIN);
    recordFactorySignal({ projectPath: repo, kind: 'sandbox_network', detail: '1.2.3.4:443\ncurl' }, dbPath, now - MIN);
    checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now);
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: repo, mode: 'now', actor: 'auto:sandbox_network' })]);
    store.close();
    const other = tempRepo();
    armAnomalyMonitor(other.dbPath, now - 60 * MIN);
    seedRedispatches(other.dbPath, other.repo, now - 10 * MIN);
    checkAnomalies(other.dbPath, [{ projectPath: other.repo, thresholds: quiet }], now);
    const store2 = new FactoryPauseStore(other.dbPath);
    expect(store2.list()).toEqual([expect.objectContaining({ mode: 'drain', actor: 'auto:redispatch' })]);
    store2.close();
  });

  it('pauseScope "factory" makes a trip pause the whole factory', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    armAnomalyMonitor(dbPath, now - 60 * MIN);
    seedRedispatches(dbPath, repo, now - 10 * MIN);
    const [result] = checkAnomalies(dbPath, [{ projectPath: repo, thresholds: { ...quiet, pauseScope: 'factory' } }], now);
    expect(result).toMatchObject({ scope: '*', paused: true });
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: '*', actor: 'auto:redispatch', reason: expect.stringContaining(repo) })]);
    store.close();
  });

  it('low disk pauses the factory once (auto:disk); a standing pause is not rewritten', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    const [first] = checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now, { line: '1.0 GiB free on /, below the 10.0 GiB floor' });
    expect(first).toMatchObject({ scope: '*', paused: true, trip: { signal: 'disk' } });
    expect(checkAnomalies(dbPath, [], now + MIN, { line: 'still low' })[0].paused).toBe(false);
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: '*', mode: 'drain', actor: 'auto:disk', reason: expect.stringContaining('1.0 GiB free') })]);
    store.close();
    expect(pendingAnomalyAlerts(dbPath, now + MIN)).toEqual([expect.objectContaining({ scope: '*', actor: 'auto:disk' })]);
  });

  it('normalizes a signal path and does not let LIKE wildcards in a repository name match a sibling', () => {
    const { root, dbPath } = tempRepo();
    const now = Date.now();
    const a = join(root, 'a_b');
    const sibling = join(root, 'axb');
    mkdirSync(a); mkdirSync(join(sibling, 'wt'), { recursive: true });
    armAnomalyMonitor(dbPath, now - 60 * MIN);
    // A relative, trailing-slash path is stored the way the claims store theirs.
    const cwd = process.cwd();
    try {
      process.chdir(root);
      recordFactorySignal({ projectPath: 'a_b/', kind: 'pr_opened', detail: 'pr/1' }, dbPath, now - MIN);
    } finally {
      process.chdir(cwd);
    }
    recordFactorySignal({ projectPath: join(sibling, 'wt'), kind: 'pr_opened', detail: 'pr/2' }, dbPath, now - 2 * MIN);
    const db = new Database(dbPath);
    // Only a_b's own PR: the relative path was normalized, and `_` did not match the `x` of axb.
    expect(readProjectObservations(db, pauseScopeKey(a), 0, 10, now).prOpenedAt).toEqual([now - MIN]);
    db.close();
  });

  it('adds the draft column to a signal table created before it, counting old rows as not draft', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE automation_factory_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, kind TEXT NOT NULL, issue_id TEXT, detail TEXT, created_at INTEGER NOT NULL)`);
    old.prepare("INSERT INTO automation_factory_signals(project_path, kind, detail, created_at) VALUES (?, 'pr_opened', 'pr/old', ?)").run(repo, now - 2 * MIN);
    old.close();
    recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: 'pr/new', draft: true }, dbPath, now - MIN);
    const db = new Database(dbPath);
    const obs = readProjectObservations(db, repo, 0, 10, now);
    db.close();
    expect(obs.prOpenedAt).toHaveLength(2);
    expect(obs.draftPrOpenedAt).toEqual([now - MIN]);
  });

  it('prunes signals older than 30 days', () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: 'old' }, dbPath, now - 31 * 24 * 60 * MIN);
    recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: 'new' }, dbPath, now - MIN);
    checkAnomalies(dbPath, [{ projectPath: repo, thresholds: quiet }], now);
    const db = new Database(dbPath);
    expect((db.prepare('SELECT detail FROM automation_factory_signals').all() as Array<{ detail: string }>).map((r) => r.detail)).toEqual(['new']);
    db.close();
  });
});

describe('RunnerPauseControl with the anomaly hook', () => {
  it('a trip in one heartbeat pauses that repository in the same heartbeat and alerts exactly once', async () => {
    const { repo, dbPath } = tempRepo();
    const now = Date.now();
    armAnomalyMonitor(dbPath, now - 60 * MIN);
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

  it('an alert that throws does not stop the next one, and is retried until it is sent once', async () => {
    const one = tempRepo();
    const dbPath = one.dbPath;
    const two = join(one.root, 'two');
    mkdirSync(two);
    const now = Date.now();
    armAnomalyMonitor(dbPath, now - 60 * MIN);
    for (const repo of [one.repo, pauseScopeKey(two)]) {
      recordFactorySignal({ projectPath: repo, kind: 'sandbox_network', detail: `1.2.3.4:443\ncurl ${repo}` }, dbPath, now - MIN);
    }
    let failFirst = true;
    const sent: string[] = [];
    const alert = vi.fn(async (message: string) => {
      if (failFirst && message.includes(one.repo.split('/').pop()!)) { failFirst = false; throw new Error('discord down'); }
      sent.push(message);
    });
    const control = new RunnerPauseControl(() => dbPath);
    const scheduler = { getRunningTasks: () => [], cancelTask: () => false, cancelProjectTasks: () => 0 };
    const hook = { projects: [one.repo, two], alert, thresholds: async () => quiet };
    const lines: string[] = [];
    await control.apply(scheduler, (l) => lines.push(l), hook, now);
    expect(sent).toHaveLength(1); // the second alert went out although the first threw
    expect(lines.some((l) => l.includes('Anomaly alert not sent'))).toBe(true);
    await control.apply(scheduler, () => {}, hook, now + MIN);
    await control.apply(scheduler, () => {}, hook, now + 2 * MIN);
    expect(sent).toHaveLength(2); // the failed one, retried once, then never again
    expect(sent.filter((m) => m.includes(`curl ${one.repo}`))).toHaveLength(1);
    control.close();
  });

  it('guardSerial aborts a serial run when a `now` pause lands, and marks it as a pause cancel (review C)', async () => {
    const { repo, dbPath } = tempRepo();
    const control = new RunnerPauseControl(() => dbPath);
    const store = new FactoryPauseStore(dbPath);
    const drained = await control.guardSerial('T-1', repo, async (signal) => {
      store.set({ projectPath: repo, actor: 'cli:test', mode: 'drain' });
      await new Promise((r) => setTimeout(r, 60));
      return signal.aborted;
    }, 10);
    expect(drained).toBe(false);
    expect(control.consumePauseCancel('T-1')).toBe(false);
    const reason = await control.guardSerial('T-2', repo, (signal) => new Promise<string>((resolve) => {
      store.set({ projectPath: repo, actor: 'cli:test', mode: 'now', reason: 'incident' });
      signal.addEventListener('abort', () => resolve(String((signal.reason as Error).message)), { once: true });
    }), 10);
    expect(reason).toContain('factory paused (now): incident');
    expect(control.consumePauseCancel('T-2')).toBe(true);
    expect(control.consumePauseCancel('T-2')).toBe(false); // consumed once
    store.close();
    control.close();
  });

  it('records the in-flight tasks a `now` pause cancels, and an unreadable table blocks every repository (review A, E)', async () => {
    const { root, repo, dbPath } = tempRepo();
    const control = new RunnerPauseControl(() => dbPath);
    const store = new FactoryPauseStore(dbPath);
    store.set({ projectPath: repo, actor: 'cli:test', mode: 'now' });
    const scheduler = {
      getRunningTasks: () => [{ task: { id: 'in-repo' }, projectPath: repo }, { task: { id: 'elsewhere' }, projectPath: join(root, 'other') }],
      cancelTask: () => false,
      cancelProjectTasks: () => 1,
    };
    await control.apply(scheduler, () => {});
    expect(control.consumePauseCancel('in-repo')).toBe(true);
    expect(control.consumePauseCancel('elsewhere')).toBe(false);
    store.close();
    control.close();
    const broken = new RunnerPauseControl(() => root); // a directory is no database
    expect(await broken.apply(scheduler, () => {})).toBe(false);
    expect(broken.blocks(repo)).toBe(true);
    broken.close();
  });

  it('warns once per distinct openswarm.json error instead of silently using the defaults', async () => {
    const { repo } = tempRepo();
    writeFileSync(join(repo, 'openswarm.json'), '{ not json');
    const warn = vi.fn();
    expect(await defaultThresholdsFor(repo, warn)).toEqual(DEFAULT_ANOMALY_THRESHOLDS);
    await defaultThresholdsFor(repo, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(repo);
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
      // Every PR that night was a draft for an unfinished run (fixture header, AGT-4809).
      draftPrOpenedAt: fixture.prsOpenedAt.map(Date.parse).filter((t) => t <= now),
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

  it('with the defaults, trips on draft PR rate at the second draft, 34 minutes after the first claim', () => {
    const result = firstTrip(DEFAULT_ANOMALY_THRESHOLDS)!;
    expect(result.trip.signal).toBe('draft_pr_rate');
    expect(new Date(result.trip.at).toISOString()).toBe('2026-10-20T13:50:55.000Z');
    expect(result.minutesAfterFirstClaim).toBeLessThan(60);
    expect(fixture.prsOpenedAt.filter((t) => Date.parse(t) > result.trip.at)).toHaveLength(23);
  });

  // PR #877's own replay, kept: the all-PR signal at its default, with the
  // draft signal (added in review, above) switched off so this one is measured.
  it('with the defaults, trips on PR rate at the third PR, 39 minutes into the PR flood', () => {
    const result = firstTrip({ ...DEFAULT_ANOMALY_THRESHOLDS, maxDraftPrsPerHour: 1_000 })!;
    expect(result.trip.signal).toBe('pr_rate');
    expect(new Date(result.trip.at).toISOString()).toBe('2026-10-20T14:17:20.000Z');
    expect(result.minutesAfterFirstPr).toBeCloseTo(39.15, 1);
    expect(fixture.prsOpenedAt.filter((t) => Date.parse(t) > result.trip.at)).toHaveLength(22);
  });

  /**
   * The acceptance line, through the path the daemon runs: the fixture is fed
   * into a real ledger database as time advances, and `RunnerPauseControl.apply`
   * (the heartbeat's call) runs on the default 15-minute autonomous schedule.
   */
  async function replayHeartbeats(thresholds: AnomalyThresholds, draft = true, until = 6 * 60 * MIN): Promise<{ pausedAt: number; alerts: string[] } | undefined> {
    const { repo, dbPath } = tempRepo();
    const firstClaim = Date.parse(fixture.attempts[0].startedAt);
    const QUARTER = 15 * MIN;
    const firstBeat = Math.floor(firstClaim / QUARTER) * QUARTER; // the heartbeat before the first claim arms the monitor
    const ledger = new RunLedger(dbPath);
    for (const issue of new Set(fixture.attempts.map((a) => a.issue))) {
      ledger.registerRun({ issueId: issue, source: 'linear', identifier: issue, title: issue, projectPath: repo }, firstBeat - MIN);
    }
    ledger.close();
    const db = new Database(dbPath);
    const insert = db.prepare(`
      INSERT INTO automation_attempts(issue_id, attempt_no, lease_epoch, status, stage, started_at)
      VALUES (?, ?, ?, 'running', 'worker', ?)
    `);
    const finish = db.prepare('UPDATE automation_attempts SET finished_at = ?, result_status = ?, status = \'finished\' WHERE issue_id = ? AND attempt_no = ?');
    const control = new RunnerPauseControl(() => dbPath);
    const alerts: string[] = [];
    const hook = { projects: [repo], alert: async (m: string) => { alerts.push(m); }, thresholds: async () => thresholds };
    const scheduler = { getRunningTasks: () => [], cancelTask: () => false, cancelProjectTasks: () => 0 };
    const started = new Set<number>();
    const finished = new Set<number>();
    const prs = new Set<number>();
    try {
      for (let beat = firstBeat; beat <= firstClaim + until; beat += QUARTER) {
        fixture.attempts.forEach((a, i) => {
          if (!started.has(i) && Date.parse(a.startedAt) <= beat) { started.add(i); insert.run(a.issue, a.attemptNo, a.attemptNo, Date.parse(a.startedAt)); }
          if (a.finishedAt && !finished.has(i) && Date.parse(a.finishedAt) <= beat) { finished.add(i); finish.run(Date.parse(a.finishedAt), a.status, a.issue, a.attemptNo); }
        });
        fixture.prsOpenedAt.forEach((t, i) => {
          if (!prs.has(i) && Date.parse(t) <= beat) { prs.add(i); recordFactorySignal({ projectPath: repo, kind: 'pr_opened', detail: `pr/${i}`, draft }, dbPath, Date.parse(t)); }
        });
        await control.apply(scheduler, () => {}, hook, beat);
        if (control.blocks(repo)) return { pausedAt: beat, alerts };
      }
      return undefined;
    } finally {
      db.close();
      control.close();
    }
  }

  it('through the heartbeat path with the defaults, the draft PRs pause within 60 minutes of the first claim, with one alert', async () => {
    const firstClaim = Date.parse(fixture.attempts[0].startedAt);
    const result = (await replayHeartbeats(DEFAULT_ANOMALY_THRESHOLDS))!;
    expect(new Date(result.pausedAt).toISOString()).toBe('2026-10-20T14:00:00.000Z');
    expect((result.pausedAt - firstClaim) / MIN).toBeLessThanOrEqual(60);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain('draft_pr_rate');
    expect(result.alerts[0]).toContain('automation.anomaly.maxDraftPrsPerHour');
  });

  it('the same PR timeline as READY PRs does not pause in the first hour under the all-PR default of 3', async () => {
    expect(DEFAULT_ANOMALY_THRESHOLDS.maxPrsPerHour).toBe(3);
    expect(await replayHeartbeats(DEFAULT_ANOMALY_THRESHOLDS, false, 60 * MIN)).toBeUndefined();
    // It does trip later, on the all-PR rate (14:17:20Z, seen by the 14:30 heartbeat).
    const later = (await replayHeartbeats(DEFAULT_ANOMALY_THRESHOLDS, false))!;
    expect(new Date(later.pausedAt).toISOString()).toBe('2026-10-20T14:30:00.000Z');
    expect(later.alerts[0]).toContain('(pr_rate)');
  });

  it('each other signal also trips on that run, later', () => {
    const off = { ...DEFAULT_ANOMALY_THRESHOLDS, maxPrsPerHour: 1_000, maxDraftPrsPerHour: 1_000, maxRedispatchesPer24h: 3 };
    expect(firstTrip(off)?.trip.signal).toBe('infra_error_share');
    expect(firstTrip(off)!.minutesAfterFirstClaim).toBeLessThan(90);
    expect(firstTrip({ ...off, maxInfraErrorShare: 1.1 })?.trip.signal).toBe('redispatch');
  });
});
