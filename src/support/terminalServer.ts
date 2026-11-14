// ============================================
// OpenSwarm - Web virtual terminal (AGT-4002)
// ============================================
//
// A browser shell into the daemon's own container, for operating a remote
// daemon (vela) without SSH. It is a remote shell, so:
//
// - It exists only when OPENSWARM_WEB_TERMINAL=1. Unset, neither the /terminal
//   page nor the upgrade handler is registered.
// - The WebSocket upgrade never enters web.ts's request handler, so none of the
//   HTTP gates run on it. authorizeTerminalUpgrade() applies the mutation gate
//   from webAuth.ts explicitly, plus a same-host Origin check: browsers do not
//   apply CORS to WebSockets, and loopback is trusted, so without the Origin
//   check any page open in the operator's browser could open a shell.
// - A browser cannot set headers on a WebSocket, so the web token travels as a
//   Sec-WebSocket-Protocol entry (`openswarm.token.<base64url>`), never in the
//   URL. The server echoes only the plain protocol name back.
// - At most MAX_SESSIONS shells at once, each closed after IDLE_MS without
//   input, and every start/stop is logged with the peer address.
//
// Anyone who can open this terminal can read the container's environment,
// including every token the daemon holds.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { getEffectivePort, hasValidWebToken, isAuthorizedMutation, isTrustedLocalOrigin } from './webAuth.js';

export const TERMINAL_PAGE_PATH = '/terminal';
export const TERMINAL_WS_PATH = '/terminal/ws';
export const TERMINAL_PROTOCOL = 'openswarm.terminal.v1';
export const TOKEN_PROTOCOL_PREFIX = 'openswarm.token.';
export const MAX_SESSIONS = 4;
export const IDLE_MS = 15 * 60_000;
/** WebSocket close code "Try Again Later", sent when the session cap is reached. */
export const CLOSE_TRY_AGAIN_LATER = 1013;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_COLS = 500;
const MAX_ROWS = 200;

export function isWebTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSWARM_WEB_TERMINAL === '1';
}

// ---- Protocol ----

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

function clampDimension(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n >= 1 ? Math.min(n, max) : null;
}

/** Parse one client frame; anything malformed is dropped (null), never thrown. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_INPUT_BYTES * 2) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const msg = value as Record<string, unknown>;
  if (msg.type === 'input') {
    if (typeof msg.data !== 'string' || Buffer.byteLength(msg.data) > MAX_INPUT_BYTES) return null;
    return { type: 'input', data: msg.data };
  }
  if (msg.type === 'resize') {
    const cols = clampDimension(msg.cols, MAX_COLS);
    const rows = clampDimension(msg.rows, MAX_ROWS);
    return cols && rows ? { type: 'resize', cols, rows } : null;
  }
  return null;
}

// ---- Authentication ----

function offeredProtocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  const joined = Array.isArray(header) ? header.join(',') : header ?? '';
  return joined.split(',').map((p) => p.trim()).filter(Boolean);
}

/** The web token a browser offered as a subprotocol entry, or null. */
export function extractSubprotocolToken(req: IncomingMessage): string | null {
  for (const protocol of offeredProtocols(req)) {
    if (!protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
    try {
      const token = Buffer.from(protocol.slice(TOKEN_PROTOCOL_PREFIX.length), 'base64url').toString('utf8');
      return token || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The browser page that opened this socket was served by this daemon (same host and port). */
function isSameHostOrigin(req: IncomingMessage): boolean {
  if (isTrustedLocalOrigin(req)) return true;
  const { origin, host } = req.headers;
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    const h = new URL(`${o.protocol}//${host}`);
    return (o.protocol === 'http:' || o.protocol === 'https:')
      && o.hostname === h.hostname && getEffectivePort(o) === getEffectivePort(h);
  } catch {
    return false;
  }
}

/**
 * The same verdict the HTTP mutation gate gives (token, OR loopback with a
 * trusted Origin, OR trusted Tailscale), reached through the gate itself.
 * On top of it, any browser-originated upgrade must come from a page this
 * daemon served: the ambient-trust paths already demand that inside the gate,
 * and this extends it to the token path.
 */
export function authorizeTerminalUpgrade(req: IncomingMessage): boolean {
  if (req.headers.origin !== undefined && !isSameHostOrigin(req)) return false;
  if (isAuthorizedMutation(req)) return true;
  const token = extractSubprotocolToken(req);
  if (!token) return false;
  // Re-ask the existing token check with the subprotocol token in the header
  // it already reads, rather than comparing secrets a second way here.
  const view = { headers: { ...req.headers, authorization: undefined, 'x-openswarm-token': token }, socket: req.socket };
  return hasValidWebToken(view as unknown as IncomingMessage);
}

// ---- Session bookkeeping ----

export class SessionLimiter {
  #active = 0;
  constructor(readonly max: number = MAX_SESSIONS) {}
  tryAcquire(): boolean {
    if (this.#active >= this.max) return false;
    this.#active += 1;
    return true;
  }
  release(): void {
    if (this.#active > 0) this.#active -= 1;
  }
  get active(): number {
    return this.#active;
  }
}

export interface IdleTimer { touch(): void; clear(): void }

/** Calls onIdle once after `ms` without a touch(). */
export function createIdleTimer(ms: number, onIdle: () => void): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onIdle(); }, ms);
    timer.unref?.();
  };
  arm();
  return {
    touch: arm,
    clear: () => { if (timer) clearTimeout(timer); timer = null; },
  };
}

// ---- PTY ----

export interface TerminalPty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (options: { cols: number; rows: number; cwd: string }) => TerminalPty | Promise<TerminalPty>;

export function terminalWorkingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.OPENSWARM_WORKSPACE_ROOT?.trim() || '/work';
  return existsSync(root) ? root : homedir();
}

