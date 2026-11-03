import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => ({
  path: `/tmp/openswarm-scheduler-${process.pid}`,
}));

const pending = vi.hoisted(() => ({
  finishers: [] as Array<(success: boolean) => void>,
}));

const runClaudeTaskMock = vi.hoisted(() => vi.fn());

vi.mock('os', () => ({
  homedir: () => testHome.path,
}));

vi.mock('../adapters/claudeTask.js', () => ({
  runClaudeTask: runClaudeTaskMock,
}));

import {
  addSchedule,
  getRecentResults,
  getRunningJobs,
  listSchedules,
  runNow,
  stopAllSchedules,
} from './scheduler.js';

/** `held` keeps each run in flight until the test finishes it. */
function mockRuns(held = false): void {
  runClaudeTaskMock.mockImplementation(() => new Promise((resolve) => {
    const finish = (success: boolean) => resolve({ success, stdout: '', resultText: '' });
    if (held) pending.finishers.push(finish);
    else queueMicrotask(() => finish(true));
  }));
}

describe('runNow bypass execution', () => {
  beforeEach(async () => {
    stopAllSchedules();
    pending.finishers = [];
    runClaudeTaskMock.mockReset();
    await rm(testHome.path, { recursive: true, force: true });
  });

  it('uses the scheduled-job path when bypassing the time window', async () => {
    mockRuns();
    await addSchedule('nightly', testHome.path, 'do work', '0 3 * * *');

    await expect(runNow('nightly', true)).resolves.toBe(true);

    expect(runClaudeTaskMock).toHaveBeenCalledTimes(1);
    expect(getRecentResults(1)[0]).toMatchObject({ success: true });
    expect((await listSchedules())[0]).toMatchObject({
      name: 'nightly',
      consecutiveFailures: 0,
    });
    expect((await listSchedules())[0].lastRun).toEqual(expect.any(Number));
  });

  it('does not start a second bypass run for a job that is already running', async () => {
    mockRuns(true);
    await addSchedule('nightly', testHome.path, 'do work', '0 3 * * *');

    const first = runNow('nightly', true);
    for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(getRunningJobs()).toHaveLength(1);

    await expect(runNow('nightly', true)).resolves.toBe(false);
    expect(runClaudeTaskMock).toHaveBeenCalledTimes(1);

    pending.finishers[0](true);
    await expect(first).resolves.toBe(true);
  });
});
