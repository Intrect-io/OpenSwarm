// Per-project publication progress is durable. Main only tracked outcomes in
// memory for the duration of one run: a project whose Linear update had already
// landed was republished on the next run of the same day, and a restart lost the
// day's progress entirely — publishing every project again. (AGT-3468)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearClient, Project } from '@linear/sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  home: `/tmp/openswarm-daily-reporter-progress-${process.pid}`,
  postStatusUpdate: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => testState.home,
}));

vi.mock('../linear/index.js', () => ({
  postStatusUpdate: testState.postStatusUpdate,
}));

import {
  generateDailyReports,
  registerProjectPath,
  setLinearClient,
  setTeamId,
} from './dailyReporter.js';

const watermarkFile = join(testState.home, '.openswarm', 'daily-reporter-watermark.json');
const today = new Date().toISOString().slice(0, 10);

const PROJECTS = [
  { id: 'project-a', name: 'Project A', state: 'started' },
  { id: 'project-b', name: 'Project B', state: 'started' },
] as Project[];

interface WatermarkRecord {
  date: string;
  publishedProjectIds: string[];
  complete: boolean;
}

function teamClient(projects: Project[]): LinearClient {
  const team = {
    projects: vi.fn().mockResolvedValue({
      nodes: projects,
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
  };
  return { team: vi.fn().mockResolvedValue(team) } as unknown as LinearClient;
}

function useTeam(projects: Project[] = PROJECTS): void {
  setLinearClient(teamClient(projects));
  setTeamId('team-1');
}

function readWatermarkRecord(): WatermarkRecord | null {
  if (!existsSync(watermarkFile)) return null;
  return JSON.parse(readFileSync(watermarkFile, 'utf8')) as WatermarkRecord;
}

function calledProjectIds(): string[] {
  return testState.postStatusUpdate.mock.calls.map(call => call[0] as string);
}

/** Leaves project A failing and project B published, so the day is incomplete. */
function failProjectA(): void {
  testState.postStatusUpdate.mockImplementation(async (projectId: string) => {
    if (projectId === 'project-a') throw new Error('temporary Linear failure');
  });
}

beforeEach(() => {
  rmSync(testState.home, { recursive: true, force: true });
  testState.postStatusUpdate.mockReset();
});

afterAll(() => {
  rmSync(testState.home, { recursive: true, force: true });
});

describe('daily reporter per-project publication progress', () => {
  // Static imports cannot work in the restart case: a fresh instance stands in
  // for a new process, so the module is re-imported after `vi.resetModules()`.
  it('republishes only the project that failed', async () => {
    failProjectA();
    useTeam();

    await generateDailyReports();
    // A failed once (plus its in-run retry), B published.
    expect(calledProjectIds()).toEqual(['project-a', 'project-b', 'project-a']);

    testState.postStatusUpdate.mockReset();
    testState.postStatusUpdate.mockResolvedValue(undefined);
    await generateDailyReports();

    // Project A is retried; project B already has its Linear update today.
    expect(calledProjectIds()).toEqual(['project-a']);
    const record = readWatermarkRecord();
    expect(record?.date).toBe(today);
    expect(record?.complete).toBe(true);
    expect(record?.publishedProjectIds.slice().sort()).toEqual(['project-a', 'project-b']);
  });

  it('resumes from the persisted progress after a restart', async () => {
    failProjectA();
    useTeam();
    registerProjectPath('project-b', '/tmp/project-b');

    await generateDailyReports();
    expect(readWatermarkRecord()?.publishedProjectIds ?? null).toEqual(['project-b']);

    testState.postStatusUpdate.mockReset();
    testState.postStatusUpdate.mockResolvedValue(undefined);

    // A fresh module instance stands in for a new process: nothing in memory
    // survives, so the day's progress can only come from disk.
    vi.resetModules();
    const restarted = await import('./dailyReporter.js');
    restarted.setLinearClient(teamClient(PROJECTS));
    restarted.setTeamId('team-1');
    await restarted.generateDailyReports();

    expect(calledProjectIds()).toEqual(['project-a']);
    // Proof the instance really is fresh: the in-memory path registration is
    // gone, so the retry carries no project path.
    expect(testState.postStatusUpdate).toHaveBeenCalledWith('project-a', 'Project A', undefined);
    expect(readWatermarkRecord()?.complete).toBe(true);
  });

  it('does not republish the day when a pre-existing watermark record is read', async () => {
    // Records written before per-project progress existed were only ever
    // written after a fully successful day, so deploying this change mid-day
    // must not treat that day as unpublished and republish every project.
    mkdirSync(join(testState.home, '.openswarm'), { recursive: true });
    writeFileSync(watermarkFile, JSON.stringify({ date: today }), 'utf8');
    testState.postStatusUpdate.mockResolvedValue(undefined);
    useTeam();

    await generateDailyReports();

    expect(testState.postStatusUpdate).not.toHaveBeenCalled();
    expect(readWatermarkRecord()?.date).toBe(today);
  });

  it('does not advance or persist the watermark when generation fails outright', async () => {
    // Nothing has ever been published: a failed generation must not leave
    // behind a watermark that would suppress the next attempt.
    const unavailable = new Error('Linear unavailable');
    setLinearClient({ team: vi.fn().mockRejectedValue(unavailable) } as unknown as LinearClient);
    setTeamId('team-1');

    await generateDailyReports();

    expect(existsSync(watermarkFile)).toBe(false);

    // Durable progress from an earlier run today must survive a generation
    // failure intact — neither completed nor discarded.
    failProjectA();
    useTeam();
    await generateDailyReports();

    expect(existsSync(watermarkFile)).toBe(true);
    const progress = readWatermarkRecord();
    expect(progress).toEqual({ date: today, publishedProjectIds: ['project-b'], complete: false });

    setLinearClient({ team: vi.fn().mockRejectedValue(unavailable) } as unknown as LinearClient);
    await generateDailyReports();

    expect(readWatermarkRecord()).toEqual(progress);
  });
});
