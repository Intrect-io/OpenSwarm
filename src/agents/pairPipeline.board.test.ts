import { beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { published.events.push(event); }),
}));

const { publishStageToBoard, publishStageOutcomeToBoard, registerChosenAgentName, stageCorrelationId } = await import('./pipelineCoordination.js');
const { assignCallSign } = await import('../coordination/agentNames.js');

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
  it('keeps a routable address when the chosen name is entirely non-ASCII', async () => {
    const ctx = context({ task: { id: 'task-kr', issueId: 'i-kr', issueIdentifier: 'AGT-3', title: 'T' } });
    expect(registerChosenAgentName(ctx as never, 'worker', '불꽃대장')).toBe('불꽃대장');
    await publishStageToBoard(ctx as never, 'worker', 'running', 'hi', {});
    const event = published.events.at(-1) as Record<string, unknown>;
    expect(event.actorName).toBe('불꽃대장');
    // Address falls back to the deterministic identity, never an empty string.
    expect(String(event.actor)).toMatch(/^worker-[0-9a-f]{4,}$/);
  });

  it('never lets a chosen name capture a deterministic mailbox', async () => {
    // A worker tries to squat on the reviewer's deterministic fallback address
    // by choosing that exact string as its display name. Agents that have not
    // introduced themselves are invisible to the registry, so the whole
    // `role-hex` namespace is reserved: the squatter is suffixed out of it and
    // the reviewer — here self-naming in a script with no routable form, which
    // routes through the fallback path — keeps its own mailbox.
    const task = { id: 'task-squat', issueId: 'i-squat', issueIdentifier: 'AGT-9', title: 'T' };
    const ctx = context({ task });
    const reviewerFallback = assignCallSign({ repository: '/repo', executionId: task.issueId, role: 'reviewer' });
    expect(registerChosenAgentName(ctx as never, 'worker', reviewerFallback.name)).not.toBe(reviewerFallback.name);
    expect(registerChosenAgentName(ctx as never, 'reviewer', '한글이름')).toBe('한글이름');
    await publishStageToBoard(ctx as never, 'worker', 'running', 'hi', {});
    const workerEvent = published.events.at(-1) as Record<string, unknown>;
    await publishStageToBoard(ctx as never, 'reviewer', 'running', 'hi', {});
    const reviewerEvent = published.events.at(-1) as Record<string, unknown>;
    expect(workerEvent.actor).not.toBe(reviewerFallback.address);
    expect(workerEvent.actor).not.toMatch(/^(?:worker|reviewer|orchestrator|review-agent)-[0-9a-f]{4,}$/);
    expect(reviewerEvent.actor).toBe(reviewerFallback.address);
  });

  it('reserves the 8-hex final-fallback shape too, not just the 4-hex one', async () => {
    // assignCallSign's last resort is `role-` + 8 hex chars; a chosen name of
    // that exact shape must also be suffixed out of the reserved namespace.
    const task = { id: 'task-squat8', issueId: 'i-squat8', issueIdentifier: 'AGT-10', title: 'T' };
    const ctx = context({ task });
    const effective = registerChosenAgentName(ctx as never, 'worker', 'reviewer-a1b2c3d4');
    expect(effective).toBe('reviewer-a1b2c3d4 2');
    await publishStageToBoard(ctx as never, 'worker', 'running', 'hi', {});
    const event = published.events.at(-1) as Record<string, unknown>;
    expect(event.actor).toBe('reviewer-a1b2c3d4-2');
  });

  it('speaks under the name the agent chose for itself', async () => {
    const ctx = context({ task: { id: 'task-name', issueId: 'i-n', issueIdentifier: 'AGT-1', title: 'T' } });
    // Markup and newlines cannot ride into the display name.
    const effective = registerChosenAgentName(ctx as never, 'worker', '  **Nova\nSpark**  ');
    expect(effective).toBe('Nova Spark');
    await publishStageToBoard(ctx as never, 'worker', 'running', 'hello reviewer', { recipientRole: 'reviewer' });
    expect(published.events[0].actorName).toBe('Nova Spark');
  });

  it('publishes the agent\'s own words as the outcome, addressed to its counterpart', async () => {
    const ctx = context({ task: { id: 'task-out', issueId: 'i-o', issueIdentifier: 'AGT-2', title: 'T' } });
    const exchangeId = stageCorrelationId(ctx as never, 'reviewer');
    publishStageOutcomeToBoard(ctx as never, 'reviewer', {
      success: false,
      durationMs: 4_200,
      result: { decision: 'revise', feedback: 'The JOIN guard is missing — add it before resubmitting.', codename: 'Sable' },
    }, exchangeId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const event = published.events.at(-1) as Record<string, unknown>;
    expect(event.summary).toBe('[revise] The JOIN guard is missing — add it before resubmitting.');
    expect(event).toMatchObject({ actorName: 'Sable', recipientRole: 'worker', status: 'failed', correlationId: exchangeId });
  });

  // AGT-4060: the board showed `(no summary)` and bare `Codename: X` lines
  // where the agent's report should be. Both reached it as truthy strings, so
  // the `said || timing-fallback` never fired. Reported by the user watching
  // the live board, not caught by a test.
  describe('a summary that carries no report falls through to the timing fallback (AGT-4060)', () => {
    async function outcomeSummary(summary: string | undefined, success = true): Promise<unknown> {
      const ctx = context({ task: { id: `t-${summary ?? 'none'}`, issueId: `i-${summary ?? 'none'}`, issueIdentifier: 'AGT-60', title: 'T' } });
      publishStageOutcomeToBoard(ctx as never, 'worker', {
        success, durationMs: 3_300, result: { summary },
      }, stageCorrelationId(ctx as never, 'worker'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return (published.events.at(-1) as Record<string, unknown>).summary;
    }

    it("does not publish the adapter's literal `(no summary)` placeholder", async () => {
      expect(await outcomeSummary('(no summary)')).toBe('Finished in 3.3s');
    });

    it('does not publish a summary that is only the agent\'s Codename introduction', async () => {
      // worker.ts strips this line but restores the original when stripping
      // empties it, so a codename-only summary arrives here intact and would
      // otherwise read as the agent reporting its own name as its work.
      expect(await outcomeSummary('Codename: Atlas')).toBe('Finished in 3.3s');
    });

    it('uses the failure wording when a reportless stage failed', async () => {
      expect(await outcomeSummary('(no summary)', false)).toBe('Did not pass in 3.3s');
    });

    it('still publishes a real summary untouched', async () => {
      expect(await outcomeSummary('Added the JOIN guard and a regression test.'))
        .toBe('Added the JOIN guard and a regression test.');
    });

    it('keeps the report when a codename line merely precedes it', async () => {
      expect(await outcomeSummary('Codename: Atlas\nAdded the JOIN guard.')).toBe('Added the JOIN guard.');
    });

    // Caught by the fresh PR review, not self-caught: the adapters emit the
    // ACTIVE locale's placeholder (`t('common.fallback.noSummary')`), so an
    // English-only comparison still published `(요약 없음)` verbatim on a
    // Korean deployment — which is this repo's own default locale.
    it("recognizes the placeholder in whatever locale the adapters emitted it", async () => {
      const { initLocale, t } = await import('../locale/index.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      initLocale('ko');
      try {
        expect(t('common.fallback.noSummary')).toBe('(요약 없음)');
        expect(await outcomeSummary('(요약 없음)')).toBe('Finished in 3.3s');
      } finally {
        initLocale('en');
        log.mockRestore();
      }
    });
  });

  beforeEach(() => { published.events = []; });

  it('records a worker start as a delegation addressed from a named agent', async () => {
    // Board presence used to require an agent to call a coordination tool, so a
    // worker that just did its job never appeared in the orchestration view.
    await publishStageToBoard(context() as never, 'worker', 'running', 'Started on X', { model: 'glm-5.2', recipientRole: 'reviewer' });

    expect(published.events).toHaveLength(1);
    expect(published.events[0]).toMatchObject({
      kind: 'delegation-request',
      status: 'running',
      actorRole: 'worker',
      taskLabel: 'AGT-4008',
      repository: '/repo',
    });
    expect(published.events[0].actorName).toBeTruthy();
    // The agent's own words ARE the summary; speaker fields carry the role.
    expect(published.events[0].summary).toBe('Started on X');
    expect(published.events[0]).toMatchObject({ recipientRole: 'reviewer' });
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
