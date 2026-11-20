// AGT-4002: the web terminal is a remote shell, so the tests pin the gate
// first — disabled means absent, unauthorized upgrades are destroyed, a
// foreign Origin cannot ride loopback trust — then the session cap, idle
// timeout and cleanup. No native addon is needed: the pty is injected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  CLOSE_TRY_AGAIN_LATER,
  SessionLimiter,
  TERMINAL_PROTOCOL,
  TERMINAL_WS_PATH,
  TOKEN_PROTOCOL_PREFIX,
  attachTerminalServer,
  authorizeTerminalUpgrade,
  extractSubprotocolToken,
  isWebTerminalEnabled,
  parseClientMessage,
  startOptionalWebTerminal,
  stopOptionalWebTerminal,
  type TerminalPty,
} from './terminalServer.js';
import { tryServePageShell } from './webAppRoutes.js';

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
beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.OPENSWARM_WEB_TOKEN;
  delete process.env.OPENSWARM_TRUST_TAILSCALE;
  delete process.env.OPENSWARM_WEB_TERMINAL;
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
    await startOptionalWebTerminal(server);
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

  it('refuses a subprotocol token when no web token is configured', () => {
    expect(authorizeTerminalUpgrade(fakeReq({ remote: '10.0.0.5', protocols: [TERMINAL_PROTOCOL, tokenProtocol('')] }))).toBe(false);
  });
});

// ---- Live sessions over a real HTTP server and ws client, fake pty ----

class FakePty implements TerminalPty {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  #data: Array<(d: string) => void> = [];
  #exit: Array<(e: { exitCode: number }) => void> = [];
  onData(l: (d: string) => void) { this.#data.push(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.#exit.push(l); }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.sizes.push([c, r]); }
  kill() { this.killed = true; }
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
