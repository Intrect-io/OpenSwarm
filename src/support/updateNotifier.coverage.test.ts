// Coverage-focused tests for updateNotifier.ts, complementing updateNotifier.test.ts.
// The existing test file exercises the pure/injectable logic exclusively through
// the `deps` overrides, so the *real* (non-injected) implementations — fetchLatest
// (registry fetch), readCache/writeCache (filesystem), defaultInstall (npm install),
// defaultReexec (respawn + exit) — and the maybeAutoUpdate stale-cache fetch branch
// are never exercised. This file mocks node:fs, node:child_process, and global
// fetch so those code paths can run without touching the network or filesystem.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { isNewer, maybeNotifyUpdate, maybeAutoUpdate } from './updateNotifier.js';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

const base = { argv: ['n', 'c', 'run'], env: {} as NodeJS.ProcessEnv, isTTY: true };

describe('isNewer - missing version segments (`?? 0` branch)', () => {
  it('treats a missing segment as 0 on both sides of the comparison', () => {
    // 'latest' has only 2 segments -> its 3rd segment defaults to 0 via `?? 0`.
    expect(isNewer('0.13', '0.13.1')).toBe(false);
    // 'current' has only 2 segments -> its 3rd segment defaults to 0 via `?? 0`.
    expect(isNewer('0.13.1', '0.13')).toBe(true);
    // Both sides equal after the missing segment defaults to 0 on the 'current'
    // side -> neither the `>` nor the `<` branch fires for that segment.
    expect(isNewer('0.13.0', '0.13')).toBe(false);
  });
});

describe('maybeNotifyUpdate - real readCache/writeCache/fetchLatest', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a valid cache from disk without hitting the network (fresh)', async () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ latest: '9.9.9', checkedAt: 1_000_000 }));
    const write = vi.fn();

    await maybeNotifyUpdate('0.1.0', { ...base, now: () => 1_000_000 + 60_000, write });

    expect(mockedReadFileSync).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('9.9.9');
  });

  it('treats malformed cache JSON as absent (readCache catch branch)', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.0.0' }),
    });
    const write = vi.fn();

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000, write });

    // Cache missing → treated as stale → falls through to a real fetch.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockedMkdirSync).toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('2.0.0');
  });

  it('treats a cache with the wrong shape as absent', async () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ foo: 'bar' }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000 });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fetchLatest returns null on a non-ok HTTP response', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('no cache');
    });
    fetchMock.mockResolvedValue({ ok: false });
    const write = vi.fn();

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000, write });

    // No usable version was fetched and there's no prior cache → no notice printed,
    // but the cache is still stamped with the current version (backoff).
    expect(write).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ latest: '1.0.0', checkedAt: 5_000_000 })
    );
  });

  it('fetchLatest returns null when the response body has no string version', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('no cache');
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: 42 }) });

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000 });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fetchLatest returns null when fetch itself throws (network error)', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('no cache');
    });
    fetchMock.mockRejectedValue(new Error('network down'));
    const write = vi.fn();

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000, write });

    expect(write).not.toHaveBeenCalled();
  });

  it('aborts the fetch after the timeout elapses, exercising the abort-timer callback', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('no cache');
    });
    // Simulate a hung request: only settle (by rejecting, like a real aborted
    // fetch would) once the AbortController's signal actually fires.
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        })
    );
    const write = vi.fn();

    await maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000, write });

    // Aborted -> fetchLatest resolves to null -> no notice, but backoff still stamps the cache.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  }, 5000);

  it('writeCache swallows a filesystem write failure (read-only home)', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('no cache');
    });
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: '2.0.0' }) });
    const write = vi.fn();

    // Must not throw even though the cache write fails.
    await expect(
      maybeNotifyUpdate('1.0.0', { ...base, now: () => 5_000_000, write })
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('2.0.0');
  });
});

