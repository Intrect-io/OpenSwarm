import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';
import {
  FactoryPauseStore,
  GLOBAL_PAUSE_SCOPE,
  formatPauseLine,
  pauseScopeKey,
  readPauseSnapshot,
  snapshotBlocks,
} from './factoryPause.js';
import { runPauseCommand, runResumeCommand } from '../cli/pauseCommand.js';
import { setAutomationDbPath } from './automationDbPath.js';

// AGT-4808: the factory kill switch. A durable pause row in the automation
// database that every claim reads, that survives a restart, and that the CLI
// and the dashboard write.

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-pause-'));
  roots.push(root);
  return root;
}

function register(ledger: RunLedger, issueId: string, projectPath: string): void {
  ledger.registerRun({ issueId, source: 'linear', identifier: issueId, title: `Task ${issueId}`, projectPath }, 1_000);
}

function tryClaim(ledger: RunLedger, issueId: string, now = 2_000) {
  return ledger.claimRun(issueId, { ownerInstanceId: 'daemon', leaseMs: 60_000, maxActiveForProject: 4, now });
}

function task(id: string): TaskItem {
  return {
    id, issueId: id, issueIdentifier: id, source: 'linear', title: `Task ${id}`,
    priority: 2, createdAt: Date.now(), linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
  };
}

function ok(): PipelineResult {
  return { success: true, sessionId: 's', stages: [], finalStatus: 'approved', totalDuration: 1, iterations: 1 };
}

afterEach(() => {
  vi.unstubAllEnvs();
  setAutomationDbPath(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pause scope keys', () => {
  it('normalizes trailing slashes and relative paths to the key the ledger stores', () => {
    const root = tempRoot();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const key = pauseScopeKey(repo);
    expect(pauseScopeKey(`${repo}/`)).toBe(key);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(pauseScopeKey('./repo')).toBe(key);
    } finally {
      process.chdir(cwd);
    }
  });

  it('treats no project as the whole factory and rejects an empty one', () => {
    expect(pauseScopeKey(undefined)).toBe(GLOBAL_PAUSE_SCOPE);
    expect(pauseScopeKey(null)).toBe(GLOBAL_PAUSE_SCOPE);
    expect(() => pauseScopeKey('  ')).toThrow();
  });
});

