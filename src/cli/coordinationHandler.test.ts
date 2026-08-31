import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationEvent } from '../coordination/coordinationStore.js';
import type { CoordinationThread } from '../coordination/coordinationThreads.js';
import { DAEMON_HOST_ENV, DAEMON_SCHEME_ENV, DAEMON_TOKEN_ENV } from './daemonEndpoint.js';
import { formatBoard, formatThreads, runBoardCommand, runThreadsCommand } from './coordinationHandler.js';

function event(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'e1', seq: 1, timestamp: 1_700_000_000_000, repository: '/repo', taskId: 'uuid-1',
    taskLabel: 'AGT-123', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
    kind: 'advice-request', status: 'open', correlationId: 'hq-1', summary: 'which bucket?',
    fingerprint: 'fp1',
    ...overrides,
  };
}

function thread(overrides: Partial<CoordinationThread> = {}): CoordinationThread {
  return {
    id: 'th-1', repository: '/repo', subject: 'Rate limit strategy', status: 'open', version: 1,
    createdByActor: 'sable', createdByTaskId: 'uuid-1', relatedTaskIds: ['uuid-1'],
    relatedFiles: [], relatedPullRequests: [], createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000, messageCount: 4, participantCount: 2,
    ...overrides,
  };
}

function ok(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

function err(status: number, body: string) {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[DAEMON_HOST_ENV];
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_SCHEME_ENV];
});

describe('formatBoard', () => {
  it('leads with the questions waiting on an operator', () => {
    const out = formatBoard({ events: [event()], pending: [event()], lastSeq: 1 }, 20);
    expect(out.split('\n')[0]).toBe('Waiting on an operator (1):');
    // The correlationId is why an operator reads this at all — it is what
    // `attach` needs to answer the right exchange.
    expect(out).toContain('correlationId: hq-1');
    expect(out).toContain('openswarm attach');
  });

  it('says so plainly when nothing is parked', () => {
    const out = formatBoard({ events: [], pending: [], lastSeq: 0 }, 20);
    expect(out).toContain('Waiting on an operator: none.');
    expect(out).toContain('No board activity.');
    expect(out).not.toContain('openswarm attach');
  });

  it('shows the newest events when the board is longer than the limit', () => {
    const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, seq: i, summary: `s${i}` }));
    const out = formatBoard({ events, pending: [], lastSeq: 5 }, 2);
    expect(out).toContain('Recent board activity (2 of 5)');
    expect(out).toContain('s4');
    expect(out).not.toContain('s0');
  });

  it('survives a payload missing its arrays', () => {
    const out = formatBoard({ lastSeq: 0 } as never, 20);
    expect(out).toContain('Waiting on an operator: none.');
  });

  // `-n` reaches here straight from Number.parseInt, so NaN and negatives are
  // reachable inputs, and `slice(-limit)` mishandles both: NaN returns the
  // whole board, a negative count slices from the wrong end.
  it.each([Number.NaN, -5, 0])('clamps a nonsense limit (%s) instead of slicing wrongly', (limit) => {
    const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, seq: i, summary: `s${i}` }));
    const out = formatBoard({ events, pending: [], lastSeq: 5 }, limit as number);
    // Whatever it shows, it must be a bounded tail of the board, never the
    // head and never silently everything for a limit the operator set low.
    expect(out).toContain('s4');
    expect(out).toMatch(/Recent board activity \(\d+ of 5\)/);
    const shown = Number(/Recent board activity \((\d+) of 5\)/.exec(out)?.[1]);
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThanOrEqual(5);
  });
});

describe('formatThreads', () => {
  it('lists status, id and message count', () => {
    const out = formatThreads([thread()], '/repo');
    expect(out).toContain('[open] Rate limit strategy');
    expect(out).toContain('id: th-1');
    expect(out).toContain('messages: 4');
  });

  it('reports an empty repository without inventing rows', () => {
    expect(formatThreads([], '/repo')).toBe('No coordination threads for /repo.');
  });
});

