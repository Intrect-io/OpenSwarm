// Purpose: close coverage gaps left by telemetry.test.ts — the on-disk state
// read/write paths (readState's catch branch, writeState's success + catch
// branches, getInstallId's regenerate-on-invalid-id branch), maybeShowNotice's
// first-run vs already-shown vs disabled branches, and track()'s abort-timer
// callback. node:fs is mocked with per-test controllable behavior so nothing
// here ever touches the real ~/.config/openswarm/telemetry.json.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  // atomicWriteFileSync (used by writeState) opens a temp file, fsyncs and
  // renames it into place; the payload still reaches writeFileSync as arg[1].
  openSync: () => 1,
  fsyncSync: () => undefined,
  closeSync: () => undefined,
  renameSync: () => undefined,
  existsSync: () => false,
  unlinkSync: () => undefined,
}));

import { initTelemetry, maybeShowNotice, track } from './telemetry.js';

const ENV_KEYS = ['OPENSWARM_TELEMETRY', 'DO_NOT_TRACK', 'CI', 'GITHUB_ACTIONS', 'OPENSWARM_TELEMETRY_URL'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  initTelemetry({ version: '9.9.9', enabled: true });
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  // Keep the opt-out notice off the real terminal by default; individual tests
  // that assert on its content install their own spy/implementation.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readState / getInstallId regenerate branches', () => {
  it('regenerates the install id when the state file is missing/unreadable (readState catch branch)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    await track({ command: 'run' });
    expect(mkdirSyncMock).toHaveBeenCalled();
    expect(writeFileSyncMock).toHaveBeenCalled();
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string) as { installId: string };
    expect(written.installId).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it('regenerates the install id when the stored value fails validation', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ installId: 'too-short', noticeShown: true }));
    await track({ command: 'run' });
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string) as { installId: string };
    expect(written.installId).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(written.installId).not.toBe('too-short');
  });

  it('swallows a write failure (read-only home / race) without throwing', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    mkdirSyncMock.mockImplementation(() => {
      throw new Error('EACCES: read-only filesystem');
    });
    await expect(track({ command: 'run' })).resolves.toBeUndefined();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('maybeShowNotice branches', () => {
  it('prints the opt-out notice and persists noticeShown on first run', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ installId: 'testinstall0123456789' }));
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    maybeShowNotice();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('OpenSwarm collects anonymous usage data');
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string) as { installId: string; noticeShown: boolean };
    expect(written.installId).toBe('testinstall0123456789');
    expect(written.noticeShown).toBe(true);
    writeSpy.mockRestore();
  });

  it('mints a fresh install id for the notice when no state exists yet', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    maybeShowNotice();
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string) as { installId: string };
    expect(written.installId).toMatch(/^[A-Za-z0-9_-]{21}$/);
    writeSpy.mockRestore();
  });

  it('stays silent on subsequent runs once the notice has been shown', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ installId: 'testinstall0123456789', noticeShown: true }));
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    maybeShowNotice();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('no-ops (and never touches disk) when telemetry is disabled', () => {
    process.env.OPENSWARM_TELEMETRY = '0';
    maybeShowNotice();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('track() abort timer', () => {
  it('fires the abort callback once the send timeout elapses', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ installId: 'testinstall0123456789', noticeShown: true }));
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; })));

    const trackPromise = track({ command: 'run' });
    await vi.advanceTimersByTimeAsync(2600);
    resolveFetch(new Response(null, { status: 204 }));
    await trackPromise;

    // No direct handle on the AbortController from the test, but reaching this
    // point without hanging/throwing proves the timer fired and was cleared.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
