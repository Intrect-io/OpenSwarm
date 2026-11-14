import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('./openBrowser.js', () => ({
  openBrowser: (url: string) => {
    opened.push(url);
  },
}));

const { runOAuthPkceFlow } = await import('./oauthPkce.js');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForAuthUrl(): Promise<URL> {
  for (let i = 0; i < 200; i++) {
    if (opened.length > 0) return new URL(opened[0]);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('flow never opened the browser');
}

interface CallbackReply {
  status: number;
  body: string;
}

function hitCallback(port: number, query: string): Promise<CallbackReply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: `/auth/callback?${query}`, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

describe('runOAuthPkceFlow callback response', () => {
  beforeEach(() => {
    opened.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ends the held callback response when the login timeout wins during the exchange', async () => {
    // The token request never answers on its own; it only fails when the flow aborts it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          }),
      ),
    );

    const port = await freePort();
    const flow = runOAuthPkceFlow({ port, timeoutMs: 300 });
    const flowOutcome = flow.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    const state = (await waitForAuthUrl()).searchParams.get('state');

    const reply = await hitCallback(port, `code=abc&state=${state}`);

    expect(reply.status).toBe(410);
    expect(reply.body).toContain('already ended');
    expect(await flowOutcome).toMatch(/timed out/);
  });

  it('still answers 200 once and resolves when the exchange wins', async () => {
    const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: access, refresh_token: 'r1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const port = await freePort();
    const flow = runOAuthPkceFlow({ port, timeoutMs: 5_000 });
    const state = (await waitForAuthUrl()).searchParams.get('state');

    const reply = await hitCallback(port, `code=abc&state=${state}`);
    const result = await flow;

    expect(reply.status).toBe(200);
    expect(result.accountId).toBe('acct_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers 500 once and rejects when the exchange fails before any timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })));

    const port = await freePort();
    const flow = runOAuthPkceFlow({ port, timeoutMs: 5_000 });
    const flowOutcome = flow.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    const state = (await waitForAuthUrl()).searchParams.get('state');

    const reply = await hitCallback(port, `code=abc&state=${state}`);

    expect(reply.status).toBe(500);
    expect(await flowOutcome).toMatch(/Token exchange failed \(400\)/);
  });
});
