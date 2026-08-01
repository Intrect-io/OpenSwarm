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

describe('the allowlist must not silently discard real commands (INT-3190)', () => {
  it('accepts every command cli.ts registers', () => {
    // Read the registrations rather than restate them. This list dropped
    // `openswarm` — the bare TUI launch, the most-used entry point and the last
    // thing 11 of 18 external installs ever did — and nothing failed: the event
    // still arrived, with a NULL command. Nine days of the drop-off signal went
    // unlabelled before anyone looked. A new command is now a red test.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cli = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    const registered = [...cli.matchAll(/\.command\('([a-z-]+)'/g)].map((m) => m[1]);

    expect(registered.length).toBeGreaterThan(5);
    const dropped = registered.filter((name) => buildPayload({ command: name }, 'i').command !== name);
    expect(dropped).toEqual([]);
  });

  it('accepts the bare TUI launch, which is not a registered subcommand', () => {
    expect(buildPayload({ command: 'openswarm' }, 'i').command).toBe('openswarm');
  });
});

describe('completion events (INT-3190)', () => {
  it('carries the outcome and how long the command ran', () => {
    const p = buildPayload({ event: 'complete', command: 'doctor', isError: true, durationMs: 1234.6 }, 'i');
    expect(p).toMatchObject({ event: 'complete', command: 'doctor', isError: 1, durationMs: 1235 });
  });

  it('omits a duration that is missing or nonsensical rather than storing a lie', () => {
    for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildPayload({ event: 'complete', durationMs }, 'i')).not.toHaveProperty('durationMs');
    }
  });
});

describe('doctor detail is names, never messages (INT-3190)', () => {
  it('keeps recognised check names', () => {
    expect(buildPayload({ detail: ['node', 'providers'] }, 'i').detail).toBe('node,providers');
  });

  it('drops anything not on the list, including messages that mention a real check', () => {
    // The doctor lines that produce these names also contain versions, paths and
    // port numbers. Only the name may travel.
    const p = buildPayload({
      detail: ['providers', 'node v22 at /Users/unohee/.nvm/versions/node', '/home/x/config.yaml', 'port 3000 in use'],
    }, 'i');
    expect(p.detail).toBe('providers');
    expect(JSON.stringify(p)).not.toMatch(/\/Users\/|\/home\/|nvm|3000/);
  });

  it('omits the field entirely when nothing survives, rather than sending an empty string', () => {
    expect(buildPayload({ detail: ['not-a-check'] }, 'i')).not.toHaveProperty('detail');
    expect(buildPayload({}, 'i')).not.toHaveProperty('detail');
  });

  it('bounds the list so a caller cannot pad the row', () => {
    const p = buildPayload({ detail: Array.from({ length: 50 }, () => 'node') }, 'i');
    expect((p.detail ?? '').split(',').length).toBeLessThanOrEqual(8);
  });
});
