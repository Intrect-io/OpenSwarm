import { beforeEach, describe, expect, it, vi } from 'vitest';

const postStatusUpdateMock = vi.fn();
vi.mock('../linear/index.js', () => ({
  postStatusUpdate: (...args: unknown[]) => postStatusUpdateMock(...args),
}));

import {
  generateDailyReports,
  setLinearClient,
  setTeamId,
} from './dailyReporter.js';

describe('generateDailyReports retry targeting', () => {
  beforeEach(() => {
    postStatusUpdateMock.mockReset();
    setTeamId('team-1');
  });

  it('retries only projects whose first publication update failed', async () => {
    const projects = [
      { id: 'p-ok', name: 'Alpha', state: 'started' },
      { id: 'p-fail', name: 'Beta', state: 'started' },
      { id: 'p-ok2', name: 'Gamma', state: 'started' },
    ];

    setLinearClient({
      team: async () => ({
        projects: async () => ({
          nodes: projects,
          pageInfo: { hasNextPage: false, endCursor: null },
        }),
      }),
    } as never);

    postStatusUpdateMock.mockImplementation(async (id: string) => {
      if (id === 'p-fail') {
        // Fail once, then succeed on retry.
        if (postStatusUpdateMock.mock.calls.filter((c) => c[0] === 'p-fail').length === 1) {
          throw new Error('transient Linear error');
        }
      }
    });

    await generateDailyReports();

    const callsByProject = postStatusUpdateMock.mock.calls.map((c) => c[0] as string);
    expect(callsByProject.filter((id) => id === 'p-ok')).toHaveLength(1);
    expect(callsByProject.filter((id) => id === 'p-ok2')).toHaveLength(1);
    expect(callsByProject.filter((id) => id === 'p-fail')).toHaveLength(2);
  });
});
