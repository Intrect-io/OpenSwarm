// ============================================
// OpenSwarm - Daemon (detached start/stop/status)
// ============================================
//
// `openswarm start` spawns a detached child that runs the full service (index.js
// → startService), redirects stdout/stderr to a log file, writes a PID file,
// and exits the parent. `openswarm stop` reads the PID file and sends SIGTERM.
// `openswarm status` reports running/stopped plus port 3847 health.

import { spawn, execFile, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../support/fileLock.js';

const STATE_DIR = join(homedir(), '.config', 'openswarm');
const LOG_DIR = join(STATE_DIR, 'logs');
const PID_FILE = join(STATE_DIR, 'openswarm.pid');
const LOG_FILE = join(LOG_DIR, 'openswarm.log');
const START_LOCK_FILE = join(STATE_DIR, 'openswarm.start.lock');
const DAEMON_PORT = 3847;
/** launchd service label the install script (scripts/install-service.sh) bootstraps. */
const LAUNCHD_LABEL = 'com.intrect.openswarm';

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptimeSeconds?: number;
  pidFile: string;
  logFile: string;
  /** True when no PID file matched but the daemon API answered — a launchd-managed or manually started instance. */
  external?: boolean;
}

function ensureStateDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOwnedDaemonProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const command = process.platform === 'win32'
      ? execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'], { encoding: 'utf8', timeout: 2_000 })
      : execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000 });
    return command.includes(resolveIndexPath());
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Probe the daemon's HTTP API directly. The PID file only tracks daemons
 * spawned by `openswarm start` — a launchd-managed (or manually run) instance
 * never writes it, so PID-file-only detection reports "not running" while a
 * daemon is actively serving. That mis-detection made the TUI auto-start spawn
 * a SECOND daemon working the same Linear queue in parallel (INT-2473).
 * The port answers for any daemon regardless of how it was started.
 */
export async function probeDaemonPort(port = DAEMON_PORT, timeoutMs = 800): Promise<boolean> {
  try {
    // Deliberately loopback, not daemonBaseUrl(): this asks whether THIS
    // machine's port is already taken, so that start/stop does not spawn a
    // second daemon on the same queue. Routing it through
    // OPENSWARM_DAEMON_HOST would answer about a different machine and let
    // exactly that happen.
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to dist/index.js. daemon.js lives at dist/cli/daemon.js,
 * so index.js is one level up.
 */
function resolveIndexPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'index.js');
}

function closeFdQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* ignore */ }
}

/**
 * Start the service as a detached background process.
 * Returns the child PID on success.
 * Throws if a daemon is already running (PID file OR port 3847 responding).
 *
 * The existing-pid check, port probe, spawn, and pidfile write are a single
 * critical section: two `openswarm start` invocations racing through it
 * unlocked can both pass the "nothing running yet" checks and each spawn a
 * daemon on the same task queue. A short-lived file lock serializes them —
 * the second invocation sees the first one's fresh PID file/port and fails
 * with the normal "already running" error instead of racing it.
 */
export async function startDaemon(): Promise<{ pid: number; logFile: string }> {
  ensureStateDirs();
  return withFileLock(START_LOCK_FILE, startDaemonLocked, { timeoutMs: 5_000 });
}

async function startDaemonLocked(): Promise<{ pid: number; logFile: string }> {
  const existing = readPidFile();
  if (existing !== null && isOwnedDaemonProcess(existing)) {
    throw new Error(
      `OpenSwarm is already running (pid ${existing}). ` +
      `Run 'openswarm stop' first or 'openswarm status' to check.`
    );
  }
  if (existing !== null) {
    // Stale or reused PID: never treat/terminate an unrelated live process as
    // OpenSwarm merely because its numeric PID matches an old file.
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // No PID file, but the API may still be live: a launchd-managed or manually
  // started daemon. Spawning another would double-process the same task queue.
  if (await probeDaemonPort()) {
    throw new Error(
      `OpenSwarm is already serving port ${DAEMON_PORT} (externally managed — e.g. launchd). ` +
      `Not spawning a duplicate. Use 'launchctl kickstart -k gui/$UID/com.intrect.openswarm' to restart it.`
    );
  }

  const indexPath = resolveIndexPath();
  if (!existsSync(indexPath)) {
    throw new Error(`Service entrypoint not found: ${indexPath}`);
  }

  // Open log file for append; reuse the same fd for stdout and stderr so logs
  // are interleaved in order.
  const logFd = openSync(LOG_FILE, 'a');

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [indexPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // Run from the user's home so relative paths in the service don't depend
      // on the shell that invoked `openswarm start`.
      cwd: homedir(),
      env: { ...process.env, OPENSWARM_DAEMON: '1' },
    });
  } catch (err) {
    closeFdQuietly(logFd);
    throw err;
  }

  if (child.pid === undefined) {
    closeFdQuietly(logFd);
    throw new Error('Failed to spawn daemon process (no pid assigned).');
  }

  closeFdQuietly(logFd);
  writeFileSync(PID_FILE, String(child.pid), { mode: 0o644 });

  // Let the child outlive this process.
  child.unref();

  return { pid: child.pid, logFile: LOG_FILE };
}

/**
 * Signal the running daemon to shut down. Returns false if no daemon is running.
 * Waits up to `timeoutMs` for the process to exit; returns true once it does,
 * or throws if it's still alive after the timeout.
 */
