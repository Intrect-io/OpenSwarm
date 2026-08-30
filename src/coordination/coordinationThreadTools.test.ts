import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATION_THREAD_TOOL_DEFINITIONS,
  COORDINATION_THREAD_TOOL_NAMES,
  executeCoordinationThreadTool,
  type CoordinationThreadToolContext,
} from './coordinationThreadTools.js';
import { resetTraceDbForTests } from './coordinationTrace.js';

let root: string;
const worker: CoordinationThreadToolContext = {
  repository: '/repo', taskId: 'task-a', taskLabel: 'AGT-1', actor: 'worker-a', actorRole: 'worker',
};
const reviewer: CoordinationThreadToolContext = {
  repository: '/repo', taskId: 'task-b', taskLabel: 'AGT-2', actor: 'reviewer-b', actorRole: 'reviewer',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coordination-thread-tools-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  resetTraceDbForTests();
});

afterEach(() => {
  resetTraceDbForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  rmSync(root, { recursive: true, force: true });
});

async function execute(name: string, args: Record<string, unknown>, context = worker) {
  return executeCoordinationThreadTool(name, args, context);
}

function parsed(result: Awaited<ReturnType<typeof execute>>) {
  return JSON.parse(result.content) as Record<string, any>;
}

describe('coordination thread tools', () => {
  it('keeps declared names and the dispatcher in lockstep', async () => {
    expect([...COORDINATION_THREAD_TOOL_NAMES].sort()).toEqual(
      COORDINATION_THREAD_TOOL_DEFINITIONS.map((definition) => definition.function.name).sort(),
    );
    for (const definition of COORDINATION_THREAD_TOOL_DEFINITIONS) {
      const result = await execute(definition.function.name, {});
      expect(result.content).not.toContain('Unknown coordination thread tool');
    }
  });

  it('creates one cross-task topic and scopes default discovery to related tasks', async () => {
    const made = await execute('coordination_thread_create', {
      subject: 'Retry ownership', body: 'Who owns the retry state?',
      related_task_ids: ['task-b'], related_files: ['src/retry.ts'], idempotency_key: 'retry-owner',
      repository: '/spoofed', actor: 'spoofed',
    });
    expect(made.isError).toBe(false);
    const thread = parsed(made).thread;
    expect(thread).toMatchObject({ repository: '/repo', createdByActor: 'worker-a' });

    const related = parsed(await execute('coordination_thread_list', {}, reviewer));
    expect(related.items.map((item: { id: string }) => item.id)).toEqual([thread.id]);
    const unrelatedContext = { ...reviewer, taskId: 'task-c', actor: 'reviewer-c' };
    expect(parsed(await execute('coordination_thread_list', {}, unrelatedContext)).items).toHaveLength(0);
    expect(parsed(await execute('coordination_thread_list', { scope: 'repository' }, unrelatedContext)).items)
      .toHaveLength(1);
  });

  it('follows, replies idempotently, reports unread state, and resolves by version', async () => {
    const made = parsed(await execute('coordination_thread_create', {
      subject: 'Integration order', body: 'Foundation first.', related_task_ids: ['task-b'], idempotency_key: 'order',
    }));
    const threadId = made.thread.id as string;
    expect((await execute('coordination_thread_follow', { thread_id: threadId, following: true }, reviewer)).isError)
      .toBe(false);

    const replyArgs = { thread_id: threadId, body: 'Reviewer agrees.', idempotency_key: 'agree' };
    const first = parsed(await execute('coordination_thread_reply', replyArgs, reviewer));
    const retry = parsed(await execute('coordination_thread_reply', replyArgs, reviewer));
    expect(retry.message.id).toBe(first.message.id);

    await execute('coordination_thread_reply', {
      thread_id: threadId, body: 'I will integrate it.', idempotency_key: 'integrate',
    });
    expect(parsed(await execute('coordination_thread_list', { scope: 'following' }, reviewer)).items[0].unreadCount)
      .toBe(1);

    const read = await execute('coordination_thread_get', { thread_id: threadId, mark_read: true }, reviewer);
    expect(read.isError).toBe(false);
    expect(parsed(await execute('coordination_thread_list', { scope: 'following' }, reviewer)).items[0].unreadCount)
      .toBe(0);

    const version = parsed(read).thread.version as number;
    const resolved = await execute('coordination_thread_resolve', {
      thread_id: threadId, expected_version: version,
    }, reviewer);
    expect(parsed(resolved).thread).toMatchObject({
      status: 'resolved', resolvedByActor: 'reviewer-b', resolvedByTaskId: 'task-b',
    });
  });

  it('returns validation and repository isolation failures as tool errors', async () => {
    expect((await execute('coordination_thread_create', { subject: 'missing key' })).isError).toBe(true);
    const made = parsed(await execute('coordination_thread_create', {
      subject: 'Private to repo', idempotency_key: 'private',
    }));
    expect((await execute('coordination_thread_get', { thread_id: made.thread.id }, {
      ...reviewer, repository: '/other',
    })).isError).toBe(true);
  });
});
