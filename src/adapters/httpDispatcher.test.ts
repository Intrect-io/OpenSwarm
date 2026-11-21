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

import diagnosticsChannel from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, request as undiciRequest } from 'undici';
import {
  adapterFetch,
  getAdapterDispatcher,
  getQueueTimeSnapshot,
  isQueueTimeCollectorRunning,
  nearestRankPercentile,
  resetAdapterDispatcherForTests,
  startQueueTimeCollector,
  stopQueueTimeCollector,
} from './httpDispatcher.js';

afterEach(() => {
  undiciFetch.mockClear();
  agentArgs.length = 0;
  resetAdapterDispatcherForTests();
  stopQueueTimeCollector();
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

describe('request queue-time collector', () => {
  const create = diagnosticsChannel.channel('undici:request:create');
  const sendHeaders = diagnosticsChannel.channel('undici:client:sendHeaders');

  it('records request queue time from undici create to sendHeaders', async () => {
    // Synthetic part: a controlled clock gives known queue delays.
    let t = 0;
    startQueueTimeCollector({ now: () => t });
    const delays = [5, 1, 40, 10, 3, 20, 2, 8, 30, 4];
    for (const d of delays) {
      const req = {};
      create.publish({ request: req });
      t += d;
      sendHeaders.publish({ request: req, headers: '', socket: {} });
    }
    // sendHeaders for a request never seen at create is ignored.
    sendHeaders.publish({ request: {}, headers: '', socket: {} });

    let snap = getQueueTimeSnapshot();
    expect(snap.count).toBe(10);
    // sorted: 1 2 3 4 5 8 10 20 30 40 -> rank 5 = 5, rank 9 = 30
    expect(snap.p50Ms).toBe(5);
    expect(snap.p90Ms).toBe(30);
    expect(snap.p50Ms).toBeLessThanOrEqual(snap.p90Ms);
    stopQueueTimeCollector();

    // Real part: an undici request over loopback publishes both channels.
    startQueueTimeCollector();
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const agent = new Agent({ allowH2: false });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await undiciRequest(`http://127.0.0.1:${port}/`, { dispatcher: agent });
      expect(await res.body.text()).toBe('ok');
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    snap = getQueueTimeSnapshot();
    expect(snap.count).toBe(1);
    expect(snap.p50Ms).toBeGreaterThanOrEqual(0);
    expect(snap.p50Ms).toBeLessThanOrEqual(snap.p90Ms);
  });

  it('is idempotent on start and unsubscribes on stop', () => {
    expect(create.hasSubscribers).toBe(false);
    expect(sendHeaders.hasSubscribers).toBe(false);

    let t = 0;
    startQueueTimeCollector({ now: () => t });
    startQueueTimeCollector({ now: () => t });
    expect(isQueueTimeCollectorRunning()).toBe(true);
    const req = {};
    create.publish({ request: req });
    t += 7;
    sendHeaders.publish({ request: req });
    // A double subscription would have recorded twice.
    expect(getQueueTimeSnapshot().count).toBe(1);

    stopQueueTimeCollector();
    expect(isQueueTimeCollectorRunning()).toBe(false);
    expect(create.hasSubscribers).toBe(false);
    expect(sendHeaders.hasSubscribers).toBe(false);
    expect(getQueueTimeSnapshot()).toEqual({ count: 0, p50Ms: 0, p90Ms: 0 });
    // Safe to stop twice.
    stopQueueTimeCollector();
  });

  it('computes nearest-rank percentiles on a hand-counted list', () => {
    expect(nearestRankPercentile([], 50)).toBe(0);
    expect(nearestRankPercentile([7], 90)).toBe(7);
    // n=4: p50 rank ceil(2)=2 -> 20; p90 rank ceil(3.6)=4 -> 40
    expect(nearestRankPercentile([40, 10, 30, 20], 50)).toBe(20);
    expect(nearestRankPercentile([40, 10, 30, 20], 90)).toBe(40);
    // n=5: p50 rank ceil(2.5)=3 -> 3; p90 rank ceil(4.5)=5 -> 5; p0 clamps to rank 1
    expect(nearestRankPercentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(nearestRankPercentile([5, 1, 4, 2, 3], 90)).toBe(5);
    expect(nearestRankPercentile([5, 1, 4, 2, 3], 0)).toBe(1);
  });
});
