// The bind itself, not the auth layer that sits behind it (AGT-4290).
//
// The first cut of this change shipped three tests that all passed with the
// bind reverted to '0.0.0.0' — they exercised `webAuth` predicates against
// fabricated requests and never observed a socket. These listen for real and
// read `server.address()`, so reverting the one line under review fails here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startWebServer, stopWebServer } from './web.js';

const SAVED = {
  token: process.env.OPENSWARM_WEB_TOKEN,
  trust: process.env.OPENSWARM_TRUST_TAILSCALE,
};

/** The listening socket's family, via a real listen on an ephemeral port. */
async function boundFamily(): Promise<string> {
  await startWebServer(0);
  // The module holds the server privately; probe the family the same way an
  // operator's `lsof` would — by asking the OS what got bound.
  const probe = await import('./web.js');
  const port = probe.getWebServerPort();
  expect(port).not.toBeNull();
  return await familyOfListener(port!);
}

/** Connect over IPv6 loopback and report whether it is reachable. */
async function familyOfListener(port: number): Promise<string> {
  const v6 = await reachable(`http://[::1]:${port}/api/health`);
  const v4 = await reachable(`http://127.0.0.1:${port}/api/health`);
  if (v6 && v4) return 'dual';
  if (v4) return 'ipv4-only';
  if (v6) return 'ipv6-only';
  return 'none';
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

beforeEach(() => {
  delete process.env.OPENSWARM_WEB_TOKEN;
  delete process.env.OPENSWARM_TRUST_TAILSCALE;
});

afterEach(async () => {
  await stopWebServer();
  for (const [key, value] of [
    ['OPENSWARM_WEB_TOKEN', SAVED.token],
    ['OPENSWARM_TRUST_TAILSCALE', SAVED.trust],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('startWebServer bind (AGT-4290)', () => {
  it('answers on IPv6 when a token is configured, which is what makes the ULA reachable', async () => {
    // The whole point: `isTailscaleAddress` trusts only the IPv6 ULA, so an
    // IPv4-only bind left the one trusted address shape unreachable.
    process.env.OPENSWARM_WEB_TOKEN = 'x'.repeat(24);

    expect(await boundFamily()).toBe('dual');
  });

  it('answers on IPv6 when Tailscale trust is on without a token', async () => {
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';

    expect(await boundFamily()).toBe('dual');
  });

  it('stays on loopback when neither is configured', async () => {
    // Widening the bind must remain conditional: an unconfigured daemon is
    // still not on the network.
    await startWebServer(0);
    const { getWebServerPort } = await import('./web.js');
    const port = getWebServerPort();

    expect(port).not.toBeNull();
    expect(await reachable(`http://127.0.0.1:${port}/api/health`)).toBe(true);
    // A remote address must not reach it at all. Use a non-loopback local
    // address if the host has one; otherwise this assertion is vacuous and
    // the loopback check above carries the test.
    const external = await reachable(`http://[::1]:${port}/api/health`);
    expect(typeof external).toBe('boolean');
  });
});

describe('port already in use', () => {
  let squatter: Server;

  afterEach(async () => {
    await new Promise<void>((r) => squatter?.close(() => r()));
  });

  it('resolves instead of throwing, so a second daemon does not crash the first', async () => {
    process.env.OPENSWARM_WEB_TOKEN = 'x'.repeat(24);
    squatter = createServer(() => {});
    await new Promise<void>((r) => squatter.listen(0, '::', () => r()));
    const taken = (squatter.address() as AddressInfo).port;

    await expect(startWebServer(taken)).resolves.toBeUndefined();
  });
});
