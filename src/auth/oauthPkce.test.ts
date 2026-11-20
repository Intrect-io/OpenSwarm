import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackRemote, runOAuthPkceFlow } from './oauthPkce.js';

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

/**
 * The OpenAI redirect_uri is always the advertised localhost form. Callbacks may
 * still arrive over IPv4 127.0.0.1 or IPv6 ::1, and Node reports an IPv4 client
 * on a dual-stack socket in the IPv4-mapped form.
 */
describe('isLoopbackRemote (OpenAI PKCE callback)', () => {
  it('accepts the IPv4 and IPv6 loopback remotes Node reports', () => {
    expect(isLoopbackRemote('127.0.0.1')).toBe(true);
    expect(isLoopbackRemote('::1')).toBe(true);
    expect(isLoopbackRemote('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback remotes that must never drive the callback', () => {
    expect(isLoopbackRemote(undefined)).toBe(false);
    expect(isLoopbackRemote('')).toBe(false);
    expect(isLoopbackRemote('10.0.0.1')).toBe(false);
    expect(isLoopbackRemote('192.168.1.1')).toBe(false);
    expect(isLoopbackRemote('8.8.8.8')).toBe(false);
    expect(isLoopbackRemote('fe80::1')).toBe(false);
    expect(isLoopbackRemote('2001:db8::1')).toBe(false);
    // A mapped non-loopback address is still a remote host.
    expect(isLoopbackRemote('::ffff:10.0.0.1')).toBe(false);
  });
});

describe('runOAuthPkceFlow callback listener (AGT-3467)', () => {
  it('binds the PKCE callback listener to 127.0.0.1 only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { host, address } = await captureListen(() => runOAuthPkceFlow({ port: 0, timeoutMs: 5_000 }));
    expect(host).toBe('127.0.0.1');
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });
});
