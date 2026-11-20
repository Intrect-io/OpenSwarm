// AGT-4002: the web terminal is a remote shell, so the tests pin the gate
// first — disabled means absent, unauthorized upgrades are destroyed, a
// foreign Origin cannot ride loopback trust — then the session cap, idle
// timeout and cleanup. No native addon is needed: the pty is injected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A trusted Tailscale request needs the connection to arrive on this host's
// Tailscale interface, so the host's addresses are named, as in webAuth.test.ts.
const DAEMON_ULA = 'fd7a:115c:a1e0::bc01:c823';
const PEER_ULA = 'fd7a:115c:a1e0::b601:f469';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    networkInterfaces: () => ({ lo0: [{ address: '127.0.0.1' }], utun2: [{ address: DAEMON_ULA }] }),
  };
});

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  CLOSE_TRY_AGAIN_LATER,
  MAX_BUFFERED_BYTES,
  MAX_PENDING_BYTES,
  PENDING_DROPPED_NOTICE,
  SessionLimiter,
  TERMINAL_PROTOCOL,
  TERMINAL_WS_PATH,
  TOKEN_PROTOCOL_PREFIX,
  attachTerminalServer,
  authorizeTerminalUpgrade,
  extractSubprotocolToken,
  isInContainer,
  isWebTerminalActive,
  isWebTerminalEnabled,
  parseClientMessage,
  runTerminalSession,
  startOptionalWebTerminal,
  stopOptionalWebTerminal,
  webTerminalHostRefusal,
  type TerminalPty,
  type TerminalSocket,
} from './terminalServer.js';
import { tryServePageShell } from './webAppRoutes.js';
import { isAuthorizedMutation } from './webAuth.js';

/** A non-root process inside a container: the host the terminal is meant for. */
const CONTAINER_HOST = { getuid: () => 1000, fileExists: (path: string) => path === '/.dockerenv' };

const tokenProtocol = (token: string) => TOKEN_PROTOCOL_PREFIX + Buffer.from(token).toString('base64url');

function fakeReq(opts: {
  remote: string;
  local?: string;
  origin?: string;
  host?: string;
  protocols?: string[];
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    headers: {
      host: opts.host ?? '127.0.0.1:3847',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.protocols ? { 'sec-websocket-protocol': opts.protocols.join(', ') } : {}),
      ...opts.headers,
    },
    socket: { remoteAddress: opts.remote, localAddress: opts.local ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

let savedEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  savedEnv = { ...process.env };
  (await import('./tailscaleNetwork.js')).resetTailscaleInterfaceCacheForTests();
  for (const key of ['OPENSWARM_WEB_TOKEN', 'OPENSWARM_TRUST_TAILSCALE', 'OPENSWARM_TAILSCALE_PEERS',
    'OPENSWARM_WEB_TERMINAL', 'OPENSWARM_WEB_TERMINAL_ALLOW_HOST', 'OPENSWARM_WEB_TERMINAL_ALLOW_ROOT',
    'OPENSWARM_CONTAINER']) delete process.env[key];
});
afterEach(() => {
  process.env = savedEnv;
  stopOptionalWebTerminal();
});

