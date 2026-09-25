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

  it('keeps an already cloud-spelled id as given', () => {
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

  // Independent review of the adapter (AGT-4512).
  it('reads the key at call time, so a key loaded from .env after import is used', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    const adapter = new OllamaCloudAdapter();
    // The CLI loads .env after the adapter registry is built.
    process.env.OLLAMA_API_KEY = 'late-key';
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    }));
    expect(adapter.getTransport()).toBe('direct');
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(calls[0]).toEqual({ url: `${OLLAMA_CLOUD_DIRECT_BASE_URL}/v1/models`, auth: 'Bearer late-key' });
  });

  it('refuses a non-loopback base URL other than ollama.com and never sends it the key', async () => {
    process.env.OLLAMA_API_KEY = 'secret-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://192.168.1.10:11434';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OllamaCloudAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(false);
    const result = await adapter.run({ prompt: 'x', cwd: process.cwd(), enableTools: false, maxTurns: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OLLAMA_CLOUD_BASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a bracketed IPv6 loopback base URL as the local transport', () => {
    process.env.OLLAMA_API_KEY = 'secret-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://[::1]:11434';
    expect(new OllamaCloudAdapter().getTransport()).toBe('local');
  });

  it('retries a transient 5xx on the direct transport and sends the plain id to the chat endpoint', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    const chat: Array<{ url: string; model?: string }> = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/chat/completions')) {
        chat.push({ url: String(url), model: (JSON.parse(String(init?.body)) as { model?: string }).model });
        calls += 1;
        if (calls === 1) return new Response('bad gateway', { status: 502 });
        return new Response(
          'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    }));
    const result = await new OllamaCloudAdapter().run({
      prompt: 'say ok', cwd: process.cwd(), model: 'deepseek-v4.1-flash:cloud', enableTools: false, maxTurns: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(chat).toHaveLength(2);
    expect(chat[1]).toEqual({ url: 'https://ollama.com/v1/chat/completions', model: 'deepseek-v4.1-flash' });
  }, 30_000);

  it('defaults to the curated model, not whichever cloud model a server lists first', async () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    delete process.env.OLLAMA_CLOUD_MODEL;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'kimi-k2.6:cloud' }, { id: 'deepseek-v4.1-flash:cloud' }] }),
      { status: 200 },
    )));
    const adapter = new OllamaCloudAdapter();
    await adapter.isAvailable();
    await expect(adapter.getDefaultModel()).resolves.toBe(`${OLLAMA_CLOUD_DEFAULT_MODEL}:cloud`);
  });

  it('caches the live direct catalogue so model compatibility accepts every served id', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ollama-catalog-'));
    process.env.OPENSWARM_MODEL_CATALOG_DIR = dir;
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3' }, { id: 'deepseek-v4.1-flash' }] }),
        { status: 200 },
      )));
      await new OllamaCloudAdapter().listModels();
      const { mapModelForProvider } = await import('./modelCompat.js');
      expect(mapModelForProvider('ollama-cloud', 'kimi-k3')).toBe('kimi-k3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never sends the key to the local server, even when one is set', async () => {
    process.env.OLLAMA_API_KEY = 'secret-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://127.0.0.1:11434';
    const auth: Array<string | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      auth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(
        'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }));
    const adapter = new OllamaCloudAdapter();
    await adapter.isAvailable();
    await adapter.run({ prompt: 'x', cwd: process.cwd(), enableTools: false, maxTurns: 1 });
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((value) => value === undefined)).toBe(true);
  });

  it('probes only the configured loopback server, never falling back to :11434', async () => {
    delete process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_CLOUD_BASE_URL = 'http://localhost:9999';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes(':9999')) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    }));
    await expect(new OllamaCloudAdapter().isAvailable()).resolves.toBe(false);
    expect(urls.every((url) => url.includes(':9999'))).toBe(true);
  });

  // AGT-4534, run base2: one direct request went silent and consumed the
  // reviewer's whole 600 s stage budget. A silent request is now abandoned
  // after an idle window and retried.
  it('abandons a request that goes silent and retries it', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!String(url).endsWith('/chat/completions')) {
        return Promise.resolve(new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }));
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        // Accepts the request and never answers — only an abort ends it.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return Promise.resolve(new Response(
        'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }));
    const started = Date.now();
    const result = await new OllamaCloudAdapter({ streamIdleMs: 200 }).run({
      prompt: 'say ok', cwd: process.cwd(), model: 'deepseek-v4.1-flash', enableTools: false, maxTurns: 1, timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(chatCalls).toBe(2);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('does not restart the caller deadline on a stall retry', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    delete process.env.OLLAMA_CLOUD_BASE_URL;
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!String(url).endsWith('/chat/completions')) {
        return Promise.resolve(new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }));
      }
      chatCalls += 1;
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) { reject(init.signal.reason); return; }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }));
    const started = Date.now();
    // The deadline abort is an infra error, which the adapter rethrows.
    await expect(new OllamaCloudAdapter({ streamIdleMs: 150 }).run({
      prompt: 'x', cwd: process.cwd(), model: 'deepseek-v4.1-flash', enableTools: false, maxTurns: 1, timeoutMs: 400,
    })).rejects.toThrow(/timeout/i);
    // Every retry after the 400 ms deadline fails at once instead of waiting
    // out a fresh deadline of its own.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(chatCalls).toBeLessThanOrEqual(3);
  }, 30_000);
});
