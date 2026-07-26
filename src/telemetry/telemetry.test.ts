import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub disk IO: a stable install id + noticeShown so getInstallId/maybeShowNotice
// never touch the real ~/.config/openswarm/telemetry.json during tests.
// The id must be a valid 21-char nanoid or getInstallId regenerates it.
const TEST_INSTALL_ID = 'testinstall0123456789';
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ installId: 'testinstall0123456789', noticeShown: true })),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // atomicWriteFileSync (used by writeState) opens a temp file, fsyncs and
  // renames it into place; the payload still reaches writeFileSync as arg[1].
  openSync: () => 1,
  fsyncSync: () => undefined,
  closeSync: () => undefined,
  renameSync: () => undefined,
  existsSync: () => false,
  unlinkSync: () => undefined,
}));

import { initTelemetry, isTelemetryEnabled, track, buildPayload } from './telemetry.js';

const ENV_KEYS = [
  'OPENSWARM_TELEMETRY',
  'DO_NOT_TRACK',
  'CI',
  'GITHUB_ACTIONS',
  'OPENSWARM_TELEMETRY_URL',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  initTelemetry({ version: '9.9.9', enabled: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('telemetry opt-out gating', () => {
  it('is enabled by default (opt-out model)', () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('OPENSWARM_TELEMETRY=0 disables', () => {
    process.env.OPENSWARM_TELEMETRY = '0';
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('DO_NOT_TRACK=1 disables', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('CI env is auto-excluded (bots are not real users)', () => {
    process.env.CI = 'true';
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('config telemetry.enabled=false hard-disables', () => {
    initTelemetry({ version: '9.9.9', enabled: false });
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe('track() transport', () => {
  it('sends nothing when disabled', async () => {
    process.env.OPENSWARM_TELEMETRY = '0';
    await track({ command: 'run' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs one event to the endpoint when enabled', async () => {
    process.env.OPENSWARM_TELEMETRY_URL = 'https://t.example/x';
    await track({ command: 'start' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://t.example/x');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.command).toBe('start');
    expect(body.installId).toBe(TEST_INSTALL_ID);
  });

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(track({ command: 'run' })).resolves.toBeUndefined();
  });

  it('cancels the unused response body', async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ body: { cancel } } as unknown as Response)));
    await track({ command: 'run' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('unrefs the timeout so fire-and-forget telemetry does not keep the process alive', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = realSetTimeout(handler as (...timerArgs: unknown[]) => void, timeout, ...args);
      timer.unref = unref;
      return timer;
    }) as typeof setTimeout);

    await track({ command: 'run' });

    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe('privacy contract (payload shape)', () => {
  it('contains only the anonymous whitelist — no PII keys', () => {
    initTelemetry({ version: '1.2.3', enabled: true });
    const p = buildPayload({ command: 'run', adapter: 'codex' }, 'iid');
    expect(Object.keys(p).sort()).toEqual(
      ['adapter', 'arch', 'command', 'event', 'installId', 'isError', 'nodeVersion', 'platform', 'version'].sort(),
    );
    // No filesystem paths, tokens, keys, or prompt text can appear.
    expect(JSON.stringify(p)).not.toMatch(/\/Users\/|\/home\/|token|apiKey|prompt/i);
    expect(p.installId).toBe('iid');
    expect(p.version).toBe('1.2.3');
    expect(p.command).toBe('run');
  });

  it('isError is a 0/1 flag, never free text', () => {
    expect(buildPayload({ isError: true }, 'i').isError).toBe(1);
    expect(buildPayload({ isError: false }, 'i').isError).toBe(0);
    expect(buildPayload({}, 'i').isError).toBe(0);
  });

  it('defaults event to "invoke"', () => {
    expect(buildPayload({ command: 'chat' }, 'i').event).toBe('invoke');
  });

  it('drops unsafe dynamic labels before they can leak paths or prompts', () => {
    const p = buildPayload({
      command: '/Users/unohee/dev/OpenSwarm secret prompt',
      adapter: 'codex',
      event: 'task completed with /tmp/path',
    }, 'i');

    expect(p.command).toBeUndefined();
    expect(p.adapter).toBe('codex');
    expect(p.event).toBe('invoke');
    expect(JSON.stringify(p)).not.toMatch(/Users|secret prompt|tmp\/path/);
  });
});