describe('opt-in', () => {
  it('is enabled only by OPENSWARM_WEB_TERMINAL=1', () => {
    expect(isWebTerminalEnabled({})).toBe(false);
    expect(isWebTerminalEnabled({ OPENSWARM_WEB_TERMINAL: 'true' })).toBe(false);
    expect(isWebTerminalEnabled({ OPENSWARM_WEB_TERMINAL: '1' })).toBe(true);
  });

  it('registers no upgrade handler and no /terminal route when unset', async () => {
    const server = createServer();
    await startOptionalWebTerminal(server);
    expect(server.listenerCount('upgrade')).toBe(0);

    const res = { writeHead: vi.fn(), end: vi.fn() };
    expect(await tryServePageShell(res as never, '/terminal')).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('registers both when set', async () => {
    process.env.OPENSWARM_WEB_TERMINAL = '1';
    const server = createServer();
    await startOptionalWebTerminal(server, { ...CONTAINER_HOST, log: () => {} });
    expect(server.listenerCount('upgrade')).toBe(1);

    const res = { writeHead: vi.fn(), end: vi.fn() };
    expect(await tryServePageShell(res as never, '/terminal')).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });
});

describe('protocol parsing', () => {
  it('accepts input and clamped resize frames', () => {
    expect(parseClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({ type: 'input', data: 'ls\r' });
    expect(parseClientMessage('{"type":"resize","cols":120.7,"rows":9999}')).toEqual({ type: 'resize', cols: 120, rows: 200 });
  });

  it('drops malformed frames instead of throwing', () => {
    for (const raw of ['not json', 'null', '[]', '{"type":"exec"}', '{"type":"input","data":5}',
      '{"type":"resize","cols":0,"rows":10}', '{"type":"resize","cols":"80","rows":24}',
      JSON.stringify({ type: 'input', data: 'x'.repeat(70 * 1024) })]) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('reads the token from a subprotocol entry only', () => {
    expect(extractSubprotocolToken(fakeReq({ remote: '10.0.0.5', protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')] }))).toBe('s3cret');
    expect(extractSubprotocolToken(fakeReq({ remote: '10.0.0.5', protocols: [TERMINAL_PROTOCOL] }))).toBeNull();
  });
});

describe('upgrade authorization', () => {
  // Like the mutation gate since AGT-4814: loopback alone is no credential, so the
  // daemon token comes along; with it, no Origin and a same-host Origin are both fine.
  it('allows loopback with no Origin or a same-host Origin, like the mutation gate', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    const protocols = [TERMINAL_PROTOCOL, tokenProtocol('s3cret')];
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1', protocols }))).toBe(true);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1', origin: 'http://127.0.0.1:3847', protocols }))).toBe(true);
  });

  it('refuses a loopback upgrade that carries no daemon token (AGT-4814: a shell is the most powerful mutation)', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1' }))).toBe(false);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1', origin: 'http://127.0.0.1:3847' }))).toBe(false);
  });

  it('refuses a foreign Origin even from loopback (cross-site WebSocket hijack)', () => {
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1', origin: 'http://evil.example' }))).toBe(false);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '127.0.0.1', origin: 'http://localhost:9999' }))).toBe(false);
  });

  it('refuses a foreign Origin even with a valid token', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    expect(authorizeTerminalUpgrade(fakeReq({
      remote: '10.0.0.5', origin: 'http://evil.example', protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')],
    }))).toBe(false);
  });

  it('refuses a remote peer without a credential', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host: '10.0.0.1:3847' }))).toBe(false);
  });

  it('accepts a remote peer with the token as a header or as a subprotocol, and only the right token', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    const host = '10.0.0.1:3847';
    const origin = 'http://10.0.0.1:3847';
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, headers: { 'x-openswarm-token': 's3cret' } }))).toBe(true);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')] }))).toBe(true);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, protocols: [TERMINAL_PROTOCOL, tokenProtocol('wrong')] }))).toBe(false);
    // A remote browser on a page this daemon served: the token decides.
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, origin, protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')] }))).toBe(true);
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, origin, protocols: [TERMINAL_PROTOCOL] }))).toBe(false);
    // Same host, different port: another service on that host is not this daemon.
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', host, origin: 'http://10.0.0.1:8080', protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')] }))).toBe(false);
  });

  it('refuses a trusted Tailscale peer without the daemon token, and accepts it with the token', () => {
    process.env.OPENSWARM_WEB_TOKEN = 's3cret';
    process.env.OPENSWARM_TRUST_TAILSCALE = 'true';
    process.env.OPENSWARM_TAILSCALE_PEERS = PEER_ULA;
    const host = `[${DAEMON_ULA}]:3847`;
    const origin = `http://[${DAEMON_ULA}]:3847`;
    const peer = (extra: { origin?: string; protocols?: string[] } = {}) =>
      fakeReq({ remote: PEER_ULA, local: DAEMON_ULA, host, ...extra });
    // Precondition: the HTTP mutation gate does trust this peer without a token.
    expect(isAuthorizedMutation(peer())).toBe(true);
    expect(isAuthorizedMutation(peer({ origin }))).toBe(true);

    expect(authorizeTerminalUpgrade(peer())).toBe(false);
    expect(authorizeTerminalUpgrade(peer({ origin }))).toBe(false);
    expect(authorizeTerminalUpgrade(peer({ origin, protocols: [TERMINAL_PROTOCOL, tokenProtocol('wrong')] }))).toBe(false);
    expect(authorizeTerminalUpgrade(peer({ origin, protocols: [TERMINAL_PROTOCOL, tokenProtocol('s3cret')] }))).toBe(true);
  });

  it('refuses a subprotocol token when no web token is configured', () => {
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', protocols: [TERMINAL_PROTOCOL, tokenProtocol('')] }))).toBe(false);
  });
});

