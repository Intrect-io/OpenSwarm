import { describe, expect, it, vi } from 'vitest';
import type { ITaskSource } from '../automation/taskSource.js';
import { TrackerCoordinationBoard, formatCoordinationComment, parseCoordinationComment } from './linearBoard.js';

const event = {
  id: 'e1', seq: 1, timestamp: 5, repository: '/repo', taskId: 't1', actor: 'worker-a', recipient: 'worker-b',
  kind: 'delegation-request' as const, status: 'open' as const, correlationId: 'c1', summary: 'Please verify auth',
  fingerprint: 'f'.repeat(64),
};

describe('TrackerCoordinationBoard', () => {
  it('round-trips the durable marker while keeping a readable comment', () => {
    const body = formatCoordinationComment(event);
    expect(body).toContain('Agent board');
    expect(parseCoordinationComment(body)).toEqual(event);
  });

  it('carries call signs across a host, not just routing addresses', () => {
    // A board comment is how a second host learns what happened. Dropping the
    // names leaves the operator reading mailbox slugs for agents they know by
    // call sign.
    const named = { ...event, actorName: 'Magos Corvax-Vigilis', recipientName: 'Adept Ferrus-Umbra' };
    const body = formatCoordinationComment(named);
    expect(body).toContain('Magos Corvax-Vigilis → Adept Ferrus-Umbra');
    expect(parseCoordinationComment(body)).toEqual(named);
  });

  it('preserves repository-cell and cross-task routing fields', () => {
    const routed = {
      ...event,
      repoKey: 'git:shared', taskLabel: 'AGT-A',
      sourceTaskId: 'task-a', sourceTaskLabel: 'AGT-A',
      targetTaskId: 'task-b', targetTaskLabel: 'AGT-B',
      actorRole: 'worker', recipientRole: 'reviewer',
    };
    expect(parseCoordinationComment(formatCoordinationComment(routed))).toEqual(routed);
  });

  it('publishes idempotently and reads only board messages', async () => {
    const addComment = vi.fn(async () => {});
    const source = {
      addComment,
      getExecutionComments: vi.fn(async () => [
        { body: 'ordinary project comment', createdAt: '2026-01-01' },
        { body: formatCoordinationComment(event), createdAt: '2026-01-02' },
      ]),
    } as unknown as ITaskSource;
    const board = new TrackerCoordinationBoard(source, 'BOARD-1');
    await board.publish(event);
    expect(addComment).toHaveBeenCalledWith('BOARD-1', expect.stringContaining('Agent board'), `coordination:${event.fingerprint}`);
    expect(await board.read()).toEqual([event]);
  });

  it('stops retrying after Linear reports its immutable comment quota', async () => {
    const addComment = vi.fn(async () => { throw new Error('Quota exceeded - An issue can have a maximum of 2000 comments.'); });
    const board = new TrackerCoordinationBoard({ addComment } as unknown as ITaskSource, 'BOARD-1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await board.publish(event);
    await board.publish({ ...event, id: 'e2', fingerprint: 'a'.repeat(64) });
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
