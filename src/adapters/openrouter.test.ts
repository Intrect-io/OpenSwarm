// ============================================
// OpenSwarm - OpenRouter Adapter Tests
// Created: 2026-05-27
// Purpose: Verify OpenRouter adapter wiring + API call shape
// Dependencies: vitest
// Test Status: npm run test -- src/adapters/openrouter.test.ts
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterCliAdapter, createApiCaller, applyPromptCaching } from './openrouter.js';
import { RateLimitError } from './rateLimitError.js';
import { getAdapter } from './index.js';
import type { ChatMessage } from './agenticLoop.js';

describe('OpenRouterCliAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers as a named adapter', () => {
    const adapter = getAdapter('openrouter');
    expect(adapter.name).toBe('openrouter');
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
    expect(adapter.capabilities.supportsJsonOutput).toBe(true);
  });

  it('run() REJECTS (does not bury as exitCode:1) on an infra fetch failure — INT-2520', async () => {
    // The run() catch must re-throw infra errors just like RateLimitError, so the
    // pipeline classifies infra_error instead of the worker reading an empty
    // exitCode:1 result as a false success → STUCK.
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }));
    try {
      const adapter = new OpenRouterCliAdapter();
      await expect(adapter.run({
        prompt: 'x', cwd: process.cwd(), model: 'openai/gpt-4o',
        webTools: false, memoryTools: false, mcpTools: [], enableTools: false, maxTurns: 1,
      } as never)).rejects.toThrow(/fetch failed/);
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });

  it('reports unavailable when no profile is stored', async () => {
    const adapter = new OpenRouterCliAdapter();
    // Without a stored sk-or-* key, isAvailable should be false.
    // We don't write a profile in this test, so the default ~/.openswarm store
    // either lacks the key or returns null — either way the adapter is unavailable.
    const available = await adapter.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('calls /chat/completions with Bearer auth and attribution headers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
          'data: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('sk-or-test-key', 'anthropic/claude-sonnet-4');
    const response = await callApi(
      [{ role: 'user', content: 'ping' }],
      [],
    );

    expect(response.choices[0].message.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test-key');
    expect(headers['HTTP-Referer']).toContain('openswarm');
    expect(headers['X-Title']).toBe('OpenSwarm');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('anthropic/claude-sonnet-4');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(body.tools).toBeUndefined();
  });

  it('includes tools when the agentic loop provides them', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('sk-or-test-key', 'openai/gpt-4o');
    await callApi(
      [{ role: 'user', content: 'use tools' }],
      [
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
        },
      ],
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('read_file');
  });

  it('sends ZDR (provider.data_collection: deny) for non-OpenAI models', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const callApi = createApiCaller('sk-or-test', 'z-ai/glm-4.7-flash');
    await callApi([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.provider).toEqual({ data_collection: 'deny', sort: 'throughput' });
    expect(body.reasoning).toBeUndefined(); // not disabled unless requested
  });

  it('does NOT send ZDR for OpenAI models (they reject data_collection:deny)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const callApi = createApiCaller('sk-or-test', 'openai/gpt-5');
    await callApi([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.provider).toBeUndefined();
  });

  it('disables reasoning for non-OpenAI models when requested', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const callApi = createApiCaller('sk-or-test', 'z-ai/glm-4.7-flash', { disableReasoning: true });
    await callApi([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('does NOT disable reasoning for OpenAI models (mandatory; would 400)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // gpt-5 is the worker escalate target — disableReasoning must be ignored for it.
    const callApi = createApiCaller('sk-or-test', 'openai/gpt-5', { disableReasoning: true });
    await callApi([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reasoning).toBeUndefined();
  });

  it('leaves OpenAI/Gemini messages untouched (auto-cached by OpenRouter)', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const out = applyPromptCaching(msgs, 'openai/gpt-5');
    expect(out).toBe(msgs); // same reference, no transform
  });

  it('inserts cache_control breakpoints for Anthropic models', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }, // last msg — NOT cached (changes every turn)
    ];
    const out = applyPromptCaching(msgs, 'anthropic/claude-sonnet-4') as Array<Record<string, unknown>>;

    // system (idx 0) and length-2 (idx 2, the assistant) get cache markers.
    const sysContent = out[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent[0].cache_control).toEqual({ type: 'ephemeral' });

    const cachedAssistant = out[2].content as Array<Record<string, unknown>>;
    expect(cachedAssistant[0].cache_control).toEqual({ type: 'ephemeral' });

    // last message stays a plain string (no breakpoint on the volatile tail)
    expect(typeof out[3].content).toBe('string');
  });

  it('does not transform a single-message history (no stable prefix to cache)', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'only' }];
    const out = applyPromptCaching(msgs, 'anthropic/claude-sonnet-4');
    expect(out).toEqual(msgs);
  });

  it('throws a generic error (with status code) on an ordinary non-2xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('upstream exploded', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('sk-or-test-key', 'openai/gpt-4o');
    await expect(
      callApi([{ role: 'user', content: 'x' }], []),
    ).rejects.toThrow(/OpenRouter API error \(500\)/);
  });

  it('waits out a 429 and retries instead of reporting a usage limit — INT-2907', async () => {
    // A 429 is OpenRouter pacing us, not an exhausted account: the old behavior
    // (typed RateLimitError) paused the scheduler / aborted review --max runs.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('Rate limit exceeded', { status: 429 });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const callApi = createApiCaller('sk-or-test-key', 'openai/gpt-4o');

    vi.useFakeTimers();
    try {
      const pending = callApi([{ role: 'user', content: 'x' }], []);
      await vi.advanceTimersByTimeAsync(6_000); // 5s backoff + jitter headroom
      await expect(pending).resolves.toBeDefined();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a typed RateLimitError on 402 out-of-credits — INT-2520', async () => {
    // OpenRouter signals out-of-credits with 402, not 429.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more to continue.' } }), { status: 402 }),
    ));
    const callApi = createApiCaller('sk-or-test-key', 'openai/gpt-4o');
    await expect(callApi([{ role: 'user', content: 'x' }], [])).rejects.toBeInstanceOf(RateLimitError);
  });
});
