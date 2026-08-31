// ============================================
// OpenSwarm - Daemon HTTP endpoint resolution
// ============================================
//
// One place to decide which daemon a CLI command talks to. Three callers had
// grown their own copy of `http://127.0.0.1:${port}` (attachHandler.ts,
// providerCommand.ts, promptHandler.ts), which made the daemon unreachable
// from another machine without an SSH tunnel and meant a fix had to be made
// three times.
//
// The default stays loopback on purpose: `OPENSWARM_DAEMON_HOST` sends
// coordination traffic — operator answers, attachment bytes — off this
// machine, so it is opt-in and the value is validated rather than pasted into
// a template literal.

/** Where the daemon lives when nothing overrides it. */
export const DEFAULT_DAEMON_HOST = '127.0.0.1';

/** Env var naming the host to reach instead of loopback. */
export const DAEMON_HOST_ENV = 'OPENSWARM_DAEMON_HOST';

export class InvalidDaemonHostError extends Error {
  constructor(value: string, reason: string) {
    super(`${DAEMON_HOST_ENV}=${JSON.stringify(value)} is not a bare host (${reason}). `
      + 'Pass a hostname or IP only — no scheme, port, or path (e.g. "vela" or "100.95.200.28").');
    this.name = 'InvalidDaemonHostError';
  }
}

/**
 * The host portion of every daemon URL.
 *
 * Throws rather than falling back to loopback: an operator who set this
 * deliberately would otherwise have their message delivered to the wrong
 * daemon — silently, and to a board that looks plausible.
 */
export function daemonHost(raw: string | undefined = process.env[DAEMON_HOST_ENV]): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_DAEMON_HOST;

  // Checked before parsing because URL tolerates some of these by encoding
  // them, which would hand back a host that is not the one that was written.
  // Scheme first: `http://vela` also trips the separator check, and "includes
  // a scheme" is the message that tells the operator what to delete.
  if (value.includes('://')) throw new InvalidDaemonHostError(value, 'includes a scheme');
  if (/[\s/?#@\\]/.test(value)) throw new InvalidDaemonHostError(value, 'contains a separator or whitespace');

  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new InvalidDaemonHostError(value, 'is not a parseable host');
  }
  if (parsed.port !== '') throw new InvalidDaemonHostError(value, 'includes a port');
  // Round-trip: anything URL normalised away was not a bare host to begin with.
  if (parsed.hostname !== value.toLowerCase()) {
    throw new InvalidDaemonHostError(value, 'is not a bare host');
  }
  return parsed.hostname;
}

/** Env var holding the daemon's OPENSWARM_WEB_TOKEN, for a secured daemon. */
export const DAEMON_TOKEN_ENV = 'OPENSWARM_DAEMON_TOKEN';

/**
 * Auth headers for a daemon request.
 *
 * web.ts authorises a request that carries a valid token, OR comes from
 * loopback, OR comes over trusted Tailscale. A remote CLI has only the first
 * of those unless the operator turned on OPENSWARM_TRUST_TAILSCALE, so without
 * this a daemon secured with OPENSWARM_WEB_TOKEN refuses every remote command
 * — exactly the deployment that most wants one. The daemon accepts this header
 * or `Authorization: Bearer`; the bare header avoids its parsing entirely.
 */
export function daemonAuthHeaders(): Record<string, string> {
  const token = process.env[DAEMON_TOKEN_ENV]?.trim();
  return token ? { 'x-openswarm-token': token } : {};
}

/** True when a non-blank token is configured. */
function hasDaemonToken(): boolean {
  return Boolean(process.env[DAEMON_TOKEN_ENV]?.trim());
}

/** Env var selecting https for a daemon behind TLS or a reverse proxy. */
export const DAEMON_SCHEME_ENV = 'OPENSWARM_DAEMON_SCHEME';

/** Env var acknowledging that a token will cross the network in the clear. */
export const ALLOW_PLAINTEXT_TOKEN_ENV = 'OPENSWARM_DAEMON_ALLOW_PLAINTEXT_TOKEN';

/** `http` (default, matching the daemon's own listener) or `https`. */
export function daemonScheme(raw: string | undefined = process.env[DAEMON_SCHEME_ENV]): 'http' | 'https' {
  const value = raw?.trim().toLowerCase().replace(/:$/, '');
  if (!value) return 'http';
  if (value !== 'http' && value !== 'https') {
    throw new Error(`${DAEMON_SCHEME_ENV}=${JSON.stringify(raw)} must be "http" or "https".`);
  }
  return value;
}

/**
 * Base URL for a daemon request, e.g. `http://127.0.0.1:3847`.
 *
 * Sending the token to a remote host over http puts a bearer-equivalent
 * credential — and the coordination content around it — on the wire in the
 * clear. Loopback never leaves the machine, so it is exempt; anything else has
 * to either use https or say plainly that the network is already trusted (a
 * WireGuard/Tailscale link, typically). Caught by `openswarm pr review`.
 */
export function daemonBaseUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Daemon port must be an integer between 1 and 65535, got ${port}`);
  }
  const scheme = daemonScheme();
  const host = daemonHost();
  if (scheme === 'http' && isRemoteDaemon() && hasDaemonToken()
      && process.env[ALLOW_PLAINTEXT_TOKEN_ENV]?.trim() !== 'true') {
    throw new Error(`Refusing to send ${DAEMON_TOKEN_ENV} to ${host} over plaintext http. `
      + `Set ${DAEMON_SCHEME_ENV}=https, or ${ALLOW_PLAINTEXT_TOKEN_ENV}=true if the link is `
      + 'already encrypted (e.g. Tailscale/WireGuard).');
  }
  return `${scheme}://${host}:${port}`;
}

/**
 * Loopback spelled every way an operator plausibly would. `isRemoteDaemon`
 * gates behaviour that only makes sense on this machine (auto-starting the
 * daemon), so `localhost` has to count as local or `openswarm exec` refuses to
 * start a daemon it could perfectly well start.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);

/** True when the configured host is not this machine. */
export function isRemoteDaemon(): boolean {
  return !LOOPBACK_HOSTS.has(daemonHost());
}
