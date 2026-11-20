import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidLinearCallback, parseLinearTokenResponse, runLinearPkceFlow } from './linearPkce.js';

const opened: string[] = [];
const servers: Server[] = [];
vi.mock('./openBrowser.js', () => ({
  openBrowser: (url: string) => {
    opened.push(url);
  },
}));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
  opened.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Runs the flow on an ephemeral port, captures the server it binds, then shuts it down. */
async function captureListen(start: () => Promise<unknown>): Promise<{ host: unknown; address: AddressInfo }> {
  const listenSpy = vi.spyOn(Server.prototype, 'listen');
  const flow = start();
  flow.catch(() => undefined);
  for (let i = 0; i < 400 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(opened.length).toBe(1);
  const server = listenSpy.mock.contexts[0] as Server;
  servers.push(server);
  const host = listenSpy.mock.calls[0][1];
  const address = server.address() as AddressInfo;
  // The flow's own error handler settles the promise and clears its login timer.
  server.emit('error', new Error('test shutdown'));
  await expect(flow).rejects.toThrow(/test shutdown/);
  return { host, address };
}

describe('parseLinearTokenResponse', () => {
  it('requires access, refresh, and a positive expiry', () => {
    expect(parseLinearTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })).toEqual({
      accessToken: 'a', refreshToken: 'r', expiresIn: 3600,
    });
    expect(() => parseLinearTokenResponse({ access_token: 'a', expires_in: 3600 })).toThrow(/refresh_token/);
    expect(() => parseLinearTokenResponse({ access_token: 'a', refresh_token: '', expires_in: 3600 })).toThrow(/refresh_token/);
    expect(() => parseLinearTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 0 })).toThrow(/expires_in/);
  });
});

describe('Linear callback validation', () => {
  it('requires matching state for both success and OAuth error callbacks', () => {
    expect(isValidLinearCallback('code', null, 'expected', 'expected')).toBe(true);
    expect(isValidLinearCallback(null, 'access_denied', 'expected', 'expected')).toBe(true);
    expect(isValidLinearCallback(null, 'access_denied', 'attacker', 'expected')).toBe(false);
    expect(isValidLinearCallback('code', null, null, 'expected')).toBe(false);
  });
});

describe('runLinearPkceFlow callback listener (AGT-3467)', () => {
  it('binds the Linear PKCE callback listener to 127.0.0.1 only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('LINEAR_OAUTH_CLIENT_ID', 'test-client');
    const { host, address } = await captureListen(() => runLinearPkceFlow({ port: 0 }));
    expect(host).toBe('127.0.0.1');
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });
});