describe('FactoryPauseStore', () => {
  it('survives a restart: a pause written by one handle is read by a fresh one', () => {
    const dbPath = join(tempRoot(), 'automation.db');
    const first = new FactoryPauseStore(dbPath);
    first.set({ actor: 'cli:test', reason: 'incident', mode: 'drain' }, 10_000);
    first.close();

    const second = new FactoryPauseStore(dbPath);
    expect(second.list()).toEqual([
      { scope: GLOBAL_PAUSE_SCOPE, mode: 'drain', reason: 'incident', actor: 'cli:test', createdAt: 10_000 },
    ]);
    second.close();
  });

  it('reports whether a pause already existed, keeps its start time, and clears by scope', () => {
    const root = tempRoot();
    const store = new FactoryPauseStore(join(root, 'automation.db'));
    expect(store.set({ projectPath: root, actor: 'a' }, 1_000).existed).toBe(false);
    const again = store.set({ projectPath: `${root}/`, actor: 'b', mode: 'now' }, 5_000);
    expect(again.existed).toBe(true);
    expect(again.pause).toMatchObject({ mode: 'now', actor: 'b', createdAt: 1_000 });
    expect(store.list()).toHaveLength(1);
    expect(store.clear(GLOBAL_PAUSE_SCOPE)).toBe(false);
    expect(store.clear(root)).toBe(true);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('a global pause blocks every repository; a project pause blocks only its own', () => {
    const root = tempRoot();
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a); mkdirSync(b);
    const store = new FactoryPauseStore(join(root, 'automation.db'));
    store.set({ projectPath: a, actor: 'x' });
    let snapshot = readPauseSnapshot(store);
    expect(snapshotBlocks(snapshot, `${a}/`)).toBeDefined();
    expect(snapshotBlocks(snapshot, b)).toBeUndefined();
    expect(store.blocking(b)).toBeUndefined();

    store.set({ actor: 'x', reason: 'all stop' });
    snapshot = readPauseSnapshot(store);
    expect(snapshotBlocks(snapshot, b)?.reason).toBe('all stop');
    expect(store.blocking(b)?.scope).toBe(GLOBAL_PAUSE_SCOPE);
    store.close();
  });

  it('reports an unreadable table instead of throwing, so the heartbeat can hold dispatch', () => {
    const snapshot = readPauseSnapshot({ list: () => { throw new Error('SQLITE_CORRUPT'); } });
    expect(snapshot.unreadable).toContain('SQLITE_CORRUPT');
  });

  it('formats one heartbeat line with scope, mode, age, actor and reason', () => {
    const line = formatPauseLine({ scope: '/x/cgf-portal', mode: 'now', reason: 'drafts flood', actor: 'cli:op', createdAt: 0 }, 5 * 60_000);
    expect(line).toBe('⏸ Paused (cgf-portal, now) for 5m by cli:op: drafts flood');
  });
});

describe('claims while paused', () => {
  it('claims 0 runs from a paused project and still claims from the others', () => {
    const root = tempRoot();
    const paused = join(root, 'paused');
    const open = join(root, 'open');
    mkdirSync(paused); mkdirSync(open);
    const dbPath = join(root, 'automation.db');
    const ledger = new RunLedger(dbPath);
    const store = new FactoryPauseStore(dbPath);
    const pausedKey = pauseScopeKey(paused);
    for (const id of ['P-1', 'P-2', 'P-3']) register(ledger, id, pausedKey);
    register(ledger, 'O-1', pauseScopeKey(open));

    store.set({ projectPath: `${paused}/`, actor: 'cli:test' });

    const claims = ['P-1', 'P-2', 'P-3'].map((id) => tryClaim(ledger, id));
    expect(claims.filter(Boolean)).toHaveLength(0);
    expect(tryClaim(ledger, 'O-1')).not.toBeNull();
    // A refused claim is not an attempt: the row is untouched.
    expect(ledger.getRun('P-1')).toMatchObject({ state: 'READY', attemptNo: 0 });

    store.clear(paused);
    expect(tryClaim(ledger, 'P-1')).not.toBeNull();
    store.close();
    ledger.close();
  });

  it('claims 0 runs anywhere under a global pause', () => {
    const root = tempRoot();
    const dbPath = join(root, 'automation.db');
    const ledger = new RunLedger(dbPath);
    register(ledger, 'A-1', '/repo-a');
    register(ledger, 'B-1', '/repo-b');
    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test' });
    expect(tryClaim(ledger, 'A-1')).toBeNull();
    expect(tryClaim(ledger, 'B-1')).toBeNull();
    store.close();
    ledger.close();
  });

  it('the coordinator does not run the executor and does not rewrite the row as a retry', async () => {
    const root = tempRoot();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const dbPath = join(root, 'automation.db');
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath, instanceId: 'daemon' });
    const store = new FactoryPauseStore(dbPath);
    store.set({ projectPath: repo, actor: 'cli:test', reason: 'hold' });
    const executor = vi.fn(async () => ok());

    const result = await coordinator.execute(task('AGT-1'), repo, executor);

    expect(executor).not.toHaveBeenCalled();
    expect(result.finalStatus).toBe('superseded');
    expect(result.taskContext?.taskTitle).toContain('factory paused: hold');
    const run = coordinator.listRuns().find((r) => r.issueId === 'AGT-1');
    expect(run).toMatchObject({ state: 'READY', attemptNo: 0 });

    store.clear(repo);
    const resumed = await coordinator.execute(task('AGT-1'), repo, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(resumed.success).toBe(true);
    store.close();
    coordinator.close();
  });
});

describe('openswarm pause / unpause', () => {
  it('writes the pause into the configured automation database and lifts it again', () => {
    const root = tempRoot();
    const dbPath = join(root, 'configured.db');
    vi.stubEnv('OPENSWARM_AUTOMATION_DB', '');
    const lines: string[] = [];
    const deps = {
      loadConfig: () => ({ autonomous: { automationDbPath: dbPath } }) as never,
      actor: 'cli:test',
      out: (line: string) => lines.push(line),
    };

    const paused = runPauseCommand({ project: root, now: true, reason: 'incident' }, deps);
    expect(paused.dbPath).toBe(dbPath);
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([
      expect.objectContaining({ scope: pauseScopeKey(root), mode: 'now', reason: 'incident', actor: 'cli:test' }),
    ]);

    const listed = runPauseCommand({ list: true }, deps);
    expect(listed.pauses).toHaveLength(1);

    runResumeCommand({ project: `${root}/` }, deps);
    expect(store.list()).toEqual([]);
    expect(lines.some((l) => l.startsWith('Resumed'))).toBe(true);
    store.close();
  });

  it('refuses --now together with --drain', () => {
    const dbPath = join(tempRoot(), 'a.db');
    expect(() => runPauseCommand({ now: true, drain: true }, {
      loadConfig: () => ({ autonomous: { automationDbPath: dbPath } }) as never, out: () => {},
    })).toThrow(/mutually exclusive/);
  });

  it('still pauses when the config cannot be loaded', () => {
    const dbPath = join(tempRoot(), 'env.db');
    vi.stubEnv('OPENSWARM_AUTOMATION_DB', dbPath);
    const result = runPauseCommand({}, { loadConfig: () => { throw new Error('no config'); }, actor: 'cli:test', out: () => {} });
    expect(result.dbPath).toBe(dbPath);
    expect(result.pauses?.[0]).toMatchObject({ scope: GLOBAL_PAUSE_SCOPE, mode: 'drain' });
  });
});
