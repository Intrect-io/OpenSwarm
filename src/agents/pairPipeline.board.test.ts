import { beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { published.events.push(event); }),
}));

const { publishStageToBoard, publishStageOutcomeToBoard, assignedAgentName, stageCorrelationId } = await import('./pipelineCoordination.js');

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
    // The name is assigned, not taken from the model's `codename` — that field
    // no longer decides identity (AGT-4064).
    expect(event).toMatchObject({ recipientRole: 'worker', status: 'failed', correlationId: exchangeId });
    expect(event.actorName).toBe(assignedAgentName(ctx as never, 'reviewer'));
    expect(event.actorName).not.toBe('Sable');
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
        expect(await outcomeSummary('(요약 없음)')).toBe('3.3초 만에 완료');
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

// The operator saw `Atlas 3 2 (worker · AX-1030) → reviewer-b0bc` and banned
// both shapes: self-chosen names that collect collision counters, and the
// machine-ID fallback. (AGT-4064)
describe('agents publish under an assigned handle', () => {
  const MACHINE_ID = /^(?:worker|reviewer|orchestrator|review-agent)-[0-9a-f]{4,}$/;

  it('ignores the codename the model reports for itself', async () => {
    const ctx = context({ task: { id: 't-cn', issueId: 'i-cn', issueIdentifier: 'AGT-64', title: 'T' } });
    publishStageOutcomeToBoard(ctx as never, 'worker', {
      success: true, durationMs: 1_000, result: { codename: 'Atlas 3', summary: 'did the thing' },
    }, stageCorrelationId(ctx as never, 'worker'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const event = published.events.at(-1) as Record<string, unknown>;
    expect(event.actorName).not.toBe('Atlas 3');
    expect(event.actorName).toBe(assignedAgentName(ctx as never, 'worker'));
  });

  it('never addresses a counterpart by a machine id', async () => {
    const ctx = context({ task: { id: 't-addr', issueId: 'i-addr', issueIdentifier: 'AGT-65', title: 'T' } });
    await publishStageToBoard(ctx as never, 'worker', 'running', 'start', { recipientRole: 'reviewer' });
    const event = published.events.at(-1) as Record<string, unknown>;
    expect(String(event.actor)).not.toMatch(MACHINE_ID);
    expect(String(event.recipient)).not.toMatch(MACHINE_ID);
    expect(String(event.recipientName)).not.toMatch(MACHINE_ID);
  });

  it('keeps one handle for the whole run', () => {
    const ctx = context({ task: { id: 't-stable', issueId: 'i-stable', issueIdentifier: 'AGT-66', title: 'T' } });
    expect(assignedAgentName(ctx as never, 'worker')).toBe(assignedAgentName(ctx as never, 'worker'));
  });

  it('keeps coordination identity stable across sibling worktree paths in one repository cell', async () => {
    const { coordinationContextFor } = await import('./pipelineCoordination.js');
    const metadata = { repoKey: 'git:shared', coordinationRepository: '/repo/main' };
    const first = context({ projectPath: '/repo/worktree/a', config: { runMetadata: metadata } });
    const second = context({ projectPath: '/repo/worktree/b', config: { runMetadata: metadata } });
    expect(coordinationContextFor(first as never, 'worker')).toMatchObject({
      repository: '/repo/main', repoKey: 'git:shared',
      actor: coordinationContextFor(second as never, 'worker').actor,
    });
  });

  it('gives the worker and the reviewer different handles', () => {
    const ctx = context({ task: { id: 't-pair', issueId: 'i-pair', issueIdentifier: 'AGT-67', title: 'T' } });
    expect(assignedAgentName(ctx as never, 'worker')).not.toBe(assignedAgentName(ctx as never, 'reviewer'));
  });
});

// A reply is addressed to a handle, so a restart must not rename a live
// participant. The first version of assignment probed against this module's
// in-memory registry, so a handle depended on which other tasks that process
// had already seen — and a restart, knowing fewer of them, resolved a
// collision differently. (AGT-4064, caught by the PR review)
describe('a handle does not depend on what the process has already seen', () => {
  function ctxFor(n: number) {
    return context({ task: { id: `t-${n}`, issueId: `i-${n}`, issueIdentifier: `AX-${n}`, title: 'T' } });
  }

  it('resolves a COLLIDING task the same in a busy process and in a fresh one', async () => {
    const { assignCallSign } = await import('../coordination/agentNames.js');
    // Registry-based probing only diverges where two identities actually want
    // the same handle, so find a real collision rather than hoping for one.
    const byAddress = new Map<string, number>();
    let earlier = -1;
    let later = -1;
    for (let n = 0; n < 4_000 && later < 0; n += 1) {
      const address = assignCallSign({
        repository: '/repo', executionId: `i-${n}`, role: 'worker',
      }).address;
      const seen = byAddress.get(address);
      if (seen !== undefined) { earlier = seen; later = n; } else { byAddress.set(address, n); }
    }
    expect(later).toBeGreaterThan(-1); // a collision must exist for this to test anything

    // A daemon that saw the earlier task first, then the later one.
    const busy = await import('./pipelineCoordination.js');
    busy.assignedAgentName(ctxFor(earlier) as never, 'worker');
    const busyLater = busy.assignedAgentName(ctxFor(later) as never, 'worker');

    // Restart: only the later task is still in flight.
    vi.resetModules();
    const fresh = await import('./pipelineCoordination.js');
    expect(fresh.assignedAgentName(ctxFor(later) as never, 'worker')).toBe(busyLater);
  });
});
