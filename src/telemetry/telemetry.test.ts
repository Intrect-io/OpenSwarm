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

import { initTelemetry, isTelemetryEnabled, track, buildPayload, serializeTelemetryPayload } from './telemetry.js';

const ENV_KEYS = [
  'OPENSWARM_TELEMETRY',
  'DO_NOT_TRACK',
  'CI',
  'GITHUB_ACTIONS',
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
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe('initTelemetry', () => {
  it('reads the existing install id on init', () => {
    initTelemetry({ version: '1.2.3', enabled: true });
    expect(buildPayload({}, 'i').iid).toBe(TEST_INSTALL_ID);
  });

  it('respects telemetry.enabled=false', () => {
    initTelemetry({ version: '1.2.3', enabled: false });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('respects OPENSWARM_TELEMETRY=0', () => {
    process.env.OPENSWARM_TELEMETRY = '0';
    initTelemetry({ version: '1.2.3', enabled: true });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('respects DO_NOT_TRACK=1', () => {
    process.env.DO_NOT_TRACK = '1';
    initTelemetry({ version: '1.2.3', enabled: true });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('respects CI=1', () => {
    process.env.CI = '1';
    initTelemetry({ version: '1.2.3', enabled: true });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('respects GITHUB_ACTIONS=true', () => {
    process.env.GITHUB_ACTIONS = 'true';
    initTelemetry({ version: '1.2.3', enabled: true });
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe('track', () => {
  it('sends a POST request to the endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await track('test-command', { detail: ['node'] });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telemetry.openswarm.dev/v1/event',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenSwarm' },
      }),
    );
  });

  it('includes the install id in the payload', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await track('test-command', { detail: ['node'] });

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(payload.iid).toBe(TEST_INSTALL_ID);
  });

  it('is fire-and-forget — errors are swallowed', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Network error');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(track('test-command', { detail: ['node'] })).resolves.not.toThrow();
  });

  it('respects the 1s timeout', async () => {
    const fetchMock = vi.fn(() =>
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error('Timeout'));
        }, 2000),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    await track('test-command', { detail: ['node'] });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1500); // Should not wait for the full 2s
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('buildPayload', () => {
  it('includes command, version, os, arch, and node version', () => {
    const p = buildPayload({}, 'i');
    expect(p.cmd).toBe('i');
    expect(p.v).toBe('9.9.9');
    expect(p.os).toBe(process.platform);
    expect(p.arch).toBe(process.arch);
    expect(p.node).toBe(process.version);
  });

  it('truncates long command names', () => {
    const p = buildPayload({}, 'x'.repeat(100));
    expect(p.cmd.length).toBeLessThanOrEqual(32);
  });

  it('normalizes the detail list to a comma-separated string', () => {
    const p = buildPayload({ detail: ['node', 'python'] }, 'i');
    expect(p.detail).toBe('node,python');
  });

  it('escapes commas in detail items', () => {
    const p = buildPayload({ detail: ['node,js'] }, 'i');
    expect(p.detail).toBe('node;js');
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