// ---- Live sessions over a real HTTP server and ws client, fake pty ----

class FakePty implements TerminalPty {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  paused = false;
  pauses = 0;
  // Never a real pid: every session in this file injects killProcessGroup.
  constructor(readonly pid?: number) {}
  #data: Array<(d: string) => void> = [];
  #exit: Array<(e: { exitCode: number }) => void> = [];
  onData(l: (d: string) => void) { this.#data.push(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.#exit.push(l); }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.sizes.push([c, r]); }
  kill() { this.killed = true; }
  pause() { this.paused = true; this.pauses += 1; }
  resume() { this.paused = false; }
  emit(d: string) { for (const l of this.#data) l(d); }
  exit() { for (const l of this.#exit) l({ exitCode: 0 }); }
}

describe('sessions', () => {
  let server: Server;
  let detach: () => void;
  let port: number;
  let ptys: FakePty[];
  let limiter: SessionLimiter;

  async function start(opts: { max?: number; idleMs?: number } = {}) {
    process.env.OPENSWARM_WEB_TOKEN = 'session-token'; // the upgrade needs the daemon token (AGT-4814)
    ptys = [];
    limiter = new SessionLimiter(opts.max ?? 4);
    server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    detach = await attachTerminalServer(server, {
      limiter,
      idleMs: opts.idleMs ?? 60_000,
      log: () => {},
      spawnPty: () => { const p = new FakePty(); ptys.push(p); return p; },
      killProcessGroup: () => {},
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    detach?.();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  const open = (headers: Record<string, string> = {}, path = TERMINAL_WS_PATH) =>
    new WebSocket(`ws://127.0.0.1:${port}${path}`, [TERMINAL_PROTOCOL, tokenProtocol('session-token')], { headers });

  const closed = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const rejected = (ws: WebSocket) => new Promise<number>((r) => {
    ws.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0));
    ws.on('error', () => r(-1));
  });

  it('destroys an upgrade carrying a foreign Origin with 401', async () => {
    await start();
    expect(await rejected(open({ Origin: 'http://evil.example' }))).toBe(401);
    expect(ptys).toHaveLength(0);
  });

  it('does not accept upgrades on other paths', async () => {
    await start();
    expect(await rejected(open({}, '/api/events'))).toBe(404);
  });

  it('relays output, input and resize, and kills the shell when the socket closes', async () => {
    await start();
    const ws = open();
    await new Promise<void>((r) => ws.on('open', () => r()));
    expect(ws.protocol).toBe(TERMINAL_PROTOCOL);
    await vi.waitFor(() => expect(ptys).toHaveLength(1));

    const got = new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    ptys[0].emit('hello\r\n');
    expect(await got).toBe('hello\r\n');

    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    ws.send('garbage');
    await vi.waitFor(() => expect(ptys[0].sizes).toEqual([[100, 30]]));
    expect(ptys[0].written).toEqual(['ls\r']);

    ws.close();
    await vi.waitFor(() => expect(ptys[0].killed).toBe(true));
    expect(limiter.active).toBe(0);
  });

  it('closes a session over the cap with 1013', async () => {
    await start({ max: 1 });
    const first = open();
    await new Promise<void>((r) => first.on('open', () => r()));
    const second = open();
    expect(await closed(second)).toBe(CLOSE_TRY_AGAIN_LATER);
    expect(ptys).toHaveLength(1);
    first.close();
  });

  it('closes an idle session and kills its shell', async () => {
    await start({ idleMs: 80 });
    const ws = open();
    const code = closed(ws);
    expect(await code).toBe(1000);
    await vi.waitFor(() => expect(ptys[0]?.killed).toBe(true));
    expect(limiter.active).toBe(0);
  });

  it('closes the socket when the shell exits', async () => {
    await start();
    const ws = open();
    await new Promise<void>((r) => ws.on('open', () => r()));
    await vi.waitFor(() => expect(ptys).toHaveLength(1));
    const code = closed(ws);
    ptys[0].exit();
    expect(await code).toBe(1000);
    expect(limiter.active).toBe(0);
  });
});

// ---- Host confinement: no shell as root or outside a container by default ----

describe('host confinement', () => {
  async function startWith(probe: Parameters<typeof startOptionalWebTerminal>[1]) {
    process.env.OPENSWARM_WEB_TERMINAL = '1';
    const server = createServer();
    const lines: string[] = [];
    await startOptionalWebTerminal(server, { log: (l) => lines.push(l), ...probe });
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const pageServed = await tryServePageShell(res as never, '/terminal');
    return { upgrades: server.listenerCount('upgrade'), pageServed, lines };
  }

  it('detects a container by /.dockerenv, /run/.containerenv or OPENSWARM_CONTAINER=1', () => {
    const none = () => false;
    expect(isInContainer({ env: {}, fileExists: none })).toBe(false);
    expect(isInContainer({ env: {}, fileExists: (p) => p === '/.dockerenv' })).toBe(true);
    expect(isInContainer({ env: {}, fileExists: (p) => p === '/run/.containerenv' })).toBe(true);
    expect(isInContainer({ env: { OPENSWARM_CONTAINER: '1' }, fileExists: none })).toBe(true);
  });

  it('refuses a host (non-container) daemon, leaving the page and upgrade off', async () => {
    const r = await startWith({ getuid: () => 1000, fileExists: () => false });
    expect(r.upgrades).toBe(0);
    expect(r.pageServed).toBe(false);
    expect(isWebTerminalActive()).toBe(false);
    expect(r.lines).toEqual([expect.stringMatching(/NOT enabled: .*not in a container.*OPENSWARM_WEB_TERMINAL_ALLOW_HOST=1/)]);
  });

  it('starts on the host only with OPENSWARM_WEB_TERMINAL_ALLOW_HOST=1', async () => {
    process.env.OPENSWARM_WEB_TERMINAL_ALLOW_HOST = '1';
    const r = await startWith({ getuid: () => 1000, fileExists: () => false });
    expect(r.upgrades).toBe(1);
    expect(r.pageServed).toBe(true);
  });

  it('refuses root even inside a container', async () => {
    const r = await startWith({ ...CONTAINER_HOST, getuid: () => 0 });
    expect(r.upgrades).toBe(0);
    expect(r.pageServed).toBe(false);
    expect(r.lines).toEqual([expect.stringMatching(/NOT enabled: .*root.*OPENSWARM_WEB_TERMINAL_ALLOW_ROOT=1/)]);
  });

  it('starts as root in a container only with OPENSWARM_WEB_TERMINAL_ALLOW_ROOT=1', async () => {
    process.env.OPENSWARM_WEB_TERMINAL_ALLOW_ROOT = '1';
    const r = await startWith({ ...CONTAINER_HOST, getuid: () => 0 });
    expect(r.upgrades).toBe(1);
  });

  it('needs both overrides for root on the host', () => {
    const host = { getuid: () => 0, fileExists: () => false };
    expect(webTerminalHostRefusal({ ...host, env: {} })).toMatch(/root/);
    expect(webTerminalHostRefusal({ ...host, env: { OPENSWARM_WEB_TERMINAL_ALLOW_ROOT: '1' } })).toMatch(/not in a container/);
    expect(webTerminalHostRefusal({ ...host, env: { OPENSWARM_WEB_TERMINAL_ALLOW_HOST: '1' } })).toMatch(/root/);
    expect(webTerminalHostRefusal({ ...host, env: { OPENSWARM_WEB_TERMINAL_ALLOW_ROOT: '1', OPENSWARM_WEB_TERMINAL_ALLOW_HOST: '1' } })).toBeNull();
  });

  it('logs nothing when the terminal was not requested', async () => {
    const server = createServer();
    const lines: string[] = [];
    await startOptionalWebTerminal(server, { getuid: () => 0, fileExists: () => false, log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    expect(server.listenerCount('upgrade')).toBe(0);
  });
});

// ---- Backpressure, the pre-spawn queue and process-group cleanup ----

class FakeSocket implements TerminalSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  #message: Array<(d: unknown) => void> = [];
  #close: Array<() => void> = [];
  send(d: string) { this.sent.push(d); }
  close(code?: number) {
    if (this.closedWith !== null) return;
    this.closedWith = code ?? 1000;
    for (const l of this.#close) l();
  }
  on(event: 'message' | 'close', listener: (d?: unknown) => void) {
    if (event === 'message') this.#message.push(listener as (d: unknown) => void);
    else this.#close.push(listener as () => void);
  }
  receive(message: unknown) { for (const l of this.#message) l(JSON.stringify(message)); }
}

describe('session flow control and cleanup', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;

  it('pauses the shell while the socket holds over 1 MiB and resumes once it drains', async () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    await runTerminalSession(socket, req, { spawnPty: () => pty, log: () => {}, killProcessGroup: () => {} });

    pty.emit('small');
    expect(pty.paused).toBe(false);
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    pty.emit('flood');
    expect(pty.paused).toBe(true);
    pty.emit('more'); // still sent, but no second pause
    expect(pty.pauses).toBe(1);
    expect(socket.sent).toEqual(['small', 'flood', 'more']);

    await new Promise((r) => setTimeout(r, 120));
    expect(pty.paused).toBe(true); // nothing drained yet
    socket.bufferedAmount = 0;
    await vi.waitFor(() => expect(pty.paused).toBe(false));
    socket.close();
  });

  it('caps input queued before the shell starts and says so once', async () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    let ready!: (p: TerminalPty) => void;
    const session = runTerminalSession(socket, req, {
      spawnPty: () => new Promise<TerminalPty>((r) => { ready = r; }),
      log: () => {},
      killProcessGroup: () => {},
    });
    const chunk = 'x'.repeat(60 * 1024);
    for (let i = 0; i < 6; i++) socket.receive({ type: 'input', data: chunk });
    ready(pty);
    await session;

    const queued = pty.written.reduce((n, d) => n + d.length, 0);
    expect(queued).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    expect(pty.written).toHaveLength(4);
    expect(socket.sent.filter((m) => m === PENDING_DROPPED_NOTICE)).toHaveLength(1);
    socket.close();
  });

  it('kills the shell and its process group (SIGHUP, then SIGKILL after the grace)', async () => {
    const socket = new FakeSocket();
    const pty = new FakePty(4242);
    const signals: Array<[number, string]> = [];
    await runTerminalSession(socket, req, {
      spawnPty: () => pty, log: () => {}, killGraceMs: 20,
      killProcessGroup: (pgid, signal) => { signals.push([pgid, signal]); },
    });
    socket.close();
    expect(pty.killed).toBe(true);
    expect(signals).toEqual([[4242, 'SIGHUP']]);
    await vi.waitFor(() => expect(signals).toEqual([[4242, 'SIGHUP'], [4242, 'SIGKILL']]));
  });

  it('skips the SIGKILL when the group is already gone, and never signals pid 0 or 1', async () => {
    for (const pid of [undefined, 0, 1]) {
      const socket = new FakeSocket();
      const signals: string[] = [];
      await runTerminalSession(socket, req, {
        spawnPty: () => new FakePty(pid), log: () => {}, killGraceMs: 5,
        killProcessGroup: (_p, s) => { signals.push(s); },
      });
      socket.close();
      expect(signals).toEqual([]);
    }
    const socket = new FakeSocket();
    const signals: string[] = [];
    await runTerminalSession(socket, req, {
      spawnPty: () => new FakePty(4243), log: () => {}, killGraceMs: 5,
      killProcessGroup: (_p, s) => { signals.push(s); throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    });
    expect(() => socket.close()).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(signals).toEqual(['SIGHUP']);
  });
});

// ---- The page asks for the token instead of connecting without one ----

describe('terminal page', () => {
  const STATIC = join(__dirname, '..', '..', 'web', 'static');

  it('offers a token input and stores what is entered through webToken.js', () => {
    const html = readFileSync(join(STATIC, 'terminal.html'), 'utf8');
    const js = readFileSync(join(STATIC, 'js', 'terminal.js'), 'utf8');
    expect(html).toMatch(/<form id="terminal-token-form"[^>]*hidden/);
    expect(html).toMatch(/<label for="terminal-token-input">/);
    expect(js).toContain('api.storeToken(token)');
    expect(js).toMatch(/if \(!readToken\(\)\) \{ askForToken/);
  });
});
