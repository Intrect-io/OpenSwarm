import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM module served to the browser
import { buildThreads, describeEvent, metadataPairs, taskLabelOf, threadFor } from '../../web/static/js/conversationModel.mjs';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', seq: 1, timestamp: 1_000, repository: '/repo', taskId: 'uuid-1234-5678-9012',
    actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker',
    kind: 'advice-request', status: 'open', correlationId: 'c1', summary: 'question?',
    ...overrides,
  };
}

describe('describeEvent', () => {
  it('names the speaker, the action and the addressee', () => {
    expect(describeEvent(event({
      recipient: 'reviewer-b', recipientName: 'Reviewer B', recipientRole: 'reviewer',
    }))).toBe('Worker A (worker) asked for advice → Reviewer B (reviewer)');
  });

  it('omits the arrow for a broadcast', () => {
    expect(describeEvent(event({ kind: 'review-run', actorRole: 'review-agent' })))
      .toBe('Worker A (review agent) ran a review');
  });

  it('falls back to the raw kind for an unknown event type', () => {
    expect(describeEvent(event({ kind: 'brand-new-kind' }))).toContain('brand-new-kind');
  });
});

describe('taskLabelOf', () => {
  it('prefers the stamped issue identifier', () => {
    expect(taskLabelOf(event({ taskLabel: 'AGT-4001' }))).toBe('AGT-4001');
  });

  it('truncates a bare UUID rather than printing it whole', () => {
    expect(taskLabelOf(event())).toBe('uuid-123…');
  });
});

describe('metadataPairs', () => {
  it('drops empty values and stringifies the rest', () => {
    expect(metadataPairs(event({ metadata: { digest: 'abc', sourceCount: 0, errorCount: null } })))
      .toEqual([['digest', 'abc'], ['sourceCount', '0']]);
  });

  it('returns nothing when there is no metadata', () => {
    expect(metadataPairs(event())).toEqual([]);
  });
});

describe('buildThreads', () => {
  it('groups an exchange and orders it by seq, not timestamp', () => {
    const threads = buildThreads([
      event({ id: 'b', seq: 2, timestamp: 1_000, kind: 'advice-response', actor: 'reviewer-b', actorName: 'Reviewer B', actorRole: 'reviewer', recipient: 'worker-a', status: 'completed', summary: 'answer' }),
      event({ id: 'a', seq: 1, timestamp: 1_000, summary: 'question?' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].events.map((item: { id: string }) => item.id)).toEqual(['a', 'b']);
    expect(threads[0].subject).toBe('question?');
  });

  it('collects every participant on both sides', () => {
    const threads = buildThreads([
      event({ recipient: 'reviewer-b', recipientName: 'Reviewer B', recipientRole: 'reviewer' }),
      event({ id: 'e2', seq: 2, actor: 'orchestrator-x', actorName: 'Orchestrator X', actorRole: 'orchestrator', kind: 'advice-response', status: 'completed' }),
    ]);
    expect(threads[0].participants.map((p: { name: string }) => p.name))
      .toEqual(['Worker A', 'Reviewer B', 'Orchestrator X']);
  });

  it('reports pending from the final state of the exchange', () => {
    const open = buildThreads([event()]);
    expect(open[0].pending).toBe(true);
    const closed = buildThreads([
      event(),
      event({ id: 'e2', seq: 2, kind: 'advice-response', status: 'completed' }),
    ]);
    expect(closed[0].pending).toBe(false);
  });

  it('adopts a task label that only appears later in the thread', () => {
    const threads = buildThreads([
      event({ id: 'e1', seq: 1 }),
      event({ id: 'e2', seq: 2, taskLabel: 'AGT-4001' }),
    ]);
    expect(threads[0].taskLabel).toBe('AGT-4001');
  });

  it('addresses a reply to the last agent speaker, never to the operator', () => {
    const threads = buildThreads([
      event({ id: 'e1', seq: 1, kind: 'human-question', status: 'waiting' }),
      event({ id: 'e2', seq: 2, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human', kind: 'human-answer', status: 'completed' }),
    ]);
    expect(threads[0].replyTo).toEqual({ address: 'worker-a', name: 'Worker A' });
  });

  it('flags a question still awaiting the operator', () => {
    const waiting = buildThreads([event({ kind: 'human-question', status: 'waiting' })]);
    expect(waiting[0].awaitingOperator).toBe(true);
    const answered = buildThreads([
      event({ kind: 'human-question', status: 'waiting' }),
      event({ id: 'e2', seq: 2, kind: 'human-answer', status: 'completed', actorRole: 'human' }),
    ]);
    expect(answered[0].awaitingOperator).toBe(false);
  });

  it('sorts threads with the most recent exchange first', () => {
    const threads = buildThreads([
      event({ id: 'old', seq: 1, correlationId: 'c-old' }),
      event({ id: 'new', seq: 9, correlationId: 'c-new' }),
    ]);
    expect(threads.map((t: { correlationId: string }) => t.correlationId)).toEqual(['c-new', 'c-old']);
  });

  it('keeps an event without a correlation id as its own thread', () => {
    const threads = buildThreads([event({ correlationId: undefined, id: 'lonely' })]);
    expect(threads[0].correlationId).toBe('lonely');
  });
});

describe('threadFor', () => {
  it('finds the conversation containing an event', () => {
    const threads = buildThreads([event(), event({ id: 'e2', seq: 2, correlationId: 'c2' })]);
    expect(threadFor(threads, event())!.correlationId).toBe('c1');
    expect(threadFor(threads, null)).toBeNull();
  });
});
