// ============================================
// OpenSwarm - LM Studio Adapter Tests
// Created: 2026-05-13
// Purpose: Verify dedicated LM Studio adapter wiring and OpenAI-compatible probing
// Dependencies: vitest
// Test Status: npm run test -- src/adapters/lmstudio.test.ts
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LmStudioAdapter } from './lmstudio.js';
import { LocalModelAdapter } from './local.js';
import { getAdapter } from './index.js';

describe('LmStudioAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers as a named adapter', () => {
    const adapter = getAdapter('lmstudio');

    expect(adapter.name).toBe('lmstudio');
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
  });

  it('checks LM Studio default /v1/models endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1234/v1/models',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(adapter.getActiveUrl()).toBe('http://localhost:1234');
  });

  it('uses LMSTUDIO_BASE_URL and optional bearer API key', async () => {
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:4321/';
    process.env.LMSTUDIO_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/v1/models',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
      }),
    );
  });

  it('auto-selects the loaded LM Studio model when no override is provided', async () => {
    delete process.env.LMSTUDIO_MODEL;
    delete process.env.LMSTUDIO_API_KEY;
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:4321/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemma-4-26b-a4b-it-mlx' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemma-4-26b-a4b-it-mlx' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemma-4-26b-a4b-it-mlx' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"role":"assistant","content":"LM Studio is ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    const result = await adapter.run({
      prompt: 'Say hello',
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('LM Studio is ready.');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4321/v1/models',
      expect.any(Object),
    );

    const chatCall = fetchMock.mock.calls.at(-1);
    expect(chatCall?.[0]).toBe('http://127.0.0.1:4321/v1/chat/completions');
    const body = JSON.parse(chatCall?.[1]?.body as string) as { model: string };
    expect(body.model).toBe('gemma-4-26b-a4b-it-mlx');
  });

  it('rediscovers a healthy endpoint when the previously selected server disappears', async () => {
    const stream = 'data: {"choices":[{"delta":{"role":"assistant","content":"fallback"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
    let primaryHealthChecks = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:11434/v1/models') {
        primaryHealthChecks += 1;
        if (primaryHealthChecks > 1) throw new TypeError('primary offline');
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new LocalModelAdapter({ endpoints: ['http://127.0.0.1:11434', 'http://127.0.0.1:1234'] });
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.getActiveUrl()).toBe('http://127.0.0.1:11434');

    await expect(adapter.run({ prompt: 'hello', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
    expect(adapter.getActiveUrl()).toBe('http://127.0.0.1:1234');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });
});
