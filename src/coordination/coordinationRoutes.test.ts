import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { resetCoordinationRouteLocalizationForTests, tryHandleCoordinationRoutes } from './coordinationRoutes.js';
import { initLocale } from '../locale/index.js';
import { recordTraceEvent, resetTraceDbForTests } from './coordinationTrace.js';

const runChatCompletion = vi.hoisted(() => vi.fn());
vi.mock('../support/chatBackend.js', () => ({ runChatCompletion }));

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(() => {
  delete process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES;
  delete process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE;
  delete process.env.OPENSWARM_AUTOMATION_DB;
  resetTraceDbForTests();
  initLocale('en');
  runChatCompletion.mockReset();
  resetCoordinationRouteLocalizationForTests();
  resetCoordinationStoreForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

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

  it('backfills Korean display text without replacing retained English evidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-translation-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = join(dir, 'translations.json');
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
    resetTraceDbForTests();
    resetCoordinationStoreForTests();
    initLocale('ko');
    await getCoordinationStore().publish({
      repository: '/repo', taskId: 't1', actor: 'worker-a', kind: 'advice-response',
      status: 'completed', summary: 'Use the existing retry helper.',
    });
    recordTraceEvent({
      id: 'trace-only', seq: 0, timestamp: 0, repository: '/old-repo', taskId: 'old-task',
      actor: 'worker-old', kind: 'advice-response', status: 'completed', correlationId: 'old-correlation',
      summary: 'This event has already aged out of the live board.', fingerprint: 'trace-only-fingerprint',
    });
    runChatCompletion.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const items = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as Array<{ id: string }>;
      return { response: JSON.stringify(items.map(({ id }) => ({
        id,
        summary: id === 'trace-only' ? '이 이벤트는 이미 live board에서 밀려났습니다.' : '기존 retry helper를 사용하세요.',
      }))) };
    });

    const backfill = await post('/api/coordination/translations/backfill', {});
    expect(backfill).toMatchObject({ status: 200, body: { locale: 'ko', translated: 2, events: 2, failed: 0 } });
    const repeated = await post('/api/coordination/translations/backfill', {});
    expect(repeated).toMatchObject({ status: 200, body: { translated: 0, cached: 2, failed: 0 } });
    const boardOnly = await post('/api/coordination/translations/backfill', { repository: '/repo', includeHistory: false });
    expect(boardOnly).toMatchObject({ status: 200, body: { events: 1, boardEvents: 1, cached: 1 } });
    expect(runChatCompletion).toHaveBeenCalledTimes(1);
    const response = await call('/api/coordination');
    expect(response.body.events[0]).toMatchObject({
      summary: '기존 retry helper를 사용하세요.',
      localizedLocale: 'ko',
      originalText: { summary: 'Use the existing retry helper.' },
    });
    const history = await call('/api/coordination/history?repository=%2Fold-repo');
    expect(history.body.events[0]).toMatchObject({
      id: 'trace-only', summary: '이 이벤트는 이미 live board에서 밀려났습니다.',
      originalText: { summary: 'This event has already aged out of the live board.' },
    });
  });

  it('automatically backfills retained English when the Korean dashboard is read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-auto-translation-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = join(dir, 'translations.json');
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
    resetTraceDbForTests();
    resetCoordinationStoreForTests();
    initLocale('ko');
    await getCoordinationStore().publish({
      repository: '/repo', taskId: 't-auto', actor: 'worker-a', kind: 'advice-response',
      status: 'completed', summary: 'Review the existing implementation before editing.',
    });
    recordTraceEvent({
      id: 'older-trace-only', seq: 0, timestamp: 0, repository: '/repo', taskId: 't-old',
      actor: 'worker-old', kind: 'advice-response', status: 'completed', correlationId: 'old-auto-correlation',
      summary: 'Do not translate the entire archive from a dashboard poll.', fingerprint: 'older-trace-fingerprint',
    });
    runChatCompletion.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const items = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as Array<{ id: string }>;
      return { response: JSON.stringify(items.map(({ id }) => ({
        id,
        summary: id === 'older-trace-only'
          ? '대시보드 poll에서 전체 이력을 번역하지 마세요.'
          : '수정하기 전에 기존 구현을 검토하세요.',
      }))) };
    });

    const first = await call('/api/coordination?repository=%2Frepo');
    expect(first.status).toBe(200);
    expect(first.body.events[0].summary).toBe('Review the existing implementation before editing.');

    await vi.waitFor(async () => {
      const translated = await call('/api/coordination?repository=%2Frepo');
      expect(translated.body.events[0]).toMatchObject({
        summary: '수정하기 전에 기존 구현을 검토하세요.',
        localizedLocale: 'ko',
        originalText: { summary: 'Review the existing implementation before editing.' },
      });
    });
    expect(runChatCompletion).toHaveBeenCalledTimes(1);
    expect(runChatCompletion.mock.calls[0]![0].prompt).not.toContain('older-trace-only');

    const history = await call('/api/coordination/history?repository=%2Frepo');
    expect(history.body.events.find((item: { id: string }) => item.id === 'older-trace-only')).toMatchObject({
      summary: '대시보드 poll에서 전체 이력을 번역하지 마세요.',
      localizedLocale: 'ko',
    });
    expect(runChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('rejects transcript backfill when the installation locale is English', async () => {
    initLocale('en');
    const response = await post('/api/coordination/translations/backfill', {});
    expect(response).toMatchObject({ status: 409, body: { error: expect.stringMatching(/non-English/) } });
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

  it('exposes board-derived consultation activation evidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-coordination-telemetry-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    resetCoordinationStoreForTests();
    const store = getCoordinationStore();
    const request = await store.publish({
      repository: '/repo', repoKey: 'git:repo', taskId: 'task-a',
      sourceTaskId: 'task-a', targetTaskId: 'task-b',
      actor: 'worker-a', actorRole: 'worker', recipient: 'reviewer-b', recipientRole: 'reviewer',
      kind: 'advice-request', status: 'open', summary: 'Who owns retry.ts?',
      metadata: { consultation: true, consultationPhase: 'request', threadId: 'thread-1', crossTask: true, crossRole: true },
    });
    await store.publish({
      repository: '/repo', repoKey: 'git:repo', taskId: 'task-b',
      sourceTaskId: 'task-b', targetTaskId: 'task-a',
      actor: 'reviewer-b', actorRole: 'reviewer', recipient: 'worker-a', recipientRole: 'worker',
      kind: 'advice-response', status: 'completed', correlationId: request.correlationId,
      summary: 'Task A owns it.',
      metadata: { consultation: true, consultationPhase: 'response', threadId: 'thread-1', crossTask: true, crossRole: true },
    });
    await store.publish({
      repository: '/repo', repoKey: 'git:repo', taskId: 'task-a',
      actor: 'worker-a', kind: 'thread-update', status: 'completed',
      correlationId: 'thread:thread-1', summary: 'Thread replied: Retry ownership',
      metadata: { threadId: 'thread-1', action: 'replied', acknowledgesCorrelationId: request.correlationId },
    });

    const response = await call('/api/coordination?repository=%2Frepo');
    expect(response.body.consultation).toEqual({
      requests: 1,
      responses: 1,
      acknowledgedResponses: 1,
      threadLinkedRequests: 1,
      crossTaskRequests: 1,
      crossRoleRequests: 1,
    });
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

/** Stream a body through the handler the way the HTTP server does. */
async function upload(url: string, payload: Buffer | string) {
  let status = 0;
  let text = '';
  const response = {
    writeHead: (code: number) => { status = code; },
    end: (body: string) => { text = body; },
  } as unknown as ServerResponse;
  const parsed = new URL(`http://localhost${url}`);
  const req = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
  (req as { method?: string }).method = 'POST';
  const handled = await tryHandleCoordinationRoutes(req, response, parsed.pathname, parsed);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('POST /api/coordination/attachment', () => {
  function storeAt() {
    dir = mkdtempSync(join(tmpdir(), 'osw-attach-route-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    resetCoordinationStoreForTests();
  }

  it('stores the bytes and answers with the path the agent will open', async () => {
    storeAt();
    const result = await upload('/api/coordination/attachment?taskId=t1&filename=A2.csv', 'rows\n1,2\n');

    expect(result.status).toBe(201);
    expect(result.body.filename).toBe('A2.csv');
    expect(result.body.path).toContain('attachments');
  });

  it('refuses a file with no task to belong to', async () => {
    storeAt();
    const result = await upload('/api/coordination/attachment?filename=orphan.csv', 'x');

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/taskId/);
  });

  it('answers 507 when the store has no room, so the operator is told why', async () => {
    storeAt();
    // 413 would read as "your file is too big"; it is not, the store is full.
    process.env.OPENSWARM_ATTACHMENT_TOTAL_BYTES = '8';
    const result = await upload('/api/coordination/attachment?taskId=t2&filename=big.bin', 'more than eight bytes');

    expect(result.status).toBe(507);
    expect(result.body.error).toMatch(/storage is full/);
  });

  it('answers 413 when one upload is over the per-file cap', async () => {
    storeAt();
    const { MAX_ATTACHMENT_BYTES } = await import('./attachmentStore.js');
    const result = await upload(
      '/api/coordination/attachment?taskId=t3&filename=huge.bin',
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x61),
    );

    expect(result.status).toBe(413);
    expect(result.body.error).toMatch(/exceeds/);
  });
});
