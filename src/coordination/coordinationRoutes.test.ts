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
  const handled = tryHandleCoordinationRoutes({ method: 'GET' } as IncomingMessage, response, parsed.pathname, parsed);
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
