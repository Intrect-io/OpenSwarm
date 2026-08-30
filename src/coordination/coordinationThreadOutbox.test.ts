import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCoordinationThread,
  followCoordinationThread,
  getCoordinationThread,
  postCoordinationThreadMessage,
} from './coordinationThreads.js';
import { drainCoordinationThreadOutbox } from './coordinationThreadOutbox.js';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { resetTraceDbForTests } from './coordinationTrace.js';

const originalAutomationDb = process.env.OPENSWARM_AUTOMATION_DB;
const originalCoordinationFile = process.env.OPENSWARM_COORDINATION_FILE;
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coordination-thread-outbox-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
});

afterEach(() => {
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  process.env.OPENSWARM_AUTOMATION_DB = originalAutomationDb;
  process.env.OPENSWARM_COORDINATION_FILE = originalCoordinationFile;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('coordination thread notification outbox', () => {
  it('replays only the failed subscriber copy after restart without duplicating delivery', async () => {
    const notification = { repository: '/repo', repoKey: 'git:repo' };
    const thread = createCoordinationThread({
      repository: 'git:repo',
      subject: 'Integration ownership',
      actor: 'worker-a',
      actorRole: 'worker',
      taskId: 'task-a',
      body: 'I own src/retry.ts.',
      idempotencyKey: 'ownership',
      notification,
      now: 1_000,
    });
    followCoordinationThread({
      repository: 'git:repo', threadId: thread.id,
      actor: 'reviewer-b', actorRole: 'reviewer', taskId: 'task-b', now: 1_100,
    });
    followCoordinationThread({
      repository: 'git:repo', threadId: thread.id,
      actor: 'worker-c', actorRole: 'worker', taskId: 'task-c', now: 1_200,
    });
    const message = postCoordinationThreadMessage({
      repository: 'git:repo', threadId: thread.id,
      actor: 'worker-a', actorRole: 'worker', taskId: 'task-a',
      body: 'The ownership split is ready for both subscribers.',
      idempotencyKey: 'split-ready', notification, now: 1_300,
    });
    const mutationId = `message:${message.id}`;
    const store = getCoordinationStore();

    const partial = await drainCoordinationThreadOutbox({
      mutationId,
      deliver: async (event) => {
        if (event.recipient === 'worker-c') throw new Error('simulated board outage');
        return store.publish(event);
      },
    });
    expect(partial).toMatchObject({ delivered: 1, pending: 1 });
    expect(partial.warnings).toHaveLength(1);
    expect(getCoordinationThread({ repository: 'git:repo', threadId: thread.id }).thread.messageCount).toBe(2);

    // Reopen both durable stores as a daemon restart would. The delivered copy
    // remains acknowledged; only worker-c is pending.
    resetTraceDbForTests();
    resetCoordinationStoreForTests();
    const resumed = await drainCoordinationThreadOutbox({ mutationId });
    expect(resumed).toEqual({ delivered: 1, pending: 0, warnings: [] });
    expect(await drainCoordinationThreadOutbox({ mutationId }))
      .toEqual({ delivered: 0, pending: 0, warnings: [] });

    const delivered = getCoordinationStore().list({ repoKey: 'git:repo', limit: 100 })
      .filter((event) => event.metadata?.mutationId === mutationId);
    expect(delivered.map((event) => event.recipient).sort()).toEqual(['reviewer-b', 'worker-c']);
    expect(new Set(delivered.map((event) => event.id)).size).toBe(2);
  });
});
