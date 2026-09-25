import { afterEach, describe, expect, it } from 'vitest';
import { credentialProbeSnapshot, probeAgentCredentials, probeAndReportAgentCredentials, resetCredentialProbeSnapshotForTests } from './credentialProbes.js';
import { buildWorkerEnv, clearDeadWorkerEnvKeys } from '../adapters/envPath.js';
import { buildHealthPayload } from '../support/healthEndpoint.js';

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`ENOTFOUND ${url}`);
    const [, r] = hit;
    (fakeFetch as unknown as { seen: RequestInit[] }).seen?.push(init!);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

describe('probeAgentCredentials (AGT-4075)', () => {
  afterEach(() => { clearDeadWorkerEnvKeys(); resetCredentialProbeSnapshotForTests(); });

  it('probes every agent-facing key that is present, by name, and reports per-key verdicts', async () => {
    const results = await probeAgentCredentials({
      LINEAR_API_KEY: 'lin', OPENROUTER_API_KEY: 'or', NOTION_API_KEY: 'no', GITHUB_TOKEN: 'gh', UNRELATED: 'x',
    }, fakeFetch({
      'https://api.linear.app': { status: 200, body: { data: { viewer: { name: 'Heewon Oh' } } } },
      'https://openrouter.ai': { status: 200, body: { data: { label: 'macstudio' } } },
      'https://api.notion.com': { status: 401, body: { message: 'API token is invalid.' } },
      'https://api.github.com': { status: 200, body: { login: 'unohee' } },
    }));
    expect(results.map((r) => [r.name, r.status, r.identity ?? null])).toEqual([
      ['LINEAR_API_KEY', 'ok', 'Heewon Oh'],
      ['OPENROUTER_API_KEY', 'ok', 'macstudio'],
      ['NOTION_API_KEY', 'dead', null],
      ['GITHUB_TOKEN', 'ok', 'unohee'],
    ]);
    expect(results.some((r) => JSON.stringify(r).includes('lin') && r.name !== 'LINEAR_API_KEY')).toBe(false);
  });

  it('reports nothing for absent keys and "unreachable" (not dead) when the service cannot be reached', async () => {
    expect(await probeAgentCredentials({}, fakeFetch({}))).toEqual([]);
    const [r] = await probeAgentCredentials({ NOTION_API_KEY: 'no' }, fakeFetch({}));
    expect(r).toMatchObject({ name: 'NOTION_API_KEY', status: 'unreachable' });
  });

  it('withholds dead keys from workers, keeps the rest, and shows all of it on the health payload', async () => {
    await probeAndReportAgentCredentials({ NOTION_API_KEY: 'no', OPENROUTER_API_KEY: 'or' }, async () => [
      { name: 'NOTION_API_KEY', status: 'dead', reason: 'HTTP 401: invalid' },
      { name: 'OPENROUTER_API_KEY', status: 'ok', identity: 'macstudio' },
    ]);
    const env = buildWorkerEnv({ PATH: '/bin', NOTION_API_KEY: 'no', OPENROUTER_API_KEY: 'or' });
    expect(env.NOTION_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe('or');
    expect(credentialProbeSnapshot()).toEqual({
      NOTION_API_KEY: { status: 'dead', reason: 'HTTP 401: invalid' },
      OPENROUTER_API_KEY: { status: 'ok', identity: 'macstudio' },
    });
    expect(buildHealthPayload({ env: {}, pid: 1, ppid: 1, uptimeS: 1, version: '0', instanceId: 'i', memory: { heapUsedBytes: 0, heapLimitBytes: 0, rssBytes: 0 } }).credentials)
      .toEqual(credentialProbeSnapshot());
  });
});