describe('maybeAutoUpdate - real install/reexec + stale-fetch branch', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('fetches on a stale cache, retains the local cache marker, and compares in memory (deps-level)', async () => {
    const writeCache = vi.fn();
    const install = vi.fn(() => true);
    const reexec = vi.fn();
    const write = vi.fn();

    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => null, // no cache at all → stale
      now: () => 1_000,
      fetchLatest: async () => '0.13.0',
      writeCache,
      write,
      install,
      reexec,
    });

    expect(writeCache).toHaveBeenCalledWith({ latest: '0.12.0', checkedAt: 1_000 });
    expect(install).toHaveBeenCalledWith('@intrect/openswarm');
    expect(reexec).toHaveBeenCalledOnce();
  });

  it('installs via the real defaultInstall (execFileSync succeeds) and re-execs via defaultReexec', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(''));
    mockedSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    const write = vi.fn();

    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1001,
      write,
      // install/reexec NOT overridden → exercises defaultInstall/defaultReexec.
    });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@intrect/openswarm@latest'],
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(mockedSpawnSync).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('defaultInstall returns false when execFileSync throws, so reexec never runs', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm install failed');
    });
    const write = vi.fn();

    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1001,
      write,
    });

    expect(mockedExecFileSync).toHaveBeenCalledOnce();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[0]).toContain('Auto-update failed');
  });

  it('defaultReexec falls back to exit code 0 when spawnSync reports no status', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(''));
    mockedSpawnSync.mockReturnValue({ status: null } as unknown as ReturnType<typeof spawnSync>);

    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1001,
    });

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('default deps fallbacks (argv/env/isTTY/now/writer)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('maybeNotifyUpdate falls back to real process.argv/env/isTTY when omitted', async () => {
    // No argv/env/isTTY override -> uses the real process globals. The test
    // runner's process.stdout.isTTY is falsy, so shouldSkip short-circuits
    // before any fetch/cache work, without needing further mocking.
    await expect(maybeNotifyUpdate('0.1.0')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maybeNotifyUpdate falls back to the real Date.now() and default stderr writer', async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() })
    );

    // now/write omitted -> uses the real Date.now() (fresh cache) and the
    // default `out` writer (process.stderr.write).
    await maybeNotifyUpdate('0.1.0', { ...base });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('99.0.0');
  });

  it('maybeAutoUpdate falls back to real process.argv/env/isTTY when omitted', async () => {
    await expect(maybeAutoUpdate('0.1.0')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('maybeAutoUpdate falls back to the real Date.now(), readCache, and writeCache', async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ latest: '0.12.0', checkedAt: Date.now() })
    );

    // now/readCache/writeCache omitted -> uses the real implementations. Cache
    // is fresh and already on the current version, so no install is triggered.
    await maybeAutoUpdate('0.12.0', { ...base });

    expect(mockedReadFileSync).toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('maybeAutoUpdate leaves `latest` unset when the stale-cache fetch resolves to null', async () => {
    const writeCache = vi.fn();
    const install = vi.fn(() => true);

    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => null,
      now: () => 2_000,
      fetchLatest: async () => null, // registry error -> `fetched` is falsy
      writeCache,
      install,
    });

    expect(writeCache).toHaveBeenCalledWith({ latest: '0.12.0', checkedAt: 2_000 });
    // latest stays null (no prior cache, no fetch) -> isNewer check short-circuits, no install.
    expect(install).not.toHaveBeenCalled();
  });

  it('maybeAutoUpdate falls back to the default stderr writer when an update is available', async () => {
    // `write` (-> the `out` local) omitted so the default `process.stderr.write`
    // closure is both assigned AND actually invoked (unlike the fresh-cache
    // fallback test above, which returns before reaching any `out(...)` call).
    await maybeAutoUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1001,
      install: vi.fn(() => true),
      reexec: vi.fn(),
    });

    expect(stderrSpy).toHaveBeenCalled();
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('Updating'))).toBe(true);
  });
});
