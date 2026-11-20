// ============================================
// OpenSwarm - Daemon web port resolution
// ============================================
//
// The daemon serves its dashboard and API on one TCP port, and every CLI
// command that talks to "the" daemon has to agree on it. 3847 used to be
// written out at each site (service start, the duplicate-instance probe, the
// CLI clients), so a second daemon — the standalone bundle's smoke check, a
// test instance next to the operator's — could not run without colliding with
// the first one's port and its duplicate-instance refusal.
//
// OPENSWARM_WEB_PORT moves all of them together. Unset keeps 3847.

/** The port the daemon has always used; still the default. */
export const DEFAULT_DAEMON_PORT = 3847;

/** Env var that moves the daemon (and every client of it) to another port. */
export const DAEMON_PORT_ENV = 'OPENSWARM_WEB_PORT';

export class InvalidDaemonPortError extends Error {
  constructor(value: string) {
    super(`${DAEMON_PORT_ENV}=${JSON.stringify(value)} is not a TCP port. `
      + 'Use a whole number from 1 to 65535, or unset it for the default 3847.');
    this.name = 'InvalidDaemonPortError';
  }
}

/**
 * The daemon's port from the given environment.
 *
 * Throws instead of falling back to 3847: an operator who moved the daemon on
 * purpose would otherwise have a command land on a different daemon (or have
 * a second daemon refuse to start because the default port is taken).
 */
export function daemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DAEMON_PORT_ENV];
  const value = raw?.trim();
  if (!value) return DEFAULT_DAEMON_PORT;
  if (!/^\d{1,5}$/.test(value)) throw new InvalidDaemonPortError(raw ?? '');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new InvalidDaemonPortError(raw ?? '');
  return port;
}