export async function stopDaemon(timeoutMs = 10_000): Promise<boolean> {
  const pid = readPidFile();
  if (pid === null) return false;

  if (!isOwnedDaemonProcess(pid)) {
    // Stale pid file.
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new Error(`Failed to signal pid ${pid}: ${(err as Error).message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(
    `Daemon (pid ${pid}) did not exit within ${timeoutMs}ms. ` +
    `It may still be shutting down; retry 'openswarm status' shortly or send SIGKILL manually.`
  );
}

/** Outcome of trying to stop a launchd-managed daemon via `launchctl bootout`. */
export interface ExternalStopResult {
  /**
   * - 'stopped'      — booted out and the API port went quiet.
   * - 'not-managed'  — launchctl has no job under our label; the running daemon
   *                    was started some other way (e.g. `node dist/index.js`).
   * - 'unsupported'  — not macOS, so launchctl can't be driven.
   * - 'failed'       — bootout errored, or the port kept answering past the timeout.
   */
  outcome: 'stopped' | 'not-managed' | 'unsupported' | 'failed';
  detail?: string;
}

/** Run `launchctl <args>`, resolving the exit code and stderr instead of throwing. */
function runLaunchctl(args: string[], timeoutMs = 5000): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      const errCode = (err as { code?: unknown } | null)?.code;
      resolve({
        ok: !err,
        code: typeof errCode === 'number' ? errCode : null,
        stderr: (stderr ?? '').toString().trim(),
      });
    });
  });
}

/**
 * Stop a launchd-managed daemon (no PID file) by booting its job out of the
 * user's GUI domain. This is the counterpart of the `launchctl bootstrap` the
 * install script runs.
 *
 * `bootout` (not `stop`/`kill`) because the plist's KeepAlive is `Crashed: true`:
 * a `launchctl stop` that ends in a non-zero exit would be respawned, whereas
 * booting the job out unloads it so it can't come back until the plist is
 * re-bootstrapped (at next login, since it lives in ~/Library/LaunchAgents).
 * The daemon handles SIGTERM with a graceful shutdown (src/index.ts), which is
 * exactly the signal bootout delivers.
 *
 * Callers should only reach here after `stopDaemon()` returned false AND
 * `probeDaemonPort()` confirmed a daemon is actually serving.
 */
export async function stopExternalDaemon(timeoutMs = 10_000): Promise<ExternalStopResult> {
  if (process.platform !== 'darwin') {
    return { outcome: 'unsupported', detail: `launchctl is macOS-only (platform: ${process.platform})` };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) {
    return { outcome: 'unsupported', detail: 'could not resolve current uid' };
  }

  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const res = await runLaunchctl(['bootout', target]);

  if (!res.ok) {
    // bootout exits 3 / "No such process" when our label isn't loaded — the
    // running daemon isn't this launchd job, so there's nothing for us to unload.
    if (res.code === 3 || /no such process|could not find/i.test(res.stderr)) {
      return { outcome: 'not-managed', detail: res.stderr || 'launchctl reported no such service' };
    }
    return { outcome: 'failed', detail: res.stderr || `launchctl bootout exited ${res.code}` };
  }

  // launchctl returns before the process has fully exited, so wait for the API
  // port to stop answering before declaring the daemon dead.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeDaemonPort())) return { outcome: 'stopped' };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { outcome: 'failed', detail: `daemon still answering port ${DAEMON_PORT} after ${timeoutMs}ms` };
}

/**
 * Read the last `lines` lines of the daemon log. Used by `openswarm start` to
 * show why the daemon exited when it dies during startup.
 */
export function readLogTail(lines = 20): string {
  if (!Number.isSafeInteger(lines) || lines <= 0) return '';
  let fd: number | null = null;
  try {
    fd = openSync(LOG_FILE, 'r');
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    const blockSize = 64 * 1024;
    let position = size;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= lines) {
      const length = Math.min(blockSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 0x0a) newlineCount++;
    }
    const content = Buffer.concat(chunks).toString('utf8').trimEnd();
    return content ? content.split('\n').slice(-lines).join('\n') : '';
  } catch {
    return '(log file unavailable)';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function getDaemonStatus(): DaemonStatus {
  const pid = readPidFile();
  if (pid === null || !isOwnedDaemonProcess(pid)) {
    return { running: false, pidFile: PID_FILE, logFile: LOG_FILE };
  }

  let uptimeSeconds: number | undefined;
  try {
    const stat = statSync(PID_FILE);
    uptimeSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
  } catch { /* ignore */ }

  return { running: true, pid, uptimeSeconds, pidFile: PID_FILE, logFile: LOG_FILE };
}

/**
 * Like getDaemonStatus, but also detects daemons the PID file can't see
 * (launchd-managed / manually started) by probing the API port. Prefer this
 * anywhere the answer gates spawning a new daemon.
 */
export async function getDaemonStatusFull(): Promise<DaemonStatus> {
  const base = getDaemonStatus();
  if (base.running) return base;
  if (await probeDaemonPort()) {
    return { running: true, external: true, pidFile: PID_FILE, logFile: LOG_FILE };
  }
  return base;
}

export const DAEMON_PATHS = { STATE_DIR, LOG_DIR, PID_FILE, LOG_FILE } as const;
export { LAUNCHD_LABEL, DAEMON_PORT };
