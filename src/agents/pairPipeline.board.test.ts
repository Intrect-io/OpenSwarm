import { beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { published.events.push(event); }),
}));

const { publishStageToBoard } = await import('./pipelineCoordination.js');

function context(over: Record<string, unknown> = {}) {
  return {
    task: { id: 'task-1', issueId: 'issue-1', issueIdentifier: 'AGT-4008', title: 'Add the clone route' },
    projectPath: '/repo',
    session: { id: 'session-1' },
    currentIteration: 2,
    ...over,
  };
}

describe('stage lifecycle on the coordination board', () => {
  beforeEach(() => { published.events = []; });

  it('records a worker start as a delegation addressed from a named agent', async () => {
    // Board presence used to require an agent to call a coordination tool, so a
    // worker that just did its job never appeared in the orchestration view.
    await publishStageToBoard(context() as never, 'worker', 'running', 'Started on X', 'glm-5.2');

    expect(published.events).toHaveLength(1);
    expect(published.events[0]).toMatchObject({
      kind: 'delegation-request',
      status: 'running',
      actorRole: 'worker',
      taskLabel: 'AGT-4008',
      repository: '/repo',
    });
    expect(published.events[0].actorName).toBeTruthy();
    expect(published.events[0].summary).toContain('worker:');
    expect(published.events[0].metadata).toMatchObject({ model: 'glm-5.2', iteration: 2 });
  });

  it('joins a stage result to its start through one correlation id', async () => {
    await publishStageToBoard(context() as never, 'reviewer', 'running', 'Started');
    await publishStageToBoard(context() as never, 'reviewer', 'completed', 'Finished in 3.0s');

    const [start, end] = published.events;
    expect(start.correlationId).toBe(end.correlationId);
    expect(end).toMatchObject({ kind: 'delegation-result', status: 'completed', actorRole: 'reviewer' });
  });

  it('separates attempts so a retry is its own exchange', async () => {
    await publishStageToBoard(context({ currentIteration: 1 }) as never, 'worker', 'running', 'first');
    await publishStageToBoard(context({ currentIteration: 2 }) as never, 'worker', 'running', 'retry');

    expect(published.events[0].correlationId).not.toBe(published.events[1].correlationId);
  });

  it('persists a stage start before its terminal even when the publishes race', async () => {
    // Both publishes are fire-and-forget and each awaits a dynamic import, so
    // without per-exchange chaining the terminal could persist first — and a
    // consumer deriving state from the newest event would show the finished
    // stage as running forever.
    const { publishCoordination } = await import('../coordination/runCoordination.js');
    const gate: Array<() => void> = [];
    vi.mocked(publishCoordination).mockImplementation(async (event: Record<string, unknown>) => {
      await new Promise<void>((resolve) => gate.push(resolve));
      published.events.push(event);
    });
    try {
      const start = publishStageToBoard(context() as never, 'worker', 'running', 'start');
      const terminal = publishStageToBoard(context() as never, 'worker', 'failed', 'boom');
      // Only the start may be in flight until it lands.
      await vi.waitFor(() => expect(gate.length).toBe(1));
      expect(published.events).toHaveLength(0);
      gate.shift()?.();
      await vi.waitFor(() => expect(gate.length).toBe(1));
      gate.shift()?.();
      await Promise.all([start, terminal]);
      expect(published.events.map((event) => event.status)).toEqual(['running', 'failed']);
    } finally {
      vi.mocked(publishCoordination).mockImplementation(
        async (event: Record<string, unknown>) => { published.events.push(event); },
      );
    }
  });

  it('reports a failed stage as a failed delegation result', async () => {
    await publishStageToBoard(context() as never, 'worker', 'failed', 'Did not pass in 9.0s');
    expect(published.events[0]).toMatchObject({ kind: 'delegation-result', status: 'failed' });
  });

  it('ignores stages that are not agents on the board', async () => {
    for (const stage of ['tester', 'documenter', 'auditor']) {
      await publishStageToBoard(context() as never, stage, 'running', 'noise');
    }
    expect(published.events).toHaveLength(0);
  });
});
