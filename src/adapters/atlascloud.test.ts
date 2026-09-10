// ============================================
// OpenSwarm - Atlas Cloud Adapter Tests
// Purpose: Verify Atlas Cloud adapter wiring + API call shape
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasCloudCliAdapter, createApiCaller } from './atlascloud.js';
import { RateLimitError } from './rateLimitError.js';
import { getAdapter } from './index.js';

// Adapters send HTTPS traffic through undici's own fetch with a shared HTTP/1.1
// dispatcher (AGT-4220), so `vi.stubGlobal('fetch', ...)` alone no longer
// intercepts it. Delegating the module's fetch to the global keeps every
// existing stub in this file meaningful, and the init object — `dispatcher`
// included — still reaches the stub, so it stays assertable.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (url: unknown, init: unknown) => (globalThis.fetch as unknown as (u: unknown, i: unknown) => unknown)(url, init),
  };
});


describe('AtlasCloudCliAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers as a named adapter', () => {
    const adapter = getAdapter('atlascloud');
    expect(adapter.name).toBe('atlascloud');
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
    expect(adapter.capabilities.supportsJsonOutput).toBe(true);
  });

  it('reports available when ATLASCLOUD_API_KEY is set', async () => {
    process.env.ATLASCLOUD_API_KEY = 'test-key';
    await expect(new AtlasCloudCliAdapter().isAvailable()).resolves.toBe(true);
  });

  it('calls Atlas Cloud /chat/completions with Bearer auth', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
          'data: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('atlas-test-key', 'deepseek-ai/deepseek-v4-pro');
    const response = await callApi([{ role: 'user', content: 'ping' }], []);

    expect(response.choices[0].message.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.atlascloud.ai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer atlas-test-key');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-ai/deepseek-v4-pro');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(body.tools).toBeUndefined();
  });

  it('includes tools when the agentic loop provides them', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('atlas-test-key', 'qwen/qwen3.5-flash');
    await callApi(
      [{ role: 'user', content: 'use tools' }],
      [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('read_file');
  });

  it('throws a typed RateLimitError when the body says the quota is spent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('insufficient_quota', { status: 429 })));
    const callApi = createApiCaller('atlas-test-key', 'deepseek-ai/deepseek-v4-pro');
    await expect(callApi([{ role: 'user', content: 'x' }], [])).rejects.toBeInstanceOf(RateLimitError);
  });

  it('waits out a bare 429 throttle, then reports it as infra — never a usage limit (INT-2907)', async () => {
    const fetchMock = vi.fn(async () => new Response('Rate limit exceeded', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const callApi = createApiCaller('atlas-test-key', 'deepseek-ai/deepseek-v4-pro');

    vi.useFakeTimers();
    try {
      const pending = callApi([{ role: 'user', content: 'x' }], []).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 40_000 + 3_000);
      const err = (await pending) as Error;
      expect(err).not.toBeInstanceOf(RateLimitError);
      expect(err.message).toContain('throttle-retry:');
      expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });
});
