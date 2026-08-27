import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { tryHandleCoordinationRoutes } from './coordinationRoutes.js';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(() => { resetCoordinationStoreForTests(); process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE; if (dir) rmSync(dir, { recursive: true, force: true }); });

async function call(url: string) {
  let status = 0; let payload = '';
  const response = { writeHead: (code: number) => { status = code; }, end: (body: string) => { payload = body; } } as unknown as ServerResponse;
  const parsed = new URL(`http://localhost${url}`);
  const handled = await tryHandleCoordinationRoutes({ method: 'GET' } as IncomingMessage, response, parsed.pathname, parsed);
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

describe('GET /api/coordination', () => {
  it('returns redacted repository-scoped events with a monotonic cursor', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-api-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    resetCoordinationStoreForTests();
    const store = getCoordinationStore();
    await store.publish({ repository: '/a', taskId: 't1', actor: 'a', kind: 'mcp-audit', status: 'completed', summary: 'read only' });
    await store.publish({ repository: '/b', taskId: 't2', actor: 'b', kind: 'review-run', status: 'running', summary: 'audit' });
    const response = await call('/api/coordination?repository=%2Fb');
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.pending).toHaveLength(1);
    expect(response.body.lastSeq).toBe(2);
  });

  it('returns only what the client has not seen, and leaves other routes alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-cursor-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    resetCoordinationStoreForTests();
    const store = getCoordinationStore();
    await store.publish({ repository: '/a', taskId: 't1', actor: 'a', kind: 'review-run', status: 'completed', summary: 'first' });
    await store.publish({ repository: '/a', taskId: 't1', actor: 'a', kind: 'review-run', status: 'completed', summary: 'second' });

    // The dashboard polls with the last sequence it rendered; replaying an
    // event it already has would duplicate the row.
    const incremental = await call('/api/coordination?afterSeq=1');
    expect(incremental.body.events.map((event: { summary: string }) => event.summary)).toEqual(['second']);

    expect((await call('/api/other')).handled).toBe(false);
  });
});

/** Drive a POST through the handler with an injected body reader. */
async function post(url: string, body: unknown) {
  let status = 0; let payload = '';
  const response = { writeHead: (code: number) => { status = code; }, end: (text: string) => { payload = text; } } as unknown as ServerResponse;
  const parsed = new URL(`http://localhost${url}`);
  const handled = await tryHandleCoordinationRoutes(
    { method: 'POST' } as IncomingMessage,
    response,
    parsed.pathname,
    parsed,
    async () => JSON.stringify(body),
  );
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

describe('POST /api/coordination/message', () => {
  async function boardAt(path: string) {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-msg-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, path);
    resetCoordinationStoreForTests();
    return getCoordinationStore();
  }

  it('answers a blocking question so the asking agent unblocks', async () => {
    const store = await boardAt('events.json');
    const question = await store.publish({
      repository: '/repo', taskId: 't1', actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', summary: 'Which database?',
    });

    const result = await post('/api/coordination/message', {
      correlationId: question.correlationId, text: 'Use the existing SQLite file.',
    });

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('answer');
    const delivered = store.list({ repository: '/repo', taskId: 't1' })
      .find((event) => event.kind === 'human-answer');
    expect(delivered).toMatchObject({ recipient: 'worker-a', detail: 'Use the existing SQLite file.' });
  });

  it('addresses a free-standing note to the agent that last spoke in the thread', async () => {
    const store = await boardAt('events.json');
    const opening = await store.publish({
      repository: '/repo', taskId: 't2', actor: 'worker-b', actorName: 'Worker B', actorRole: 'worker',
      recipient: 'reviewer-c', kind: 'advice-request', status: 'open', summary: 'Retry in adapter or scheduler?',
    });

    const result = await post('/api/coordination/message', {
      correlationId: opening.correlationId, text: 'Scheduler owns retries.',
    });

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('note');
    // Addressed to the asker, so consume() actually hands it over.
    const forWorker = await store.consume('worker-b', { repository: '/repo', taskId: 't2' });
    expect(forWorker.map((event) => event.detail)).toContain('Scheduler owns retries.');
  });

  it('refuses a message it cannot address', async () => {
    await boardAt('events.json');
    const result = await post('/api/coordination/message', { text: 'floating words' });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/address/i);
  });

  it('rejects empty text', async () => {
    await boardAt('events.json');
    const result = await post('/api/coordination/message', { text: '   ' });
    expect(result.status).toBe(400);
  });
});
