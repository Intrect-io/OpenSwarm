import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearClient, Project } from '@linear/sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  home: `/tmp/openswarm-daily-reporter-${process.pid}`,
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
  setLinearClient,
  setTeamId,
} from './dailyReporter.js';

const watermarkFile = join(testState.home, '.openswarm', 'daily-reporter-watermark.json');

function configureReporter(): { team: ReturnType<typeof vi.fn> } {
  const project = { id: 'project-1', name: 'Project One', state: 'started' } as Project;
  const team = {
    projects: vi.fn().mockResolvedValue({
      nodes: [project],
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
  };
  const client = { team: vi.fn().mockResolvedValue(team) } as unknown as LinearClient;

  setLinearClient(client);
  setTeamId('team-1');
  return { team: client.team as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  rmSync(testState.home, { recursive: true, force: true });
  testState.postStatusUpdate.mockReset();
});

afterAll(() => {
  rmSync(testState.home, { recursive: true, force: true });
});

describe('daily reporter watermark', () => {
  it('skips a duplicate run after a successful report', async () => {
    testState.postStatusUpdate.mockResolvedValue(undefined);
    const { team } = configureReporter();

    await generateDailyReports();
    await generateDailyReports();

    expect(testState.postStatusUpdate).toHaveBeenCalledTimes(1);
    expect(team).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(watermarkFile, 'utf8'))).toEqual({
      date: new Date().toISOString().slice(0, 10),
    });
  });

  it('retries after a partial failure because no watermark is written', async () => {
    testState.postStatusUpdate
      .mockRejectedValueOnce(new Error('temporary Linear failure'))
      .mockResolvedValueOnce(undefined);
    configureReporter();

    await generateDailyReports();
    expect(existsSync(watermarkFile)).toBe(false);

    await generateDailyReports();
    expect(testState.postStatusUpdate).toHaveBeenCalledTimes(2);
    expect(existsSync(watermarkFile)).toBe(true);
  });
});
