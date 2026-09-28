// ============================================
// OpenSwarm - OAuth PKCE callback delivery
// ============================================
//
// The redirect URI this flow advertises is `http://localhost:<port>/auth/callback`,
// so the browser connects to whatever `localhost` resolves to — and on macOS
// that is ::1 first. While the listener was bound to 127.0.0.1 alone, the
// browser's connection was refused, and the flow then sat on its 120s timeout
// with nothing server-side to explain it. These tests drive the real flow over
// the real loopback stack, on the address the name actually resolves to. (AGT-3432)
//
// `openBrowser` is mocked, but only as a signal: it is called from the
// listener's `onListening`, so a call means the port accepts callbacks, and its
// argument is the authorization URL the flow would have opened — which is where
// the random `state` comes from. The test never invents that state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { runOAuthPkceFlow } from './oauthPkce.js';
import { openBrowser } from './openBrowser.js';

vi.mock('./openBrowser.js', () => ({ openBrowser: vi.fn() }));

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const realFetch = globalThis.fetch;

/** A port with nothing bound to it, on either loopback family. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Whether this host has an IPv6 loopback at all; without one the bug cannot exist. */
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/**
 * An IPv4 address of this machine that is not loopback, or null when there is
 * none. IPv4 because an unreachable port is refused immediately there, where a
 * link-local IPv6 address would have to run out a timeout instead.
 */
function nonLoopbackIpv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && net.isIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

/** Whether a socket was accepted at `host:port`, without outliving the test. */
async function connects(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(2_000);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

/** Answer the token exchange, leaving every other request to the real fetch. */
function stubTokenExchange(): { bodies: URLSearchParams[] } {
  const bodies: URLSearchParams[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== TOKEN_ENDPOINT) return realFetch(input, init);
    bodies.push(new URLSearchParams(String(init?.body ?? '')));
    return new Response(
      JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return { bodies };
}

/**
 * Start the flow, wait until its listener is open, and hand back the flow plus
 * the callback path a browser would request on it.
 */
async function startFlow(port: number): Promise<{ flow: Promise<unknown>; callback: string }> {
  const flow = runOAuthPkceFlow({ port });
  // Handled from the start so a rejected flow (the state-mismatch case) is never
  // reported as an unhandled rejection between the callback and the assertion.
  // The assertion below still observes the real rejection.
  void flow.catch(() => {});
  await vi.waitFor(() => expect(openBrowser).toHaveBeenCalled());
  const authUrl = vi.mocked(openBrowser).mock.calls[0][0];
  const state = new URL(authUrl).searchParams.get('state');
  return { flow, callback: `/auth/callback?code=test-code&state=${state}` };
}

const hasIpv6Loopback = await ipv6LoopbackAvailable();
const nonLoopback = nonLoopbackIpv4();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('runOAuthPkceFlow callback delivery', () => {
  it.skipIf(!hasIpv6Loopback)('accepts the callback on the IPv6 loopback address localhost resolves to', async () => {
    const port = await freePort();
    const { bodies } = stubTokenExchange();
    const { flow, callback } = await startFlow(port);

    const response = await fetch(`http://[::1]:${port}${callback}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('인증 완료');
    await expect(flow).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
    });
    // The advertised redirect URI must stay `localhost` — the public Codex
    // client has that exact value registered and rejects 127.0.0.1 — so the
    // exchange has to be told the URI the callback was advertised under.
    expect(bodies[0].get('redirect_uri')).toBe(`http://localhost:${port}/auth/callback`);
  });

  it('accepts the callback on the IPv4 loopback address', async () => {
    const port = await freePort();
    stubTokenExchange();
    const { flow, callback } = await startFlow(port);

    const response = await fetch(`http://127.0.0.1:${port}${callback}`);

    expect(response.status).toBe(200);
    await expect(flow).resolves.toMatchObject({ accessToken: 'access-token' });
  });

  it.skipIf(!hasIpv6Loopback)('still rejects a callback whose state does not match', async () => {
    const port = await freePort();
    stubTokenExchange();
    const { flow } = await startFlow(port);

    const response = await fetch(`http://[::1]:${port}/auth/callback?code=test-code&state=attacker`);

    expect(response.status).toBe(400);
    await expect(flow).rejects.toThrow(/state mismatch/);
  });

  it.skipIf(!nonLoopback)('does not accept the callback from a non-loopback address', async () => {
    const port = await freePort();
    stubTokenExchange();
    const { flow, callback } = await startFlow(port);

    expect(await connects(port, nonLoopback as string)).toBe(false);

    // Settle the flow so its listener does not outlive the test.
    await fetch(`http://127.0.0.1:${port}${callback}`);
    await expect(flow).resolves.toMatchObject({ accessToken: 'access-token' });
  });
});
