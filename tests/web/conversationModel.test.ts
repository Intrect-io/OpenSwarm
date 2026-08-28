import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM module served to the browser
import { buildChatLines, buildThreads, chatLineOf, isUtterance, latestAddressable, metadataPairs, taskLabelOf, threadFor } from '../../web/static/js/conversationModel.mjs';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', seq: 1, timestamp: 1_000, repository: '/repo', taskId: 'uuid-1234-5678-9012',
    actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker',
    kind: 'advice-request', status: 'open', correlationId: 'c1', summary: 'question?',
    ...overrides,
  };
}

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

describe('chatLineOf', () => {
  it('prefers the full words in detail over the clipped summary', () => {
    const line = chatLineOf(event({ summary: 'clipped...', detail: 'the whole argument, verbatim' }));
    expect(line.text).toBe('the whole argument, verbatim');
  });

  it('falls back to the summary when there is no long form', () => {
    expect(chatLineOf(event()).text).toBe('question?');
  });

  it('names the speaker with role label and leaves the recipient nullable', () => {
    const line = chatLineOf(event({ actorRole: 'review-agent', taskLabel: 'AGT-4019' }));
    expect(line).toMatchObject({
      speakerName: 'Worker A', role: 'review-agent', speakerRole: 'review agent',
      recipientName: null, taskLabel: 'AGT-4019', status: 'open',
    });
  });

  it('resolves the recipient name and flags operator speech', () => {
    const line = chatLineOf(event({
      actorRole: 'human', recipient: 'worker-a', recipientName: 'Worker A', recipientRole: 'worker',
    }));
    expect(line.recipientName).toBe('Worker A');
    expect(line.isOperator).toBe(true);
  });
});

describe('buildChatLines', () => {
  it('hides instruction snapshots — plumbing, not speech', () => {
    const lines = buildChatLines([
      event({ id: 's', kind: 'instruction-snapshot' }),
      event({ id: 'u', seq: 2, summary: 'actual words' }),
    ]);
    expect(lines.map((line: { id: string }) => line.id)).toEqual(['u']);
    expect(isUtterance(event({ kind: 'instruction-snapshot' }))).toBe(false);
  });

  it('orders the room chronologically by seq across tasks', () => {
    const lines = buildChatLines([
      event({ id: 'later', seq: 5, taskId: 't2', correlationId: 'c2' }),
      event({ id: 'first', seq: 1 }),
    ]);
    expect(lines.map((line: { id: string }) => line.id)).toEqual(['first', 'later']);
  });
});

describe('latestAddressable', () => {
  it('returns the newest agent speaker, skipping the operator', () => {
    const target = latestAddressable([
      event({ id: 'a', seq: 1 }),
      event({ id: 'op', seq: 2, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human' }),
    ]);
    expect(target.id).toBe('a');
  });

  it('never addresses the daemon through its instruction snapshot', () => {
    const target = latestAddressable([
      event({ id: 'a', seq: 1 }),
      event({ id: 'snap', seq: 2, actor: 'daemon', actorRole: 'daemon', kind: 'instruction-snapshot' }),
    ]);
    expect(target.id).toBe('a');
  });

  it('returns null when nobody can be addressed', () => {
    expect(latestAddressable([
      event({ actor: 'operator-dashboard', actorRole: 'human' }),
    ])).toBeNull();
  });
});
