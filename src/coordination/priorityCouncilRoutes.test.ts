import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCoordinationThread } from './coordinationThreads.js';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { repositoryKey, resetRepositoryCellCacheForTests } from './repositoryCell.js';
import { resetTraceDbForTests } from './coordinationTrace.js';
import { castPriorityCouncilBallot } from './priorityCouncil.js';
import { tryHandlePriorityCouncilRoutes } from './priorityCouncilRoutes.js';

let root: string;
let repoKey: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'priority-council-routes-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  resetRepositoryCellCacheForTests();
  repoKey = repositoryKey(undefined, '/repo');
  const now = Date.now();
  for (const peer of [
    { actor: 'reviewer-c', actorRole: 'reviewer', taskId: 'peer-c' },
    { actor: 'orchestrator-d', actorRole: 'orchestrator', taskId: 'peer-d' },
  ]) {
    await getCoordinationStore().publish({
      repository: '/repo', repoKey, taskId: peer.taskId, actor: peer.actor, actorRole: peer.actorRole,
      recipient: 'openswarm-daemon', recipientRole: 'daemon', kind: 'delegation-request', status: 'running',
      correlationId: `presence-${peer.taskId}`, summary: 'active peer', timestamp: now,
    });
  }
});

afterEach(() => {
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  resetRepositoryCellCacheForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  delete process.env.OPENSWARM_COORDINATION_FILE;
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  let status = 0;
  let payload = '';
  const url = new URL(`http://localhost${path}`);
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { payload = value; },
  } as unknown as ServerResponse;
  const handled = await tryHandlePriorityCouncilRoutes(
    { method } as IncomingMessage, res, url.pathname, url, async () => JSON.stringify(body ?? {}),
  );
  return { handled, status, body: payload ? JSON.parse(payload) : undefined };
}

function openBody(threadId: string) {
  return {
    repository: '/repo', threadId, reason: 'tie', subject: 'Tie order',
    options: [
      { id: 'a', label: 'A', taskId: 'candidate-a', evidenceIds: ['a-cache'] },
      { id: 'b', label: 'B', taskId: 'candidate-b', evidenceIds: ['b-cache'] },
    ],
    snapshotVersion: 'cache-v1', snapshotCapturedAt: Date.now(),
    snapshotEvidence: [
      { id: 'a-cache', source: 'tracker-cache', summary: 'A priority 2.' },
      { id: 'b-cache', source: 'tracker-cache', summary: 'B priority 2.' },
    ],
    requiredQuorum: 2, expiresInMs: 60_000, idempotencyKey: 'api-open',
  };
}

describe('priority council HTTP API', () => {
  it('opens, lists, reads evidence, and CAS-finalizes without exposing a spoofable vote endpoint', async () => {
    const thread = createCoordinationThread({
      repository: repoKey, subject: 'Tie', actor: 'operator-dashboard', taskId: 'operator',
      relatedTaskIds: ['candidate-a', 'candidate-b'], idempotencyKey: 'api-thread',
    });
    const opened = await call('POST', '/api/coordination/councils', openBody(thread.id));
    expect(opened).toMatchObject({ handled: true, status: 201, body: { council: { status: 'open' } } });
    const councilId = opened.body.council.id as string;

    expect((await call('GET', '/api/coordination/councils?repository=%2Frepo')).body.items)
      .toHaveLength(1);
    expect((await call('GET', `/api/coordination/councils/${councilId}?repository=%2Frepo`)).body.council)
      .toMatchObject({ id: councilId, snapshotVersion: 'cache-v1' });
    expect((await call('POST', `/api/coordination/councils/${councilId}/vote`, {
      repository: '/repo', actor: 'spoofed', ranking: ['a', 'b'],
    })).handled).toBe(false);

    const evidence = await call('POST', `/api/coordination/councils/${councilId}/evidence`, {
      repository: '/repo', optionId: 'a', summary: 'Operator confirms creation time.',
      refs: ['tracker-cache:a'], idempotencyKey: 'operator-evidence',
    });
    expect(evidence).toMatchObject({ handled: true, status: 201, body: { evidence: { optionId: 'a' } } });

    castPriorityCouncilBallot({
      repository: repoKey, councilId, actor: 'reviewer-c', actorRole: 'reviewer', taskId: 'peer-c',
      ranking: ['a', 'b'], confidence: 0.7, evidenceIds: ['a-cache'], snapshotVersion: 'cache-v1',
      idempotencyKey: 'vote-c',
    });
    castPriorityCouncilBallot({
      repository: repoKey, councilId, actor: 'orchestrator-d', actorRole: 'orchestrator', taskId: 'peer-d',
      ranking: ['a', 'b'], confidence: 0.9, evidenceIds: ['a-cache'], snapshotVersion: 'cache-v1',
      idempotencyKey: 'vote-d',
    });
    const finalized = await call('POST', `/api/coordination/councils/${councilId}/finalize`, {
      repository: '/repo', expectedVersion: 4, idempotencyKey: 'api-finalize',
    });
    expect(finalized).toMatchObject({
      handled: true, status: 200,
      body: { council: { status: 'finalized', selectedOptionId: 'a', version: 5 } },
    });
  });

  it('returns bounded errors and repository isolation', async () => {
    expect(await call('GET', '/api/coordination/councils')).toMatchObject({
      handled: true, status: 400, body: { error: 'Invalid priority council request' },
    });
    expect((await call('GET', '/api/not-a-council')).handled).toBe(false);
    const thread = createCoordinationThread({
      repository: repoKey, subject: 'Private', actor: 'operator-dashboard', taskId: 'operator',
      relatedTaskIds: ['candidate-a', 'candidate-b'], idempotencyKey: 'private-thread',
    });
    const opened = await call('POST', '/api/coordination/councils', openBody(thread.id));
    const councilId = opened.body.council.id as string;
    expect(await call('GET', `/api/coordination/councils/${councilId}?repository=%2Fother`))
      .toMatchObject({ handled: true, status: 404, body: { error: 'Priority council not found' } });
  });
});
