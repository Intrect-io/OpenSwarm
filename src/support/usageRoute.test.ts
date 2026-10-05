import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUsage, type UsageRecord } from './usageLedger.js';
import { handleUsageRoute } from './usageRoute.js';

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  ts: new Date(Date.now() - 60_000).toISOString(), adapter: 'openrouter', model: 'test-model',
  stage: 'worker', cwd: '/work/OpenSwarm', promptTokens: 100, completionTokens: 20,
  cachedTokens: 40, reasoningTokens: 0, costUsd: 0.25, ...overrides,
});

describe('usage HTTP handler', () => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-usage-route-'));
    process.env.OPENSWARM_USAGE_DIR = dir;
    recordUsage(record());
    recordUsage(record({ stage: 'reviewer', costUsd: 0.75 }));
    recordUsage(record({ cwd: '/work/other', stage: 'worker' }));
    server = createServer(async (req, res) => {
      await handleUsageRoute(new URL(req.url ?? '/', 'http://localhost').searchParams, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected bound HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.OPENSWARM_USAGE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a cross-axis drilldown whose total matches the parent row', async () => {
    const [drillResponse, parentResponse] = await Promise.all([
      fetch(`${baseUrl}/api/usage?since=24h&by=stage&project=OpenSwarm`),
      fetch(`${baseUrl}/api/usage?since=24h&by=project`),
    ]);
    expect(drillResponse.status).toBe(200);
    expect(parentResponse.status).toBe(200);
    const drill = await drillResponse.json() as { total: Record<string, unknown>; rows: Array<{ key: string }> };
    const parent = await parentResponse.json() as { rows: Array<Record<string, unknown>> };
    const { key: _drillKey, ...total } = drill.total;
    const { key: _parentKey, ...project } = parent.rows.find((row) => row.key === 'OpenSwarm')!;
    expect(total).toEqual(project);
    expect(drill.rows.map((row) => row.key).sort()).toEqual(['reviewer', 'worker']);
  });

  it('returns 400 for an invalid axis or filter value', async () => {
    expect((await fetch(`${baseUrl}/api/usage?by=bad`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/usage?by=stage&project=`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/usage?by=stage&project=MissingProject`)).status).toBe(400);
  });
});
