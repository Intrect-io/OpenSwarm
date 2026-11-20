// ============================================
// OpenSwarm — the daemon's local API token
// ============================================
//
// Loopback used to be enough to call the daemon's mutating API: a request
// from 127.0.0.1 with no Origin header was treated as the operator. A worker's
// sandboxed shell is also on loopback (macOS: the sandbox profile cannot allow
// localhost:* and exclude one port), so `curl -X POST 127.0.0.1:3847/api/exec`
// from inside a worker started unfenced work with the daemon's privileges.
// (AGT-4814)
//
// Every mutation now needs a token, loopback included. The daemon takes it
// from OPENSWARM_WEB_TOKEN when the operator set one; otherwise it creates one
// at start and keeps it in a 0600 file inside a 0700 directory of its own.
// That directory is hidden inside the worker sandbox (support/osSandbox.ts),
// so the operator's CLI, TUI and desktop shell can read the token and a
// worker cannot.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory that holds only the token, so the sandbox can hide it whole. */
export function daemonTokenDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  // OPENSWARM_DAEMON_TOKEN_DIR: tests point it at a per-worker temp dir so a
  // test that boots the service never writes the operator's real token.
  const override = env.OPENSWARM_DAEMON_TOKEN_DIR?.trim();
  if (override) return override;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(configHome, 'openswarm', 'daemon');
}

export function daemonTokenPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(daemonTokenDir(env, home), 'token');
}

let generatedToken: string | null = null;

/** The token the server accepts right now, or null when none is set up. */
export function activeDaemonToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENSWARM_WEB_TOKEN?.trim() || generatedToken;
}

/** Test seam: set (or clear) the token the server accepts without touching disk. */
export function setActiveDaemonTokenForTesting(token: string | null): void {
  generatedToken = token;
}

/**
 * The token file's content when it is private to this user: a regular file,
 * mode 0600, owned by us, in a directory only we can enter. Anything else is
 * refused (null) — a token others can read is a token they hold.
 */
export function readPrivateTokenFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
    const token = readFileSync(fd, 'utf8').trim();
    return token.length > 0 ? token : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Called once at daemon start. Uses OPENSWARM_WEB_TOKEN when set; otherwise
 * reuses the token file, or creates it (32 random bytes, hex). Returns where
 * the token came from, for the boot log — never the token itself.
 */
export function ensureDaemonToken(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { source: 'env' | 'file' | 'created'; path: string } {
  const path = daemonTokenPath(env, home);
  if (env.OPENSWARM_WEB_TOKEN?.trim()) return { source: 'env', path };

  const dir = daemonTokenDir(env, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(dir);
  if (!dirInfo.isDirectory()) throw new Error(`${dir} is not a directory; refusing to keep the daemon token there`);
  if ((dirInfo.mode & 0o077) !== 0) chmodSync(dir, 0o700);

  const existing = readPrivateTokenFile(path);
  if (existing) {
    generatedToken = existing;
    return { source: 'file', path };
  }

  const token = randomBytes(32).toString('hex');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  generatedToken = token;
  return { source: 'created', path };
}

/**
 * The token a client (CLI, TUI) sends: OPENSWARM_DAEMON_TOKEN for a remote
 * daemon, OPENSWARM_WEB_TOKEN when the operator set one, else the local file.
 */
export function readClientDaemonToken(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  return env.OPENSWARM_DAEMON_TOKEN?.trim()
    || env.OPENSWARM_WEB_TOKEN?.trim()
    || readPrivateTokenFile(daemonTokenPath(env, home));
}
