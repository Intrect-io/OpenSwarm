// ============================================
// OpenSwarm — the dispatcher that keeps concurrent adapters off one h2 connection
// ============================================
//
// The failure this guards against is invisible in a single-request test: h2
// stream starvation only appears under concurrency, and it appears as latency
// rather than as an error. So what is asserted here is the CONFIGURATION that
// prevents it and the fact that every call carries it — the measurement itself
// lives in the module's comment (AGT-4220, and vela 2026-09-10: 50 openrouter
// timeouts and 34 `fetch failed` in one hour at 48 active runs).

import { afterEach, describe, expect, it, vi } from 'vitest';

const undiciFetch = vi.hoisted(() => vi.fn(async () => new Response('ok')));
const agentArgs = vi.hoisted(() => [] as unknown[]);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class RecordingAgent extends actual.Agent {
    constructor(opts?: unknown) { super(opts as never); agentArgs.push(opts); }
  }
  return { ...actual, fetch: undiciFetch, Agent: RecordingAgent };
});

import { adapterFetch, getAdapterDispatcher, resetAdapterDispatcherForTests } from './httpDispatcher.js';

afterEach(() => {
  undiciFetch.mockClear();
  agentArgs.length = 0;
  resetAdapterDispatcherForTests();
});

describe('adapter HTTP dispatcher', () => {
  it('pins HTTP/1.1 so concurrent requests do not queue for a stream slot', () => {
    // `allowH2: false` is the whole fix. With h2 the server admits only a few
    // streams per connection, and the daemon runs dozens of adapters in one
    // process — measured at concurrency 4, create -> sendHeaders was 17.30s
    // median against a server answering in 1.07s.
    getAdapterDispatcher();

    expect(agentArgs).toHaveLength(1);
    expect(agentArgs[0]).toMatchObject({ allowH2: false });
  });

  it('reuses one dispatcher, because the connection ceiling is process-wide', () => {
    // A second Agent would add a second pool to the same origin and make the
    // ceiling a function of how many callers happened to build one.
    expect(getAdapterDispatcher()).toBe(getAdapterDispatcher());
    // Constructed once, not once per caller.
    expect(agentArgs).toHaveLength(1);
  });

  it('sends every request through it, not through the global fetch', () => {
    // The global negotiates h2 with these origins; that is the state being
    // avoided. A call that forgets the dispatcher silently rejoins it.
    void adapterFetch('https://example.test/v1/chat', { method: 'POST' });

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const init = undiciFetch.mock.calls[0][1] as { dispatcher?: unknown; method?: string };
    expect(init.dispatcher).toBe(getAdapterDispatcher());
    expect(init.method).toBe('POST');
  });

  it('keeps the caller init rather than replacing it', () => {
    const signal = AbortSignal.timeout(1_000);
    void adapterFetch('https://example.test/v1/models', {
      headers: { Authorization: 'Bearer k' },
      signal,
    });

    const init = undiciFetch.mock.calls[0][1] as { headers?: Record<string, string>; signal?: unknown };
    expect(init.headers).toEqual({ Authorization: 'Bearer k' });
    expect(init.signal).toBe(signal);
  });
});
