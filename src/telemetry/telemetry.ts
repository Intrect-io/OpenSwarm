// ============================================
// OpenSwarm - Anonymous usage telemetry (opt-out)
// ============================================
//
// Why: npm download counts are bot/mirror noise and GitHub stars are a cumulative
// vanity metric — neither tells us how OpenSwarm is actually used. This sends a
// tiny anonymous event (command name, version, OS) so development can be guided by
// real usage. (INT-1992)
//
// Privacy contract (enforced by the payload shape below + telemetry.test.ts):
//   - NO code, prompts, file paths, repo names, issue content, env values, or PII.
//   - A random install id (nanoid) is the only identifier; it is local and anonymous.
//   - Opt out any time: OPENSWARM_TELEMETRY=0 / DO_NOT_TRACK=1 / config telemetry.enabled=false.
//   - CI environments are excluded automatically (they are not real users).
//   - Fire-and-forget: a telemetry failure must NEVER affect the CLI/daemon.

import os, { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { atomicWriteFileSync } from '../support/atomicFile.js';

const STATE_DIR = join(homedir(), '.config', 'openswarm');
const TELEMETRY_FILE = join(STATE_DIR, 'telemetry.json');
const TELEMETRY_LOCK = `${TELEMETRY_FILE}.lock`;
const TELEMETRY_LOCK_STALE_MS = 30_000;
const TELEMETRY_LOCK_WAIT_MS = 5;
const TELEMETRY_LOCK_TIMEOUT_MS = 5_000;

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

type TelemetryLockOwner = { pid: number; token: string };

function telemetryLockAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readTelemetryLockOwner(lockPath: string): TelemetryLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<TelemetryLockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? { pid: value.pid!, token: value.token }
      : null;
  } catch {
    return null;
  }
}

/**
 * Cross-process lock for telemetry state. Stale reclaim is ownership-safe:
 * after judging a lock dead/stale we re-check mtime+token before unlink so we
 * cannot remove a lock a different owner just acquired.
 */
function withTelemetryLock<T>(operation: () => T): T {
  mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + TELEMETRY_LOCK_TIMEOUT_MS;
  let lockFd: number | undefined;
  const lockToken = randomUUID();

  while (lockFd === undefined) {
    try {
      lockFd = openSync(TELEMETRY_LOCK, 'wx', 0o600);
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: lockToken }), 'utf8');
      fsyncSync(lockFd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const owner = readTelemetryLockOwner(TELEMETRY_LOCK);
        const judgedMtimeMs = statSync(TELEMETRY_LOCK).mtimeMs;
        const lockAgeMs = Date.now() - judgedMtimeMs;
        const staleMalformed = !owner && lockAgeMs > TELEMETRY_LOCK_STALE_MS;
        const abandoned = owner !== null && !telemetryLockAlive(owner.pid);
        if (staleMalformed || abandoned) {
          const currentMtimeMs = statSync(TELEMETRY_LOCK).mtimeMs;
          const currentOwner = readTelemetryLockOwner(TELEMETRY_LOCK);
          const sameLock = currentMtimeMs === judgedMtimeMs
            && currentOwner?.token === owner?.token;
          if (sameLock) unlinkSync(TELEMETRY_LOCK);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        // Best-effort telemetry must not hang the CLI — proceed unlocked.
        return operation();
      }
      Atomics.wait(lockWaitBuffer, 0, 0, TELEMETRY_LOCK_WAIT_MS);
    }
  }

  try {
    return operation();
  } finally {
    closeSync(lockFd);
    try {
      if (readTelemetryLockOwner(TELEMETRY_LOCK)?.token === lockToken) {
        unlinkSync(TELEMETRY_LOCK);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Non-fatal — next writer will reclaim if needed.
      }
    }
  }
}

// Collection endpoint (Cloudflare Worker → D1 intrect-telemetry.openswarm_events).
// Kept fixed in the client so a local environment variable cannot redirect even
// the deliberately minimal telemetry payload to an arbitrary host.
const DEFAULT_ENDPOINT = 'https://telemetry.intrect.io/v1/openswarm';
const SEND_TIMEOUT_MS = 2500;

interface TelemetryState {
  installId: string;
  noticeShown?: boolean;
}

function isValidInstallId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{21}$/.test(value);
}

// Set once from the CLI/daemon entry point so the module need not resolve
// package.json itself (its dist location is ambiguous).
let version = 'unknown';
// config telemetry.enabled=false hard-disables regardless of env.
let configDisabled = false;

