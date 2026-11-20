import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenRouterPkceFlow } from './openrouterPkce.js';

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

describe('runOpenRouterPkceFlow callback listener (AGT-3467)', () => {
  it('binds the OpenRouter PKCE callback listener to 127.0.0.1 only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { host, address } = await captureListen(() => runOpenRouterPkceFlow({ port: 0 }));
    expect(host).toBe('127.0.0.1');
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });
});
