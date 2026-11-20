// Two daemon instances firing the same cron used to both read an empty
// watermark and publish every project twice: `reportInFlight` only guards one
// process. A report run now holds a cross-process file lock from the watermark
// read to the last write. (AGT-4902)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearClient, Project } from '@linear/sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  home: `/tmp/openswarm-daily-reporter-lock-${process.pid}`,
  postStatusUpdate: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => testState.home,
}));

vi.mock('../linear/index.js', () => ({
  postStatusUpdate: testState.postStatusUpdate,
}));

const stateDir = join(testState.home, '.openswarm');
const watermarkFile = join(stateDir, 'daily-reporter-watermark.json');
const lockFile = `${watermarkFile}.lock`;
const today = new Date().toISOString().slice(0, 10);

const PROJECTS = [
  { id: 'project-a', name: 'Project A', state: 'started' },
  { id: 'project-b', name: 'Project B', state: 'started' },
] as Project[];

type ReporterModule = typeof import('./dailyReporter.js');

/** A fresh module instance stands in for a separate daemon process. */
async function daemonInstance(): Promise<ReporterModule> {
  vi.resetModules();
  const reporter = await import('./dailyReporter.js');
  const team = {
    projects: vi.fn().mockResolvedValue({
      nodes: PROJECTS,
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
  };
  reporter.setLinearClient({ team: vi.fn().mockResolvedValue(team) } as unknown as LinearClient);
  reporter.setTeamId('team-1');
  return reporter;
}

function publishCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of testState.postStatusUpdate.mock.calls) {
    const id = call[0] as string;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

beforeEach(() => {
  rmSync(testState.home, { recursive: true, force: true });
  testState.postStatusUpdate.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  rmSync(testState.home, { recursive: true, force: true });
});

describe('daily reporter cross-process serialization', () => {
  it('publishes each project once when two instances run at the same time', async () => {
    // Slow publishes keep the first run inside its critical section while the
    // second one starts, which is exactly the overlapping cron fire.
    testState.postStatusUpdate.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    );
    const first = await daemonInstance();
    const second = await daemonInstance();

    await Promise.all([first.generateDailyReports(), second.generateDailyReports()]);

    expect(publishCounts()).toEqual({ 'project-a': 1, 'project-b': 1 });
    const record = JSON.parse(readFileSync(watermarkFile, 'utf8')) as {
      date: string;
      publishedProjectIds: string[];
      complete: boolean;
    };
    expect(record.date).toBe(today);
    expect(record.complete).toBe(true);
    expect(record.publishedProjectIds.slice().sort()).toEqual(['project-a', 'project-b']);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('skips the run without publishing while a live instance holds the lock', async () => {
    mkdirSync(stateDir, { recursive: true });
    // This process is alive, so the lock is not stale.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-instance' }), 'utf8');
    testState.postStatusUpdate.mockResolvedValue(undefined);
    const reporter = await daemonInstance();

    await reporter.generateDailyReports({ lockWaitMs: 50 });

    expect(testState.postStatusUpdate).not.toHaveBeenCalled();
    expect(existsSync(watermarkFile)).toBe(false);
    // The other holder's lock is left in place.
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).token).toBe('other-instance');
  });

  it('reclaims a lock left by an instance that died and publishes', async () => {
    mkdirSync(stateDir, { recursive: true });
    // Far above any pid_max, so `kill(pid, 0)` reports ESRCH: the owner is dead.
    writeFileSync(lockFile, JSON.stringify({ pid: 2_000_000_000, token: 'dead-instance' }), 'utf8');
    testState.postStatusUpdate.mockResolvedValue(undefined);
    const reporter = await daemonInstance();

    await reporter.generateDailyReports({ lockWaitMs: 1_000 });

    expect(publishCounts()).toEqual({ 'project-a': 1, 'project-b': 1 });
    expect(existsSync(lockFile)).toBe(false);
  });
});
