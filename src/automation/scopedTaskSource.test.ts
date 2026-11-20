// AGT-3188: the shared heartbeat fetcher records whether a milestone scope matched anything, so a
// wrong/renamed/archived milestone shows up as `matched: false` instead of a silently idle daemon.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const linearMock = vi.hoisted(() => ({
  isLinearInitialized: vi.fn(() => true),
  ensureLinearAuthFresh: vi.fn(async () => undefined),
  getMyIssues: vi.fn(async (_opts?: Record<string, unknown>) => [] as unknown[]),
}));
vi.mock('../linear/index.js', () => linearMock);
vi.mock('../taskState/store.js', () => ({
  syncTaskStatesFromIssues: vi.fn(),
  enrichTaskFromState: vi.fn((task: unknown) => task),
}));
vi.mock('../orchestration/decisionEngine.js', () => ({
  linearIssueToTask: vi.fn((issue: { id: string }) => ({ id: issue.id })),
}));

const { fetchScopedLinearTasks } = await import('./scopedTaskSource.js');
const { getWorkScope, setWorkScope } = await import('../core/workScope.js');

describe('fetchScopedLinearTasks (AGT-3188)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the scope unmatched when the milestone returns no issues in any state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setWorkScope({ milestone: 'Typo milestone' });
    await expect(fetchScopedLinearTasks()).resolves.toEqual([]);
    await fetchScopedLinearTasks();
    expect(getWorkScope()).toEqual({ milestone: 'Typo milestone', matched: false });
    expect(warn.mock.calls.filter(([m]) => String(m).includes('"Typo milestone" matched no open issues'))).toHaveLength(1);

    linearMock.getMyIssues.mockResolvedValueOnce([{ id: 'a', state: 'Todo' }]);
    await expect(fetchScopedLinearTasks()).resolves.toEqual([{ id: 'a' }]);
    expect(getWorkScope().matched).toBe(true);
    warn.mockRestore();
  });

  it('does not record a failed fetch as an empty scope', async () => {
    setWorkScope({ milestone: 'S4' });
    linearMock.getMyIssues.mockRejectedValueOnce(new Error('Linear down'));
    await expect(fetchScopedLinearTasks()).rejects.toThrow('Linear down');
    expect(getWorkScope().matched).toBeUndefined();
  });

  it('does not record an empty result from an uninitialised Linear client', async () => {
    setWorkScope({ milestone: 'S4' });
    linearMock.isLinearInitialized.mockReturnValueOnce(false);
    await fetchScopedLinearTasks();
    expect(getWorkScope().matched).toBeUndefined();
  });
});