describe('runBoardCommand', () => {
  it('reads the board and prints it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ events: [event()], pending: [event()], lastSeq: 1 }));

    const code = await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3847/api/coordination');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(logs.join('\n')).toContain('Waiting on an operator (1):');
  });

  it('scopes to a repository when asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ events: [], pending: [], lastSeq: 0 }));

    await runBoardCommand({ repository: '/work/OpenSwarm', fetchImpl: fetchImpl as never });

    expect(fetchImpl.mock.calls[0][0]).toContain('?repository=%2Fwork%2FOpenSwarm');
  });

  it('prints the raw payload under --json', async () => {
    const payload = { events: [], pending: [], lastSeq: 7 };
    const fetchImpl = vi.fn().mockResolvedValue(ok(payload));

    await runBoardCommand({ json: true, fetchImpl: fetchImpl as never });

    expect(JSON.parse(logs.join('\n'))).toEqual(payload);
  });

  it('names the remote daemon so a remote read is not mistaken for a local one', async () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    const fetchImpl = vi.fn().mockResolvedValue(ok({ events: [], pending: [], lastSeq: 0 }));

    await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(fetchImpl.mock.calls[0][0]).toBe('http://vela:3847/api/coordination');
    // The daemon serves plain http, so name the transport rather than let a
    // remote read look the same as a local one.
    expect(logs[0]).toBe('(daemon: vela, plaintext http)');
  });

  it('says https when a TLS proxy fronts the daemon', async () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    process.env[DAEMON_SCHEME_ENV] = 'https';
    const fetchImpl = vi.fn().mockResolvedValue(ok({ events: [], pending: [], lastSeq: 0 }));

    await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://vela:3847/api/coordination');
    expect(logs[0]).toBe('(daemon: vela, https)');
  });

  it('presents the daemon token so a secured daemon answers at all', async () => {
    process.env[DAEMON_TOKEN_ENV] = 's3cret';
    const fetchImpl = vi.fn().mockResolvedValue(ok({ events: [], pending: [], lastSeq: 0 }));

    await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'x-openswarm-token': 's3cret' });
  });

  it.each([401, 403])('names a missing token on HTTP %s instead of blaming the board', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(err(status, ''));

    const code = await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain(DAEMON_TOKEN_ENV);
  });

  it('surfaces the daemon error text rather than a bare status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(500, JSON.stringify({ error: 'board is locked' })));

    const code = await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('board is locked');
  });

  it('tells a local operator how to start the daemon it could not reach', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const code = await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    const text = errors.join('\n');
    expect(text).toContain('openswarm start');
    // The underlying cause still has to survive, or a DNS failure and a
    // stopped daemon become the same message.
    expect(text).toContain('ECONNREFUSED');
  });

  it('names the remote host instead of suggesting a local start', async () => {
    process.env[DAEMON_HOST_ENV] = 'vela';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND vela'));

    const code = await runBoardCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    const text = errors.join('\n');
    expect(text).toContain('vela:3847');
    expect(text).not.toContain('openswarm start');
  });
});

describe('runThreadsCommand', () => {
  it('defaults the repository to the working directory the route requires', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ items: [thread()] }));

    const code = await runThreadsCommand({ fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    expect(fetchImpl.mock.calls[0][0]).toContain(`repository=${encodeURIComponent(process.cwd())}`);
    expect(logs.join('\n')).toContain('Rate limit strategy');
  });

  it('passes status and limit through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ items: [] }));

    await runThreadsCommand({ repository: '/repo', status: 'open', limit: 5, fetchImpl: fetchImpl as never });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('status=open');
    expect(url).toContain('limit=5');
  });

  it('never puts an unparseable limit on the wire', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ items: [] }));

    await runThreadsCommand({ repository: '/repo', limit: Number.NaN, fetchImpl: fetchImpl as never });

    expect(fetchImpl.mock.calls[0][0]).not.toContain('limit=');
  });

  it('handles a page with no items key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}));

    const code = await runThreadsCommand({ repository: '/repo', fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('No coordination threads for /repo.');
  });

  it('reports the route error when repository is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(400, JSON.stringify({ error: 'repository query parameter is required' })));

    const code = await runThreadsCommand({ repository: '/repo', fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('repository query parameter is required');
  });
});
