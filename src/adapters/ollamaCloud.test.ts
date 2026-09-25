// ============================================
// OpenSwarm - Ollama Cloud Adapter Tests
// Purpose: Verify the two transports Ollama Cloud exposes, and the model-id
//          contract each one enforces.
//
// Measured against the live service on 2026-09-23 (see plan.md):
//   - `POST https://ollama.com/api/chat` without a key returns 401, but
//     `GET https://ollama.com/v1/models` is readable unauthenticated.
//   - The local server at :11434 serves cloud models under its own sign-in, and
//     answers 404 for the *plain* cloud id — it only accepts the `-cloud` /
//     `:cloud` spelling.
//   - Local discovery cannot see cloud models at all (`/v1/models` -> data null,
//     `/api/tags` -> []), so the curated list is the only offline source.
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Undici from 'undici';
import { getAdapter } from './index.js';
import {
  OllamaCloudAdapter,
  OLLAMA_CLOUD_DIRECT_BASE_URL,
  OLLAMA_CLOUD_LOCAL_BASE_URL,
  OLLAMA_CLOUD_CURATED_MODELS,
  OLLAMA_CLOUD_DEFAULT_MODEL,
  toLocalTransportModel,
  toDirectTransportModel,
} from './ollamaCloud.js';

// Adapters send HTTPS traffic through undici's own fetch with a shared HTTP/1.1
// dispatcher (AGT-4220), so `vi.stubGlobal('fetch', ...)` alone does not
// intercept it. Delegating the module's fetch to the global keeps every stub in
// this file meaningful — and the dispatcher is dropped on the way through, so
// the stubbed global is what actually answers.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    fetch: (url: unknown, init: unknown) => {
      const rest = { ...((init ?? {}) as Record<string, unknown>) };
      delete rest.dispatcher;
      return (globalThis.fetch as unknown as (u: unknown, i: unknown) => unknown)(url, rest);
    },
  };
});

describe('Ollama Cloud model-id contract', () => {
  // The two transports disagree, and getting this wrong is a 404 at run time
  // rather than a config error — so it is pinned here rather than in a comment.
  it('adds the cloud suffix the local server requires', () => {
    expect(toLocalTransportModel('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash:cloud');
  });

  it('accepts a bare :cloud suffix and normalizes it to -cloud', () => {
    expect(toLocalTransportModel('gemma4:cloud')).toBe('gemma4:cloud');
    expect(toLocalTransportModel('gemma4:31b-cloud')).toBe('gemma4:31b-cloud');
  });

  it('does not double-suffix an id that is already cloud-spelled', () => {
    expect(toLocalTransportModel('gemma4:31b-cloud')).toBe('gemma4:31b-cloud');
  });

  it('strips the cloud suffix for the direct API, which rejects it', () => {
    expect(toDirectTransportModel('deepseek-v4.1-flash:cloud')).toBe('deepseek-v4.1-flash');
    expect(toDirectTransportModel('gemma4:31b-cloud')).toBe('gemma4:31b');
  });

  it('leaves a plain id alone on the direct transport', () => {
    expect(toDirectTransportModel('glm-5.3')).toBe('glm-5.3');
  });

  it('round-trips an id through both spellings', () => {
    for (const id of ['deepseek-v4.1-flash', 'glm-5.3', 'gemma4:31b']) {
      expect(toDirectTransportModel(toLocalTransportModel(id))).toBe(id);
    }
  });
});

describe('OllamaCloudAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers as a named adapter', () => {
    const adapter = getAdapter('ollama-cloud');
    expect(adapter.name).toBe('ollama-cloud');
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
    expect(adapter.capabilities.supportsJsonOutput).toBe(true);
  });

  it('advertises the same boundary guarantees as the local adapter it extends', () => {
    // It reaches an HTTP endpoint through OpenSwarm's own loop, so it is subject
    // to the read-only gates rather than delegating to a CLI.
    const adapter = getAdapter('ollama-cloud') as OllamaCloudAdapter;
    expect(adapter.capabilities.enforcesReadOnly).toBe(true);
    expect(adapter.capabilities.enforcesHumanSurfaceReadOnly).toBe(true);
  });

  it('defaults to the local transport when no API key is set', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.getTransport()).toBe('local');
    expect(adapter.getActiveUrl()).toBe(OLLAMA_CLOUD_LOCAL_BASE_URL);
  });

  it('uses the direct transport when OLLAMA_API_KEY is present', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.getTransport()).toBe('direct');
    expect(adapter.getActiveUrl()).toBe(OLLAMA_CLOUD_DIRECT_BASE_URL);
  });

  it('lets OLLAMA_CLOUD_BASE_URL override the transport choice', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://127.0.0.1:11434';

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.getTransport()).toBe('local');
  });

  it('falls back to the curated list because local discovery cannot see cloud models', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    delete process.env.OLLAMA_CLOUD_MODEL;

    // Exactly what the local server returns on this machine: a 200 with no ids.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    // Curated ids are canonical (plain); they are spelled per transport at use.
    await expect(adapter.listModels()).resolves.toContain(OLLAMA_CLOUD_DEFAULT_MODEL);

    // The defect this adapter exists to fix: `local` resolves its default from a
    // live list that is empty here, so it defaults to `gemma3:4b`, which the
    // local transport answers 404 for.
    const fallback = await adapter.getDefaultModel();
    expect(fallback).toBe(toLocalTransportModel(OLLAMA_CLOUD_DEFAULT_MODEL));
    expect(OLLAMA_CLOUD_CURATED_MODELS).toContain(OLLAMA_CLOUD_DEFAULT_MODEL);
  });

  it('never yields a default the local transport would reject', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    delete process.env.OLLAMA_CLOUD_MODEL;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: null }), { status: 200 })));

    const adapter = new OllamaCloudAdapter();
    const model = await adapter.getDefaultModel();
    // Measured: 404 for the plain spelling, 200 for the suffixed one.
    expect(model.endsWith('-cloud') || model.endsWith(':cloud')).toBe(true);
    expect(model).not.toBe('gemma3:4b');
  });

  it('honours an explicit OLLAMA_CLOUD_MODEL, spelled for the transport in use', async () => {
    delete process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_CLOUD_MODEL = 'kimi-k2.6';

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    // The local transport rejects the plain spelling with a 404, so an override
    // is normalized rather than passed through verbatim.
    expect(await adapter.getDefaultModel()).toBe('kimi-k2.6:cloud');
  });

  it('sends the normalized id on a run so the local server can resolve it', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    process.env.OLLAMA_CLOUD_MODEL = 'deepseek-v4.1-flash';

    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return new Response(
        'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    await adapter.run({
      prompt: 'say ok',
      cwd: process.cwd(),
      model: 'deepseek-v4.1-flash',
      enableTools: false,
      maxTurns: 1,
    });

    const chatRequest = bodies.map((b) => JSON.parse(b) as { model?: string }).find((b) => b.model);
    expect(chatRequest?.model).toBe('deepseek-v4.1-flash:cloud');
  });

  it('sends a Bearer header only on the direct transport', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;

    const headers: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaCloudAdapter();
    await adapter.isAvailable();
    expect(headers[0]?.Authorization).toBe('Bearer test-key');
  });

  it('reports unavailable rather than pretending when neither transport answers', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    // A configured endpoint is the only candidate, so this is a single probe.
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://127.0.0.1:11434';

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const adapter = new OllamaCloudAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });
});
