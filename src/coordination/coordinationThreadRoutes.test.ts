import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryHandleCoordinationThreadRoutes } from './coordinationThreadRoutes.js';
import { resetTraceDbForTests } from './coordinationTrace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coordination-thread-routes-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  resetTraceDbForTests();
});

afterEach(() => {
  resetTraceDbForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  let status = 0;
  let payload = '';
  const parsed = new URL(`http://localhost${path}`);
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { payload = value; },
  } as unknown as ServerResponse;
  const handled = await tryHandleCoordinationThreadRoutes(
    { method } as IncomingMessage,
    response,
    parsed.pathname,
    parsed,
    async () => JSON.stringify(body ?? {}),
  );
  return { handled, status, body: payload ? JSON.parse(payload) : undefined };
}

describe('durable coordination thread HTTP API', () => {
  it('creates, lists, discusses, follows, reads, and resolves one repository thread', async () => {
    const created = await call('POST', '/api/coordination/threads', {
      repository: '/repo', taskId: 'task-a', taskLabel: 'AGT-1', subject: 'Merge order',
      body: 'Foundation first.', relatedTaskIds: ['task-b'], relatedFiles: ['src/retry.ts'],
      idempotencyKey: 'merge-order',
    });
    expect(created).toMatchObject({ handled: true, status: 201 });
    const threadId = created.body.thread.id as string;

    const related = await call('GET', '/api/coordination/threads?repository=%2Frepo&taskId=task-b');
    expect(related.body.items.map((thread: { id: string }) => thread.id)).toEqual([threadId]);
    expect((await call('GET', '/api/coordination/threads?repository=%2Fother')).body.items).toHaveLength(0);

    expect((await call('POST', `/api/coordination/threads/${threadId}/follow`, {
      repository: '/repo',
    })).body.following).toBe(true);
    const reply = await call('POST', `/api/coordination/threads/${threadId}/messages`, {
      repository: '/repo', body: 'Operator approves foundation-first.', idempotencyKey: 'operator-approval',
    });
    expect(reply.status).toBe(201);

    const detail = await call('GET', `/api/coordination/threads/${threadId}?repository=%2Frepo`);
    expect(detail.body.messages.items.map((message: { body: string }) => message.body)).toEqual([
      'Foundation first.', 'Operator approves foundation-first.',
    ]);
    expect((await call('POST', `/api/coordination/threads/${threadId}/read`, {
      repository: '/repo',
    })).body.lastReadSeq).toBeGreaterThan(0);

    const resolved = await call('POST', `/api/coordination/threads/${threadId}/resolve`, {
      repository: '/repo', expectedVersion: detail.body.thread.version,
    });
    expect(resolved.body.thread).toMatchObject({
      status: 'resolved', resolvedByActor: 'operator-dashboard', resolvedByTaskId: 'operator',
    });
  });

  it('returns bounded errors and leaves unrelated paths alone', async () => {
    expect(await call('GET', '/api/coordination/threads')).toMatchObject({ handled: true, status: 400 });
    expect(await call('POST', '/api/coordination/threads', { repository: '/repo' }))
      .toMatchObject({ handled: true, status: 400 });
    expect((await call('GET', '/api/not-coordination')).handled).toBe(false);
  });

  it('does not disclose a known thread id across repositories', async () => {
    const created = await call('POST', '/api/coordination/threads', {
      repository: '/repo', taskId: 'task-a', subject: 'Private', idempotencyKey: 'private',
    });
    const result = await call('GET', `/api/coordination/threads/${created.body.thread.id}?repository=%2Fother`);
    expect(result).toMatchObject({ handled: true, status: 404 });
  });
});