/** Initialize from the entry point: inject version and the config opt-out flag. */
export function initTelemetry(opts: { version: string; enabled?: boolean }): void {
  version = opts.version;
  // Calls that only refresh the version must not undo an earlier config-level
  // opt-out. An explicit boolean remains authoritative (and keeps tests and
  // embedded callers able to reconfigure a long-lived process deliberately).
  if (opts.enabled !== undefined) configDisabled = !opts.enabled;
}

function readState(): TelemetryState | null {
  try {
    return JSON.parse(readFileSync(TELEMETRY_FILE, 'utf8')) as TelemetryState;
  } catch {
    return null;
  }
}

/**
 * Merge on-disk telemetry state with a caller-computed next state.
 * An id already on disk always wins so concurrent first-runs converge.
 * Writers acquire `withTelemetryLock` so stale reclaim cannot drop another
 * owner's lock between judgement and unlink.
 */
export function mergeState(
  current: TelemetryState | null,
  next: TelemetryState,
): TelemetryState {
  return {
    // An id already on disk always wins. Both callers build `next` from a read
    // that happened earlier, so without this the writer that lands second
    // replaces an id a concurrent first run had just persisted.
    installId: isValidInstallId(current?.installId) ? current.installId : next.installId,
    // Sticky: once the notice has been shown it must not be un-shown by a writer
    // that read the state before it was displayed.
    noticeShown: next.noticeShown || current?.noticeShown,
  };
}

