import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  });

  it('answers a valid axis with a value absent from the window with an empty 200', async () => {
    const response = await fetch(`${baseUrl}/api/usage?since=24h&by=stage&project=MissingProject`);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: unknown[]; total: { calls: number } };
    expect(body.rows).toEqual([]);
    expect(body.total.calls).toBe(0);
    expect((await fetch(`${baseUrl}/api/usage?by=stage&bogus=x`)).status).toBe(400);
  });

  // AGT-4297: Node reads TZ once, at startup, so setting process.env.TZ inside
  // this worker would not reliably move the zone. Each zone runs in its own
  // child process (usageRoute.tz.fixture.ts, launched through tsx like the run
  // ledger's process-race tests) with TZ in its environment; the child reports
  // its UTC offset so the test fails if the zone never applied. The window
  // start is an offset-less ISO time, which parseUsageSince reads as local
  // time, so the two zones really read different windows: 2026-11-20T12:00 is
  // 03:00Z in Seoul and 12:00Z in UTC. The 15:30Z record is the next KST day.
  it('drilldown totals match the parent row under TZ=Asia/Seoul and UTC', async () => {
    const rec = (ts: string, cwd: string, stage: string, costUsd: number | null) =>
      recordUsage(record({ ts, cwd, stage, costUsd }));
    rec('2026-11-20T06:00:00.000Z', '/work/OpenSwarm', 'worker', 1);     // inside the Seoul window only
    rec('2026-11-20T15:30:00.000Z', '/work/OpenSwarm', 'reviewer', 0.5); // 00:30 KST on 11-21
    rec('2026-11-20T18:00:00.000Z', '/work/OpenSwarm', 'worker', null);  // unmetered
    rec('2026-11-20T20:00:00.000Z', '/work/other', 'planner', 0.25);
    const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
    const fixture = resolve('src/support/usageRoute.tz.fixture.ts');
    const run = async (TZ: string) => {
      const { stdout } = await promisify(execFile)(process.execPath, [tsxCli, fixture, '2026-11-20T12:00', '2026-11-21T00:00:00.000Z'], {
        env: { ...process.env, TZ, OPENSWARM_USAGE_DIR: dir },
      });
      return JSON.parse(stdout) as {
        offsetMinutes: number; since: number; calls: number;
        drills: Array<{ parent: Record<string, unknown>; drill: { total: Record<string, unknown>; rows: unknown[] } }>;
        dayDrills: Array<{ parent: Record<string, unknown>; drill: { total: Record<string, unknown>; rows: unknown[] } }>;
      };
    };
    const [seoul, utc] = await Promise.all([run('Asia/Seoul'), run('UTC')]);
    expect([seoul.offsetMinutes, utc.offsetMinutes]).toEqual([-540, 0]);
    expect([seoul.since, utc.since]).toEqual([Date.parse('2026-11-20T03:00:00Z'), Date.parse('2026-11-20T12:00:00Z')]);
    expect([seoul.calls, utc.calls]).toEqual([4, 3]); // the 06:00Z record is in the Seoul window only
    for (const zone of [seoul, utc]) {
      expect(zone.drills.length).toBe(2);
      for (const { parent, drill } of [...zone.drills, ...zone.dayDrills]) {
        const { key: _parentKey, ...parentTotals } = parent;
        const { key: _drillKey, ...drillTotals } = drill.total;
        expect(drillTotals).toEqual(parentTotals);
        expect(drill.rows.length).toBeGreaterThan(0);
      }
    }
    const openSwarm = (zone: typeof seoul) => zone.drills.find((d) => d.parent.key === 'OpenSwarm')!.parent;
    expect(openSwarm(seoul)).toMatchObject({ calls: 3, meteredCalls: 2, costUsd: 1.5 });
    expect(openSwarm(utc)).toMatchObject({ calls: 2, meteredCalls: 1, costUsd: 0.5 });
  }, 30_000);
});
