import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM module served to the browser
import { buildChatLines, buildChatThreads, buildThreads, chatLineOf, isAgentMessage, isSystemEvent, isUtterance, latestAddressable, metadataPairs, openQuestionFor, taskLabelOf, threadFor } from '../../web/static/js/conversationModel.mjs';

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
  it('groups events by correlationId', () => {
    const threads = buildThreads([
      event({ correlationId: 'c1', seq: 1 }),
      event({ correlationId: 'c2', seq: 2 }),
      event({ correlationId: 'c1', seq: 3 }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].events).toHaveLength(2); // c1
    expect(threads[1].events).toHaveLength(1); // c2
  });

  it('orders threads by newest first', () => {
    const threads = buildThreads([
      event({ correlationId: 'c1', seq: 10 }),
      event({ correlationId: 'c2', seq: 20 }),
    ]);
    expect(threads[0].events[0].seq).toBe(20); // c2 first
  });
});

describe('buildChatThreads', () => {
  it('includes only threads with at least one utterance', () => {
    const threads = buildChatThreads([
      event({ kind: 'system', seq: 1 }), // no utterance
      event({ kind: 'utterance', seq: 2 }), // has utterance
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].events[0].seq).toBe(2);
  });
});

describe('threadFor', () => {
  it('finds the thread with the given correlationId', () => {
    const threads = buildThreads([
      event({ correlationId: 'c1', seq: 1 }),
      event({ correlationId: 'c2', seq: 2 }),
    ]);
    const thread = threadFor(threads, 'c2');
    expect(thread?.events[0].seq).toBe(2);
  });

  it('returns null when no thread matches', () => {
    const threads = buildThreads([event({ correlationId: 'c1' })]);
    expect(threadFor(threads, 'c3')).toBeNull();
  });
});

describe('chatLineOf', () => {
  it('returns a line object with text and sender', () => {
    const line = chatLineOf(event({ summary: 'Hello', actorName: 'Alice' }));
    expect(line.text).toBe('Hello');
    expect(line.sender).toBe('Alice');
  });
});

describe('isUtterance', () => {
  it('returns true for utterance kind', () => {
    expect(isUtterance(event({ kind: 'utterance' }))).toBe(true);
  });

  it('returns false for non-utterance kind', () => {
    expect(isUtterance(event({ kind: 'system' }))).toBe(false);
  });
});

describe('isSystemEvent', () => {
  it('returns true for system kind', () => {
    expect(isSystemEvent(event({ kind: 'system' }))).toBe(true);
  });

  it('returns false for non-system kind', () => {
    expect(isSystemEvent(event({ kind: 'utterance' }))).toBe(false);
  });
});

describe('isAgentMessage', () => {
  it('returns true for utterance, advice-request, advice-response', () => {
    expect(isAgentMessage(event({ kind: 'utterance' }))).toBe(true);
    expect(isAgentMessage(event({ kind: 'advice-request' }))).toBe(true);
    expect(isAgentMessage(event({ kind: 'advice-response' }))).toBe(true);
  });

  it('returns false for system and other kinds', () => {
    expect(isAgentMessage(event({ kind: 'system' }))).toBe(false);
    expect(isAgentMessage(event({ kind: 'mcp-audit' }))).toBe(false);
  });
});

describe('latestAddressable', () => {
  it('returns the most recent non-human, non-daemon agent message', () => {
    const events = [
      event({ actorRole: 'human', seq: 1 }),
      event({ actorRole: 'daemon', seq: 2 }),
      event({ actorRole: 'worker', seq: 3 }),
      event({ actorRole: 'reviewer', seq: 4 }),
    ];
    const result = latestAddressable(events);
    expect(result).toEqual(expect.objectContaining({ seq: 4 }));
  });

  it('skips trailing adapter-route and mcp-audit events', () => {
    const events = [
      event({ actorRole: 'worker', seq: 1 }),
      event({ actorRole: 'daemon', kind: 'adapter-route', seq: 2 }),
      event({ actorRole: 'daemon', kind: 'mcp-audit', seq: 3 }),
    ];
    const result = latestAddressable(events);
    expect(result).toEqual(expect.objectContaining({ seq: 1 }));
  });

  it('still addresses a trailing review-run event', () => {
    const events = [
      event({ actorRole: 'worker', seq: 1 }),
      event({ actorRole: 'review-agent', seq: 2 }),
    ];
    const result = latestAddressable(events);
    expect(result).toEqual(expect.objectContaining({ seq: 2 }));
  });

  it('returns null if no addressable message exists', () => {
    const events = [
      event({ actorRole: 'human', seq: 1 }),
      event({ actorRole: 'daemon', seq: 2 }),
    ];
    const result = latestAddressable(events);
    expect(result).toBeNull();
  });
});

describe('openQuestionFor', () => {
  it('finds the newest open advice-request for the given actor', () => {
    const events = [
      event({ kind: 'advice-request', status: 'open', actor: 'worker-a', seq: 1 }),
      event({ kind: 'advice-request', status: 'open', actor: 'worker-b', seq: 2 }),
    ];
    const result = openQuestionFor(events, 'worker-b', { taskId: 'uuid-1234-5678-9012' });
    expect(result).toEqual(expect.objectContaining({ seq: 2 }));
  });

  it('ignores closed/expired/failed questions', () => {
    const events = [
      event({ kind: 'advice-request', status: 'completed', actor: 'worker-a', seq: 1 }),
      event({ kind: 'advice-request', status: 'expired', actor: 'worker-a', seq: 2 }),
      event({ kind: 'advice-request', status: 'failed', actor: 'worker-a', seq: 3 }),
      event({ kind: 'advice-request', status: 'open', actor: 'worker-a', seq: 4 }),
    ];
    const result = openQuestionFor(events, 'worker-a', { taskId: 'uuid-1234-5678-9012' });
    expect(result).toEqual(expect.objectContaining({ seq: 4 }));
  });

  it('respects task and repository scope', () => {
    const events = [
      event({ kind: 'advice-request', status: 'open', actor: 'worker-a', seq: 1, taskId: 'task-1', repository: '/repo1' }),
      event({ kind: 'advice-request', status: 'open', actor: 'worker-a', seq: 2, taskId: 'task-2', repository: '/repo2' }),
    ];
    const scope = { taskId: 'task-1', repository: '/repo1' };
    const result = openQuestionFor(events, 'worker-a', scope);
    expect(result).toEqual(expect.objectContaining({ seq: 1 }));
  });

  it('returns null when no open question exists for the actor', () => {
    const events = [event({ kind: 'advice-request', status: 'open', actor: 'worker-a', seq: 1 })];
    const result = openQuestionFor(events, 'worker-b', { taskId: 'uuid-1234-5678-9012' });
    expect(result).toBeNull();
  });
});
