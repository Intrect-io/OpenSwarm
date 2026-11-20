// AGT-3188: `!auto start` used to register its own task source that called getMyIssues without the
// milestone, silently replacing the scoped source service.ts registered at boot. Both paths now share
// one factory; this drives the real Discord handler and proves the fetch it registers stays scoped.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITaskSource } from '../automation/taskSource.js';

const runnerMock = vi.hoisted(() => ({
  setNotifier: vi.fn(),
  setTaskSource: vi.fn(),
  startAutonomous: vi.fn(async () => undefined),
  stopAutonomous: vi.fn(async () => undefined),
  getRunner: vi.fn(),
}));
const linearMock = vi.hoisted(() => ({
  isLinearInitialized: vi.fn(() => true),
  ensureLinearAuthFresh: vi.fn(async () => undefined),
  getMyIssues: vi.fn(async (_opts?: Record<string, unknown>) => [] as unknown[]),
}));

vi.mock('../automation/autonomousRunner.js', () => runnerMock);
vi.mock('../linear/index.js', () => linearMock);
vi.mock('../taskState/store.js', () => ({
  syncTaskStatesFromIssues: vi.fn(),
  enrichTaskFromState: vi.fn((task: unknown) => task),
}));
vi.mock('../orchestration/decisionEngine.js', () => ({
  linearIssueToTask: vi.fn((issue: { id: string }) => ({ id: issue.id })),
}));

const { handleAuto } = await import('./discordHandlers.js');
const { setWorkScope } = await import('../core/workScope.js');

function makeMessage() {
  return { reply: vi.fn(async () => ({ id: 'reply' })), channel: { send: vi.fn(async () => undefined) } };
}

describe('!auto start keeps the milestone scope (AGT-3188)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a task source whose fetch passes the configured milestone', async () => {
    setWorkScope({ milestone: 'S4 — Gate Trustworthiness' });
    await handleAuto(makeMessage() as never, ['start']);

    expect(runnerMock.setTaskSource).toHaveBeenCalledTimes(1);
    const source = runnerMock.setTaskSource.mock.calls[0][0] as ITaskSource;
    expect(source.kind).toBe('linear');
    await source.fetchTasks();
    expect(linearMock.getMyIssues).toHaveBeenCalledWith(expect.objectContaining({ milestone: 'S4 — Gate Trustworthiness' }));
  });

  it('reads the scope at fetch time, so a later scope change reaches the registered source', async () => {
    setWorkScope(undefined);
    await handleAuto(makeMessage() as never, ['start']);
    const source = runnerMock.setTaskSource.mock.calls[0][0] as ITaskSource;

    await source.fetchTasks();
    expect(linearMock.getMyIssues.mock.calls[0][0]).toMatchObject({ milestone: undefined });
    setWorkScope({ milestone: 'S5' });
    await source.fetchTasks();
    expect(linearMock.getMyIssues.mock.calls[1][0]).toMatchObject({ milestone: 'S5' });
  });
});
