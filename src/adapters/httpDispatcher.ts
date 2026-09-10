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