/** node-pty is an optional native dependency, loaded only once a session starts. */
const spawnNodePty: SpawnPty = async ({ cols, rows, cwd }) => {
  const pty = await import('node-pty');
  return pty.spawn('bash', ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string> });
};

// ---- Wiring ----

/** The subset of a `ws` WebSocket this module uses. */
export interface TerminalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
}

export interface TerminalSessionDeps {
  spawnPty?: SpawnPty;
  limiter?: SessionLimiter;
  idleMs?: number;
  log?: (line: string) => void;
}

function peerOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Run one terminal session over an accepted socket. Exported so the session
 * cap, idle timeout and cleanup can be tested without a real pty or server.
 */
export async function runTerminalSession(socket: TerminalSocket, req: IncomingMessage, deps: TerminalSessionDeps = {}): Promise<void> {
  const limiter = deps.limiter ?? new SessionLimiter();
  const log = deps.log ?? ((line: string) => console.log(line));
  const peer = peerOf(req);
  if (!limiter.tryAcquire()) {
    log(`[Terminal] refused ${peer}: ${limiter.max} sessions already open`);
    socket.close(CLOSE_TRY_AGAIN_LATER, 'Too many terminal sessions');
    return;
  }
  const startedAt = Date.now();
  let closed = false;
  let pty: TerminalPty | null = null;
  const pending: ClientMessage[] = [];
  const idle = createIdleTimer(deps.idleMs ?? IDLE_MS, () => {
    log(`[Terminal] idle timeout ${peer}`);
    socket.close(1000, 'Idle timeout');
    finish();
  });

  function finish(): void {
    if (closed) return;
    closed = true;
    idle.clear();
    limiter.release();
    try { pty?.kill(); } catch { /* already gone */ }
    log(`[Terminal] session end ${peer} after ${Math.round((Date.now() - startedAt) / 1000)}s (${limiter.active} open)`);
  }

  function apply(message: ClientMessage): void {
    if (!pty) { pending.push(message); return; }
    if (message.type === 'input') pty.write(message.data);
    else pty.resize(message.cols, message.rows);
  }

  socket.on('message', (data) => {
    const message = parseClientMessage(typeof data === 'string' ? data : String(data));
    if (!message) return;
    idle.touch();
    apply(message);
  });
  socket.on('close', finish);
  log(`[Terminal] session start ${peer} (${limiter.active} open)`);

  try {
    pty = await (deps.spawnPty ?? spawnNodePty)({ cols: 80, rows: 24, cwd: terminalWorkingDirectory() });
  } catch (err) {
    log(`[Terminal] could not start a shell: ${err instanceof Error ? err.message : String(err)}`);
    socket.close(1011, 'Shell unavailable');
    finish();
    return;
  }
  if (closed) { try { pty.kill(); } catch { /* ignore */ } return; }
  pty.onData((chunk) => { if (!closed) socket.send(chunk); });
  pty.onExit(() => { socket.close(1000, 'Shell exited'); finish(); });
  for (const message of pending.splice(0)) apply(message);
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Register the /terminal/ws upgrade handler on `server`. Callers check
 * isWebTerminalEnabled() first; this function does not.
 */
export async function attachTerminalServer(server: Server, deps: TerminalSessionDeps = {}): Promise<() => void> {
  const { WebSocketServer } = await import('ws');
  const limiter = deps.limiter ?? new SessionLimiter();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INPUT_BYTES * 2,
    handleProtocols: (protocols) => (protocols.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false),
  });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== TERMINAL_WS_PATH) {
      // Nothing else in the daemon accepts upgrades; do not leave it hanging.
      if (server.listenerCount('upgrade') === 1) rejectUpgrade(socket, '404 Not Found');
      return;
    }
    if (!authorizeTerminalUpgrade(req)) {
      (deps.log ?? console.log)(`[Terminal] rejected upgrade from ${peerOf(req)}`);
      rejectUpgrade(socket, '401 Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void runTerminalSession(ws as unknown as TerminalSocket, req, { ...deps, limiter });
    });
  };
  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

// ---- Daemon lifecycle (called from web.ts) ----

let detachTerminal: (() => void) | null = null;

/** Attach the terminal to the daemon's HTTP server when, and only when, it is enabled. */
export async function startOptionalWebTerminal(server: Server): Promise<void> {
  if (!isWebTerminalEnabled() || detachTerminal) return;
  detachTerminal = await attachTerminalServer(server);
  console.warn(`[Terminal] web terminal ENABLED at ${TERMINAL_PAGE_PATH}: a shell in this container for any authorized web client`);
}

export function stopOptionalWebTerminal(): void {
  detachTerminal?.();
  detachTerminal = null;
}
