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

  it('answers the recipient\'s open question even when the client names another exchange', async () => {
    // The dashboard sees a window over a ring buffer, so a question older than
    // that window is invisible to it and it names the newest exchange instead.
    // Filing that as a note would leave the agent parked forever (AGT-4030).
    const store = await boardAt('events.json');
    const question = await store.publish({
      repository: '/repo', taskId: 't-park', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', summary: 'uv is missing — install it or run elsewhere?',
    });
    const laterStage = await store.publish({
      repository: '/repo', taskId: 't-park', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
      recipient: 'reviewer-1', kind: 'delegation-result', status: 'failed', summary: 'Did not pass',
    });

    const result = await post('/api/coordination/message', {
      correlationId: laterStage.correlationId,
      recipient: 'sable',
      repository: '/repo',
      taskId: 't-park',
      text: 'uv is installed now — retry.',
    });

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('answer');
    // The answer must ride the QUESTION's exchange — that is the id the next
    // run replays by — not the stage exchange the client named.
    const answer = store.list({ repository: '/repo', taskId: 't-park' })
      .find((event) => event.kind === 'human-answer');
    expect(answer).toMatchObject({
      correlationId: question.correlationId,
      recipient: 'sable',
      detail: 'uv is installed now — retry.',
    });
    expect(answer?.correlationId).not.toBe(laterStage.correlationId);
  });

  it('answers the question the agent is actually parked on when several are open', async () => {
    // A run stops at the question it just asked, so the newest unsettled one is
    // the live blocker — and the one the operator is reading.
    const store = await boardAt('events.json');
    const older = await store.publish({
      repository: '/repo', taskId: 't-two', actor: 'worker-q', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', summary: 'Which database?',
    });
    const newer = await store.publish({
      repository: '/repo', taskId: 't-two', actor: 'worker-q', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', summary: 'Which credentials?',
    });

    const result = await post('/api/coordination/message', {
      recipient: 'worker-q', repository: '/repo', taskId: 't-two', text: 'Use the mounted ones.',
    });

    expect(result.body.mode).toBe('answer');
    const answer = store.list({ repository: '/repo', taskId: 't-two' })
      .find((event) => event.kind === 'human-answer');
    expect(answer?.correlationId).toBe(newer.correlationId);
    expect(answer?.correlationId).not.toBe(older.correlationId);
  });

  it('refuses to answer a same-named agent on a different task', async () => {
    // Agents choose their own display names, so "sable" is not unique across
    // concurrent work. Without the task scope this would unpark the wrong
    // agent with an answer meant for someone else.
    const store = await boardAt('events.json');
    const theirs = await store.publish({
      repository: '/other-repo', taskId: 't-other', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', summary: 'Ship the migration separately?',
    });
    const mine = await store.publish({
      repository: '/repo', taskId: 't-mine', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
      recipient: 'reviewer-1', kind: 'advice-request', status: 'open', summary: 'Where does retry live?',
    });

    const result = await post('/api/coordination/message', {
      correlationId: mine.correlationId, recipient: 'sable',
      repository: '/repo', taskId: 't-mine', text: 'Scheduler owns retries.',
    });

    expect(result.body.mode).toBe('note');
    expect(store.findQuestion(theirs.correlationId)).toBeDefined();
  });

  it('does not turn a note into an answer when the recipient has nothing open', async () => {
    const store = await boardAt('events.json');
    const opening = await store.publish({
      repository: '/repo', taskId: 't-plain', actor: 'worker-z', actorName: 'Worker Z', actorRole: 'worker',
      recipient: 'reviewer-z', kind: 'advice-request', status: 'open', summary: 'Which retry policy?',
    });

    const result = await post('/api/coordination/message', {
      correlationId: opening.correlationId, recipient: 'worker-z',
      repository: '/repo', taskId: 't-plain', text: 'Scheduler owns it.',
    });

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('note');
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
