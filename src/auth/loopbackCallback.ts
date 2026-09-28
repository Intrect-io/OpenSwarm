// ============================================
// OpenSwarm - Loopback callback listener
// ============================================
//
// Every PKCE redirect URI in this directory is `http://localhost:<port>/...`,
// but `localhost` is a name, not an address: it resolves to ::1 as happily as
// to 127.0.0.1, and on macOS it resolves to ::1 first. A listener bound to
// 127.0.0.1 alone never sees the browser's callback on such a host — the
// connection is refused, the browser shows an error, and the flow sits on its
// 120s timeout with nothing server-side to explain why. Measured (macOS 15,
// node 26): a lone `listen(port, '127.0.0.1')` answers ::1 with ECONNREFUSED,
// and `listen(port, '::1')` — a host address, not the wildcard — answers
// 127.0.0.1 with ECONNREFUSED too, so neither family alone covers the name.
//
// Binding the IPv6 wildcard would absorb the name, but it accepts off-machine
// traffic too, and this callback carries a one-time authorization code. So the
// listener is bound once per loopback family instead: 127.0.0.1 and ::1 are
// host addresses, never wildcards, so nothing outside the machine can reach
// the callback on either. A family this host does not have is skipped; a port
// already held, or no family at all, is reported.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface LoopbackCallbackListener {
  /** Close every socket the listener bound. Safe to call more than once. */
  close(): void;
}

/** Loopback addresses to bind, IPv4 first so the log line reads as it did. */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

/** Bind codes that mean "this host has no loopback address of that family". */
const NO_SUCH_FAMILY: Record<string, true> = {
  EADDRNOTAVAIL: true,
  EAFNOSUPPORT: true,
};

/**
 * Bind `handler` to the loopback address of every available family on `port`.
 *
 * `onListening` runs once, after every family that can be bound is listening,
 * so the caller may open the browser knowing the callback will be accepted on
 * whichever address the name resolves to. `onError` runs once for the first
 * bind failure — including a port already held, which must not be mistaken for
 * a working listener — and everything bound so far is closed.
 */
export function listenOnLoopback(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  onListening: () => void,
  onError: (error: Error) => void,
): LoopbackCallbackListener {
  const servers = LOOPBACK_HOSTS.map(() => createServer(handler));
  let pending = servers.length;
  let bound = 0;
  let failed = false;
  let lastError: NodeJS.ErrnoException | undefined;

  const close = (): void => {
    for (const server of servers) server.close();
  };

  const fail = (error: Error): void => {
    failed = true;
    close();
    onError(error);
  };

  const settled = (): void => {
    pending -= 1;
    if (failed || pending > 0) return;
    // Nothing could be bound: with no listener the callback can never arrive, so
    // this is an error rather than a listen that silently never completes.
    if (bound === 0) fail(lastError ?? new Error(`No loopback address available on port ${port}`));
    else onListening();
  };

  for (const [family, host] of LOOPBACK_HOSTS.entries()) {
    const server = servers[family];
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (failed) return;
      // An IPv6-disabled host still completes the flow over IPv4.
      if (NO_SUCH_FAMILY[error.code ?? '']) {
        lastError = error;
        settled();
        return;
      }
      fail(error);
    });
    server.listen(port, host, () => {
      // A sibling family may have failed while this bind was in flight. `close()`
      // is a no-op on a socket that had not started listening, so without this
      // the loser of that race would keep the port and hold the process open
      // after the flow has already failed.
      if (failed) {
        server.close();
        return;
      }
      bound += 1;
      settled();
    });
  }

  return { close };
}
