import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCoordinationThread,
  followCoordinationThread,
  getCoordinationThread,
  listCoordinationThreads,
  markCoordinationThreadRead,
  postCoordinationThreadMessage,
  resolveCoordinationThread,
  unfollowCoordinationThread,
} from './coordinationThreads.js';
import { resetTraceDbForTests } from './coordinationTrace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coordination-threads-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  resetTraceDbForTests();
});

afterEach(() => {
  resetTraceDbForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  rmSync(root, { recursive: true, force: true });
});

function create(overrides: Record<string, unknown> = {}) {
  return createCoordinationThread({
    repository: '/repo',
    subject: 'Who owns the retry contract?',
    actor: 'worker-a',
    actorName: 'Worker A',
    actorRole: 'worker',
    taskId: 'task-a',
    taskLabel: 'AGT-1',
    body: 'I need the scheduler boundary before editing.',
    idempotencyKey: 'open-retry-contract',
    now: 1_000,
    ...overrides,
  });
}

describe('durable coordination threads', () => {
  it('survives a database reopen with participants and messages intact', () => {
    const thread = create({ relatedTaskIds: ['task-b'], relatedFiles: ['src/retry.ts'] });
    followCoordinationThread({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', actorRole: 'reviewer', taskId: 'task-b', now: 1_100,
    });
    postCoordinationThreadMessage({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', actorRole: 'reviewer', taskId: 'task-b',
      body: 'The scheduler owns retry state.', idempotencyKey: 'reply-1', now: 1_200,
    });

    resetTraceDbForTests();
    const reopened = getCoordinationThread({ repository: '/repo', threadId: thread.id });
    expect(reopened.thread).toMatchObject({ status: 'open', messageCount: 2, participantCount: 2 });
    expect(reopened.thread.relatedTaskIds).toEqual(['task-a', 'task-b']);
    expect(listCoordinationThreads({ repository: '/repo', relatedTaskId: 'task-b' }).items)
      .toHaveLength(1);
    expect(listCoordinationThreads({ repository: '/repo', relatedTaskId: 'unrelated' }).items)
      .toHaveLength(0);
    expect(reopened.participants.map((p) => [p.taskId, p.actor])).toEqual([
      ['task-a', 'worker-a'], ['task-b', 'reviewer-b'],
    ]);
    expect(reopened.messages.items.map((m) => m.body)).toEqual([
      'I need the scheduler boundary before editing.',
      'The scheduler owns retry state.',
    ]);
  });

  it('deduplicates retries and rejects an idempotency collision', () => {
    const first = create();
    expect(create().id).toBe(first.id);
    expect(() => create({ subject: 'A different topic' })).toThrow('Thread idempotency key collision');

    const message = postCoordinationThreadMessage({
      repository: '/repo', threadId: first.id, actor: 'reviewer-b', taskId: 'task-b',
      body: 'Use the existing helper.', idempotencyKey: 'reply', now: 1_100,
    });
    expect(postCoordinationThreadMessage({
      repository: '/repo', threadId: first.id, actor: 'reviewer-b', taskId: 'task-b',
      body: 'Use the existing helper.', idempotencyKey: 'reply', now: 9_999,
    }).id).toBe(message.id);
    expect(() => postCoordinationThreadMessage({
      repository: '/repo', threadId: first.id, actor: 'reviewer-b', taskId: 'task-b',
      body: 'Changed answer.', idempotencyKey: 'reply', now: 2_000,
    })).toThrow('Thread message idempotency key collision');
  });

  it('isolates repositories even when a thread id is known', () => {
    const thread = create();
    expect(() => getCoordinationThread({ repository: '/other', threadId: thread.id })).toThrow('not found');
    expect(() => postCoordinationThreadMessage({
      repository: '/other', threadId: thread.id, actor: 'intruder', taskId: 'task-x', body: 'cross repo',
    })).toThrow('not found');
  });

  it('resolves with compare-and-swap and refuses posts afterwards', () => {
    const thread = create();
    followCoordinationThread({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', now: 1_100,
    });
    const followed = getCoordinationThread({ repository: '/repo', threadId: thread.id }).thread;
    expect(() => resolveCoordinationThread({
      repository: '/repo', threadId: thread.id, expectedVersion: followed.version - 1,
      actor: 'reviewer-b', taskId: 'task-b',
    })).toThrow('version conflict');
    const resolved = resolveCoordinationThread({
      repository: '/repo', threadId: thread.id, expectedVersion: followed.version,
      actor: 'reviewer-b', taskId: 'task-b', now: 2_000,
    });
    expect(resolved).toMatchObject({
      status: 'resolved', version: followed.version + 1, resolvedAt: 2_000,
      resolvedByActor: 'reviewer-b', resolvedByTaskId: 'task-b',
    });
    expect(() => postCoordinationThreadMessage({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', body: 'too late',
    })).toThrow('resolved');
    expect(resolveCoordinationThread({
      repository: '/repo', threadId: thread.id, expectedVersion: 0,
      actor: 'reviewer-b', taskId: 'task-b',
    }).status).toBe('resolved');
  });

  it('refuses resolution by an unrelated repository agent', () => {
    const thread = create();
    expect(() => resolveCoordinationThread({
      repository: '/repo', threadId: thread.id, expectedVersion: thread.version,
      actor: 'worker-c', taskId: 'task-c', now: 2_000,
    })).toThrow('Only a thread participant');
    expect(getCoordinationThread({ repository: '/repo', threadId: thread.id }).thread.status).toBe('open');
  });

  it('tracks subscriptions and unread messages without changing thread history', () => {
    const thread = create();
    followCoordinationThread({ repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', now: 1_100 });
    postCoordinationThreadMessage({
      repository: '/repo', threadId: thread.id, actor: 'worker-a', taskId: 'task-a', body: 'new evidence', now: 1_200,
    });
    expect(listCoordinationThreads({
      repository: '/repo', participant: { actor: 'reviewer-b', taskId: 'task-b' },
    }).items[0].unreadCount).toBe(1);
    markCoordinationThreadRead({ repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b' });
    expect(listCoordinationThreads({
      repository: '/repo', participant: { actor: 'reviewer-b', taskId: 'task-b' },
    }).items[0].unreadCount).toBe(0);
    expect(unfollowCoordinationThread({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', now: 1_300,
    })).toBe(true);
    expect(() => unfollowCoordinationThread({
      repository: '/repo', threadId: thread.id, actor: 'worker-a', taskId: 'task-a', now: 1_400,
    })).toThrow('creator cannot unfollow');
  });

  it('marks only the returned message page as read', () => {
    const thread = create();
    followCoordinationThread({ repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', now: 1_100 });
    for (let index = 0; index < 3; index += 1) {
      postCoordinationThreadMessage({
        repository: '/repo', threadId: thread.id, actor: 'worker-a', taskId: 'task-a',
        body: `evidence ${index}`, now: 1_200 + index,
      });
    }
    const lastReadSeq = getCoordinationThread({ repository: '/repo', threadId: thread.id })
      .participants.find((participant) => participant.actor === 'reviewer-b')!.lastReadSeq;
    const page = getCoordinationThread({
      repository: '/repo', threadId: thread.id, messageLimit: 1, messageAfterSeq: lastReadSeq,
    });
    const throughSeq = page.messages.items[0].seq;
    markCoordinationThreadRead({
      repository: '/repo', threadId: thread.id, actor: 'reviewer-b', taskId: 'task-b', throughSeq,
    });
    expect(listCoordinationThreads({
      repository: '/repo', participant: { actor: 'reviewer-b', taskId: 'task-b' },
    }).items[0].unreadCount).toBe(2);
  });

  it('paginates topics and messages with stable cursors', () => {
    const oldest = create({ idempotencyKey: 'old', subject: 'Old', body: undefined, now: 1_000 });
    create({ idempotencyKey: 'middle', subject: 'Middle', body: undefined, now: 2_000 });
    create({ idempotencyKey: 'new', subject: 'New', body: undefined, now: 3_000 });
    const first = listCoordinationThreads({ repository: '/repo', limit: 2 });
    expect(first.items.map((t) => t.subject)).toEqual(['New', 'Middle']);
    expect(first.nextCursor).toBeTruthy();
    expect(listCoordinationThreads({ repository: '/repo', limit: 2, cursor: first.nextCursor }).items.map((t) => t.subject))
      .toEqual(['Old']);

    for (let i = 0; i < 3; i++) {
      postCoordinationThreadMessage({
        repository: '/repo', threadId: oldest.id, actor: 'worker-a', taskId: 'task-a',
        body: `message ${i}`, now: 4_000 + i,
      });
    }
    const page = getCoordinationThread({ repository: '/repo', threadId: oldest.id, messageLimit: 2 });
    expect(page.messages.items.map((m) => m.body)).toEqual(['message 0', 'message 1']);
    expect(page.messages.nextCursor).toBeTruthy();
    expect(getCoordinationThread({
      repository: '/repo', threadId: oldest.id, messageLimit: 2,
      messageAfterSeq: Number(page.messages.nextCursor),
    }).messages.items.map((m) => m.body)).toEqual(['message 2']);
  });

  it('redacts credential-looking values and rejects unsafe related paths', () => {
    const thread = create({
      subject: 'Use ghp_abcdefghijk for auth',
      body: 'Bearer abcdefghijk',
      relatedFiles: ['src/a.ts'],
    });
    const detail = getCoordinationThread({ repository: '/repo', threadId: thread.id });
    expect(detail.thread.subject).toContain('[redacted]');
    expect(detail.messages.items[0].body).toBe('[redacted]');
    expect(() => create({ idempotencyKey: 'escape', relatedFiles: ['../secret'] })).toThrow('repository-relative');
    expect(() => create({ idempotencyKey: 'drive', relatedFiles: ['C:\\secret.txt'] })).toThrow('repository-relative');
  });
});
