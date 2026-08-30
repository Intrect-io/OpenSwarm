import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CcRouterAdapter } from './ccRouter.js';

function statusReply(payload: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
}

const ENV_KEYS = ['CC_ROUTER_TOKEN', 'CC_ROUTER_BASE_URL', 'CC_ROUTER_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('CcRouterAdapter availability', () => {
  it('requires an ok status AND the openAIResponses capability, not mere reachability', async () => {
    // A cc-router that answers but cannot serve the Responses API would accept
    // the route and then fail every call — that is an unavailable primary.
    statusReply({ status: 'ok', operational: { capabilities: { openAIResponses: true } } });
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(true);

    statusReply({ status: 'ok', operational: { capabilities: { openAIResponses: false } } });
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);

    statusReply({ status: 'degraded', operational: { capabilities: { openAIResponses: true } } });
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);
  });

  it('probes only the approved loopback health endpoint and fails closed on invalid responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'));
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response('not json'));
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => url === 'http://127.0.0.1:3456/cc-router/health')).toBe(true);

    process.env.CC_ROUTER_BASE_URL = 'https://evil.example.com';
    await expect(new CcRouterAdapter().isAvailable()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('CcRouterAdapter model discovery', () => {
  it('lists model ids from /v1/models with the bearer token when configured', async () => {
    process.env.CC_ROUTER_TOKEN = 'router-secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }, { notAnId: 1 }, { id: 'gpt-5.6-sol' }] })));

    const adapter = new CcRouterAdapter();
    await expect(adapter.listModels()).resolves.toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);
    await expect(adapter.getDefaultModel()).resolves.toBe('gpt-5.6-terra');

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:3456/v1/models');
    expect(init.headers).toEqual({ Authorization: 'Bearer router-secret' });
  });

  it('falls back through env model to the hardcoded default when listing fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(new CcRouterAdapter().getDefaultModel()).resolves.toBe('gpt-5.6-terra');

    process.env.CC_ROUTER_MODEL = 'my-model';
    await expect(new CcRouterAdapter().getDefaultModel()).resolves.toBe('my-model');
  });

  it('normalizes a configured base URL whether or not it already ends in /v1', async () => {
    process.env.CC_ROUTER_BASE_URL = 'http://localhost:9999/v1/';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] })));
    await new CcRouterAdapter().listModels();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/models');
  });

  it('does not send model-probe credentials to a configured remote endpoint', async () => {
    process.env.CC_ROUTER_BASE_URL = 'https://evil.example.com';
    process.env.CC_ROUTER_TOKEN = 'router-secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(new CcRouterAdapter().listModels()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no models on a non-OK response instead of throwing into the router', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(new CcRouterAdapter().listModels()).resolves.toEqual([]);
  });
});

describe('CcRouterAdapter request identity', () => {
  // The protected overrides are the entire point of the subclass: no ChatGPT
  // account id, optional local bearer token, and the loopback-only egress
  // guard. Exercise them through a test-local subclass.
  class Probe extends CcRouterAdapter {
    headersFor(options: Parameters<CcRouterAdapter['authHeaders']>[0]) { return this.authHeaders(options); }
    credentialsFor(options: Parameters<CcRouterAdapter['credentials']>[0]) { return this.credentials(options); }
    url() { return this.responsesUrl(); }
    prepare(payload: unknown) { return this.prepareRequest(payload); }
  }
  const runOptions = { prompt: 'p', cwd: '/repo' };

  it('sends a bearer header only when CC_ROUTER_TOKEN is set, never an account id', async () => {
    const probe = new Probe();
    expect(probe.headersFor(runOptions)).toEqual({});
    await expect(probe.credentialsFor(runOptions)).resolves.toEqual({ accessToken: '', accountId: '' });

    process.env.CC_ROUTER_TOKEN = 'router-secret';
    expect(probe.headersFor(runOptions)).toEqual({ Authorization: 'Bearer router-secret' });
    await expect(probe.credentialsFor(runOptions)).resolves.toEqual({ accessToken: 'router-secret', accountId: '' });
  });

  it('targets the local /v1/responses endpoint through the loopback egress guard', () => {
    const probe = new Probe();
    expect(probe.url()).toBe('http://127.0.0.1:3456/v1/responses');
    // The egress guard admits the loopback origin and would reject a remote one.
    expect(() => probe.prepare({ model: 'm' })).not.toThrow();
    process.env.CC_ROUTER_BASE_URL = 'https://evil.example.com';
    expect(() => new Probe().prepare({ model: 'm' })).toThrow();
  });
});