/** Truthy env opt-out signals (OpenSwarm-specific + the cross-tool DO_NOT_TRACK). */
function envDisabled(): boolean {
  const v = (process.env.OPENSWARM_TELEMETRY ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return true;
  const dnt = (process.env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return true;
  // CI/automation are not real users — exclude so the signal stays clean.
  if (process.env.CI || process.env.GITHUB_ACTIONS) return true;
  return false;
}

export function isTelemetryEnabled(): boolean {
  return !configDisabled && !envDisabled();
}

function getInstallId(): string {
  return withTelemetryLock(() => {
    const state = readState();
    if (isValidInstallId(state?.installId)) return state.installId;
    const minted = nanoid();
    atomicWriteFileSync(
      TELEMETRY_FILE,
      JSON.stringify(mergeState(state, { installId: minted, noticeShown: state?.noticeShown }), null, 2),
    );
    const persisted = readState();
    return isValidInstallId(persisted?.installId) ? persisted.installId : minted;
  });
}

/**
 * Print the one-time opt-out notice (to stderr, so it never pollutes piped stdout).
 * Subsequent runs are silent. No-op when telemetry is disabled.
 */
export function maybeShowNotice(): void {
  if (!isTelemetryEnabled()) return;
  withTelemetryLock(() => {
    const state = readState();
    if (state?.noticeShown) return;
    process.stderr.write(
      '\nOpenSwarm collects anonymous usage data (command, version, OS) to guide development.\n' +
        'No code, prompts, paths, or personal data are sent. Opt out: OPENSWARM_TELEMETRY=0\n' +
        'Details: https://github.com/unohee/OpenSwarm#privacy--telemetry\n\n',
    );
    atomicWriteFileSync(
      TELEMETRY_FILE,
      JSON.stringify(
        mergeState(state, { installId: state?.installId ?? nanoid(), noticeShown: true }),
        null,
        2,
      ),
    );
  });
}

export interface TrackOptions {
  /** Subcommand name (run/start/chat/...) — NOT its arguments. */
  command?: string;
  /** Adapter family (codex/claude/...) — NOT a model or key. */
  adapter?: string;
  /** Whether the run ended in an error (boolean only). */
  isError?: boolean;
  /** Event kind; defaults to 'invoke'. */
  event?: string;
  /**
   * Names of failed diagnostic checks — from ALLOWED_DETAILS and nothing else.
   * Never a message, a path, or a value.
   */
  detail?: string[];
  /** How long the command ran, for completion events. */
  durationMs?: number;
}

/** The exact wire payload — kept flat and asserted by tests so PII can't creep in. */
export interface TelemetryPayload {
  installId: string;
  event: string;
  version: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  command?: string;
  adapter?: string;
  isError: 0 | 1;
  detail?: string;
  durationMs?: number;
}

/**
 * Rebuild the wire payload from the privacy allowlist immediately before
 * transport. This prevents future in-memory fields (including paths or source
 * text) from becoming telemetry merely because a caller extends an object.
 */
export function serializeTelemetryPayload(payload: TelemetryPayload): string {
  return JSON.stringify({
    installId: payload.installId,
    event: payload.event,
    version: payload.version,
    platform: payload.platform,
    arch: payload.arch,
    nodeVersion: payload.nodeVersion,
    ...(payload.command ? { command: payload.command } : {}),
    ...(payload.adapter ? { adapter: payload.adapter } : {}),
    isError: payload.isError,
    ...(payload.detail ? { detail: payload.detail } : {}),
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
  });
}

const ALLOWED_EVENTS = new Set(['invoke', 'complete', 'error', 'start', 'stop', 'engage']);

/**
 * Commands whose names may be recorded.
 *
 * This list silently discarded real usage once already. `allowTelemetryLabel`
 * returns undefined for anything absent, so the event still arrives with a NULL
 * command — the row survives and the fact it describes does not. When it landed
 * (2026-07-23) it was missing `openswarm`, the bare TUI launch, which was the
 * single most-used entry point and the last thing 11 of 18 external installs
 * ever did. That signal went unlabelled for nine days before anyone looked.
 *
 * `telemetry.test.ts` reads the commands registered in cli.ts and requires every
 * one of them to be here, so adding a command without adding it here is a
 * failing test rather than a blind spot discovered months later.
 */
const ALLOWED_COMMANDS = new Set([
  'add', 'annotate', 'attach', 'auth', 'board', 'chat', 'check', 'dash', 'design-pipeline',
  'doctor', 'exec', 'fix', 'init', 'login', 'logout', 'mcp', 'memory', 'models', 'openswarm',
  'pr', 'projects', 'provider', 'remove', 'resume', 'review', 'run', 'schedule', 'start',
  'status', 'stop', 'threads', 'upgrade', 'validate', 'version', 'work',
]);

/**
 * The only free-form-looking field, and it is not free-form: a fixed set of
 * check names. Anything else is dropped rather than truncated, because a value
 * we did not anticipate is exactly what a privacy contract has to refuse.
 */
const ALLOWED_DETAILS = new Set([
  'node', 'native-deps', 'providers', 'config', 'linear', 'ports', 'git', 'gh',
]);
const MAX_DETAIL_ITEMS = 8;
const ALLOWED_ADAPTERS = new Set([
  'atlascloud', 'claude', 'codex', 'codex-responses', 'gpt', 'lmstudio', 'local', 'openrouter',
]);

function allowTelemetryLabel(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  fallback?: string,
): string | undefined {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

/** Build the payload (pure — used directly by tests to assert the privacy contract). */
export function buildPayload(opts: TrackOptions, installId: string): TelemetryPayload {
  const detail = (opts.detail ?? [])
    .map((name) => allowTelemetryLabel(name, ALLOWED_DETAILS))
    .filter((name): name is string => !!name)
    .slice(0, MAX_DETAIL_ITEMS)
    .join(',');
  return {
    installId,
    event: allowTelemetryLabel(opts.event, ALLOWED_EVENTS, 'invoke') ?? 'invoke',
    version,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.versions.node,
    command: allowTelemetryLabel(opts.command, ALLOWED_COMMANDS),
    adapter: allowTelemetryLabel(opts.adapter, ALLOWED_ADAPTERS),
    isError: opts.isError ? 1 : 0,
    ...(detail ? { detail } : {}),
    ...(Number.isFinite(opts.durationMs) && (opts.durationMs as number) >= 0
      ? { durationMs: Math.round(opts.durationMs as number) }
      : {}),
  };
}

/**
 * Send one telemetry event. Fire-and-forget: resolves quietly on any failure and
 * NEVER throws. Awaitable so short-lived CLI commands can flush before exit, but a
 * timeout guarantees it won't hang the process.
 */
export async function track(opts: TrackOptions): Promise<void> {
  if (!isTelemetryEnabled()) return;
  try {
    maybeShowNotice();
    const payload = buildPayload(opts, getInstallId());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    try {
      const response = await fetch(DEFAULT_ENDPOINT, {
        method: 'POST',
        // The payload already carries the allowlisted version. Keep transport
        // headers static so package-file content cannot enter an HTTP request
        // through a future version-loading change.
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenSwarm' },
        body: serializeTelemetryPayload(payload),
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry is best-effort by contract — swallow everything.
  }
}
