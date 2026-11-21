// ============================================
// OpenSwarm — one HTTP/1.1 connection per in-flight adapter request
// ============================================
//
// Node's global fetch negotiates h2 with these origins, and undici then carries
// several concurrent requests as streams over a couple of connections. The
// server admits only a few concurrent streams per connection, so with N agents
// in one process a request sits in undici waiting for a stream slot: measured
// on codex-responses at concurrency 4, `create -> sendHeaders` was 17.30s
// median while the server itself answered in 1.07s. Splitting the same work
// across four processes was fast purely because each got its own connection.
// (AGT-4220)
//
// That fix shipped for codex-responses alone. The daemon runs every HTTPS
// adapter the same way — in-process, dozens at a time — so the same stall
// reaches them: measured on vela 2026-09-10 with 48 active runs, one hour
// produced 50 `openrouter timeout after 90000ms` and 34 undici `fetch failed`
// while the endpoint answered a direct probe in 0.07s.
//
// undici's own `fetch` is required: a dispatcher built from the npm package is
// rejected by the copy bundled inside Node's global fetch (the same constraint
// as support/outboundUrl.ts).

import diagnosticsChannel from 'node:diagnostics_channel';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Shared across adapters on purpose. undici pools per ORIGIN, so one Agent
 * still gives each provider its own connection pool; a second Agent would only
 * add a second pool to the same origin and make the ceiling unpredictable.
 *
 * The bound is fixed at construction rather than passed per call: it is a
 * process-wide resource limit, and a caller that could raise it per request
 * would make the ceiling a function of whoever asked last.
 */
let dispatcher: Agent | undefined;

export function getAdapterDispatcher(): Agent {
  dispatcher ??= new Agent({ allowH2: false, connections: 64, pipelining: 1 });
  return dispatcher;
}

/** Tests need a fresh dispatcher rather than one carrying another test's pool. */
export function resetAdapterDispatcherForTests(): void {
  dispatcher = undefined;
}

/**
 * `fetch`, pinned to HTTP/1.1 with one connection per in-flight request.
 *
 * Drop-in for the global: same arguments, and undici's Response is
 * spec-compatible with the DOM one.
 */
export async function adapterFetch(
  url: string,
  init?: Parameters<typeof undiciFetch>[1],
): Promise<Response> {
  const res = await undiciFetch(url, { ...init, dispatcher: getAdapterDispatcher() });
  // undici's Response is spec-compatible with the global one; the DOM lib types
  // are structurally distinct. Cross that boundary HERE, once, so no adapter
  // has to carry a cast of its own — the same bridge support/outboundUrl.ts
  // makes.
  return res as unknown as Response;
}

// ============================================
// Queue-time collector (observe only)
// ============================================
//
// Measures the stall described above: the time a request waits inside undici
// between `undici:request:create` (Request constructed) and
// `undici:client:sendHeaders` (headers written to the socket). Channel names
// match undici 6.x lib/core/diagnostics.js. Only HTTP/1.1 requests produce
// samples: undici 6.x client-h2 never publishes sendHeaders, so requests sent
// over h2 (including global-fetch requests that negotiate h2) get a create
// event but are not counted.
//
// The collector never mutates the request; it keys start times by the request
// object in a WeakMap so an abandoned request leaks nothing. When not started
// no channel has a subscriber, and undici skips publishing entirely
// (`hasSubscribers` guard), so the cost is zero.

const CREATE_CHANNEL = 'undici:request:create';
const SEND_HEADERS_CHANNEL = 'undici:client:sendHeaders';
/** Ring-buffer bound so a long-lived daemon keeps a recent window, not all history. */
const MAX_QUEUE_SAMPLES = 10_000;

export interface QueueTimeSnapshot {
  /** Number of samples currently held (at most MAX_QUEUE_SAMPLES). */
  count: number;
  /** Nearest-rank p50 in ms; 0 when count is 0. */
  p50Ms: number;
  /** Nearest-rank p90 in ms; 0 when count is 0. */
  p90Ms: number;
}

interface QueueTimeCollectorState {
  now: () => number;
  createdAt: WeakMap<object, number>;
  samples: number[];
  next: number;
  onCreate: (message: unknown) => void;
  onSendHeaders: (message: unknown) => void;
}

let collector: QueueTimeCollectorState | undefined;

function requestOf(message: unknown): object | undefined {
  const req = (message as { request?: unknown } | null)?.request;
  return typeof req === 'object' && req !== null ? req : undefined;
}

/**
 * Start observing. A second call while running is a no-op (samples are kept).
 * `now` is injectable for tests; defaults to performance.now().
 */
export function startQueueTimeCollector(opts: { now?: () => number } = {}): void {
  if (collector) return;
  const state: QueueTimeCollectorState = {
    now: opts.now ?? (() => performance.now()),
    createdAt: new WeakMap(),
    samples: [],
    next: 0,
    onCreate: (message) => {
      const req = requestOf(message);
      if (req) state.createdAt.set(req, state.now());
    },
    onSendHeaders: (message) => {
      const req = requestOf(message);
      if (!req) return;
      const start = state.createdAt.get(req);
      if (start === undefined) return;
      state.createdAt.delete(req);
      const ms = Math.max(0, state.now() - start);
      if (state.samples.length < MAX_QUEUE_SAMPLES) state.samples.push(ms);
      else state.samples[state.next] = ms;
      state.next = (state.next + 1) % MAX_QUEUE_SAMPLES;
    },
  };
  diagnosticsChannel.subscribe(CREATE_CHANNEL, state.onCreate);
  diagnosticsChannel.subscribe(SEND_HEADERS_CHANNEL, state.onSendHeaders);
  collector = state;
}

/** Unsubscribe and drop all samples. Safe when not started. */
export function stopQueueTimeCollector(): void {
  if (!collector) return;
  diagnosticsChannel.unsubscribe(CREATE_CHANNEL, collector.onCreate);
  diagnosticsChannel.unsubscribe(SEND_HEADERS_CHANNEL, collector.onSendHeaders);
  collector = undefined;
}

export function isQueueTimeCollectorRunning(): boolean {
  return collector !== undefined;
}

/**
 * Nearest-rank percentile: sort ascending, take the value at 1-based rank
 * ceil(p/100 * n) (rank clamped to [1, n]). Always returns an observed value;
 * no interpolation. Returns 0 for an empty list.
 */
export function nearestRankPercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** Current count, p50 and p90 (nearest-rank, ms). Zeros when not started. */
export function getQueueTimeSnapshot(): QueueTimeSnapshot {
  const samples = collector?.samples ?? [];
  return {
    count: samples.length,
    p50Ms: nearestRankPercentile(samples, 50),
    p90Ms: nearestRankPercentile(samples, 90),
  };
}
