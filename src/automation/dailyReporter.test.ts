import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { DAILY_REPORT_PROGRESS_FILE, generateDailyReports, setLinearClient, setTeamId } from './dailyReporter.js';

const postStatusUpdate = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../linear/index.js', () => ({
  postStatusUpdate,
}));

describe('generateDailyReports progress', () => {
  beforeEach(() => {
    postStatusUpdate.mockClear();
    setTeamId('team-1');
    try { unlinkSync(DAILY_REPORT_PROGRESS_FILE); } catch { /* missing is fine */ }
    try { unlinkSync(`${DAILY_REPORT_PROGRESS_FILE}.lock`); } catch { /* missing is fine */ }
  });

  afterEach(() => {
    setLinearClient(null as never);
    setTeamId('');
    try { unlinkSync(DAILY_REPORT_PROGRESS_FILE); } catch { /* ignore */ }
    try { unlinkSync(`${DAILY_REPORT_PROGRESS_FILE}.lock`); } catch { /* ignore */ }
  });

  it('retries only projects that failed on the previous run', async () => {
    postStatusUpdate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('linear down'))
      .mockResolvedValueOnce(undefined);

    const projects = {
      nodes: [
        { id: 'p-ok', name: 'Ok', state: 'started' },
        { id: 'p-fail', name: 'Fail', state: 'started' },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    };

    setLinearClient({
      team: async () => ({
        projects: async () => projects,
      }),
    } as never);

    await generateDailyReports();
    expect(postStatusUpdate).toHaveBeenCalledTimes(2);
    expect(postStatusUpdate.mock.calls.map((c) => c[0])).toEqual(['p-ok', 'p-fail']);

    postStatusUpdate.mockClear();
    postStatusUpdate.mockResolvedValueOnce(undefined);

    await generateDailyReports();
    expect(postStatusUpdate).toHaveBeenCalledTimes(1);
    expect(postStatusUpdate.mock.calls[0]?.[0]).toBe('p-fail');
  });
});
