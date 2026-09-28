// ============================================
// OpenSwarm - Loopback callback listener
// ============================================
//
// The two OAuth flows cover this end to end; these cases pin the contract the
// flows depend on — both loopback families answer on one port, an unavailable
// family is tolerated, and a port already in use is reported instead of being
// mistaken for a working listener. (AGT-3432)

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { listenOnLoopback } from './loopbackCallback.js';

const handler = (_req: unknown, res: { end: (body: string) => void }): void => res.end('callback');

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

/** Whether this host has an IPv6 loopback at all. */
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/** An available port, released so the listener under test can take it. */
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

const listen = async (port: number): Promise<{ listener: { close: () => void }; listening: boolean; errors: Error[] }> => {
  let listening = false;
  const errors: Error[] = [];
  const listener = listenOnLoopback(port, handler, () => { listening = true; }, (error) => errors.push(error));
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (listening || errors.length > 0) resolve();
      else setImmediate(check);
    };
    check();
  });
  return { listener, listening, errors };
};

const hasIpv6Loopback = await ipv6LoopbackAvailable();
let live: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const listener of live) listener.close();
  live = [];
});

describe('listenOnLoopback', () => {
  it('answers on both loopback families from the one port', async () => {
    const port = await freePort();
    const { listener, listening, errors } = await listen(port);
    live.push(listener);

    expect(errors).toEqual([]);
    expect(listening).toBe(true);
    expect(await connects(port, '127.0.0.1')).toBe(true);
    if (hasIpv6Loopback) expect(await connects(port, '::1')).toBe(true);
  });

  it('serves the handler over either family', async () => {
    const port = await freePort();
    const { listener } = await listen(port);
    live.push(listener);

    await expect(fetch(`http://127.0.0.1:${port}/callback`).then((r) => r.text())).resolves.toBe('callback');
    if (hasIpv6Loopback) {
      await expect(fetch(`http://[::1]:${port}/callback`).then((r) => r.text())).resolves.toBe('callback');
    }
  });

  it('reports a port that is already held instead of listening silently', async () => {
    const port = await freePort();
    const squatter: Server = createServer(handler);
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));
    const { listener, listening, errors } = await listen(port);
    live.push(listener);

    expect(listening).toBe(false);
    expect(errors).toHaveLength(1);
    expect((errors[0] as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });

  it('closes every family it bound, and tolerates a repeat close', async () => {
    const port = await freePort();
    const { listener } = await listen(port);
    live.push(listener);

    listener.close();
    listener.close();
    // Give the close callbacks a turn before probing the port.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await connects(port, '127.0.0.1')).toBe(false);
    if (hasIpv6Loopback) expect(await connects(port, '::1')).toBe(false);
  });
});
