import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the PID file: daemon.ts derives its state dir from homedir() at
// module load, so point homedir at a temp dir BEFORE importing the module.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'osw-daemon-test-home-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// Mock only execFile so stopExternalDaemon never spawns a real `launchctl`
// (which could stop the developer's actual daemon). spawn stays real for the
// startDaemon tests.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(() => `${process.execPath} ${join(process.cwd(), 'src', 'index.js')}`),
  };
});

type ExecFileCb = (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;

/** Make the mocked execFile invoke its callback with the given launchctl result. */
function stubExecFile(err: (Error & { code?: number }) | null, stderr = ''): void {
  vi.mocked(execFile).mockImplementation(((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as ExecFileCb;
    cb(err, '', stderr);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

const ORIG_PLATFORM = process.platform;
const ORIG_GETUID = process.getuid;

/** Force process.platform / getuid so the launchctl path is host-independent. */
function setPlatform(platform: NodeJS.Platform, uid: number | undefined): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'getuid', {
    value: uid === undefined ? undefined : () => uid,
    configurable: true,
  });
}

// No real sockets: probeDaemonPort goes through global fetch, which each test
// stubs. This keeps the suite runnable in sandboxes that forbid listen().
function stubFetch(impl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const PID_FILE = join(TEST_HOME, '.config', 'openswarm', 'openswarm.pid');

beforeAll(() => {
  mkdirSync(join(TEST_HOME, '.config', 'openswarm'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(execFile).mockReset();
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
  Object.defineProperty(process, 'getuid', { value: ORIG_GETUID, configurable: true });
  rmSync(PID_FILE, { force: true });
});

describe('probeDaemonPort', () => {
  it('returns true when the daemon API answers 200', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    const fetchFn = stubFetch(async (url) => {
      expect(url).toBe('http://127.0.0.1:3847/api/stats');
      return new Response('{}', { status: 200 });
    });
    expect(await probeDaemonPort()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns false on a non-OK response', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    expect(await probeDaemonPort()).toBe(false);
  });

  it('returns false when the connection is refused', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    expect(await probeDaemonPort()).toBe(false);
  });

  it('returns false when the server hangs past the timeout', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
        })
    );
    expect(await probeDaemonPort(3847, 50)).toBe(false);
  });
});

describe('getDaemonStatusFull', () => {
  it('reports an externally managed daemon when the port answers without a PID file', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    stubFetch(async () => new Response('{}', { status: 200 }));
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(true);
    expect(status.external).toBe(true);
  });

  it('reports not running when neither the PID file nor the port shows a daemon', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    stubFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(false);
    expect(status.external).toBeUndefined();
  });

  it('prefers the PID file and skips the port probe when the PID is alive', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    const fetchFn = stubFetch(async () => new Response('{}', { status: 200 }));
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(true);
    expect(status.external).toBeUndefined();
    expect(status.pid).toBe(process.pid);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('startDaemon duplicate prevention (INT-2473)', () => {
  it('refuses to spawn when the daemon port is already serving (launchd case)', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('{}', { status: 200 }));
    await expect(startDaemon()).rejects.toThrow(/already serving port 3847/);
  });

  it('refuses via the PID file without probing when a spawned daemon is alive', async () => {
    const { startDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    const fetchFn = stubFetch(async () => new Response('{}', { status: 200 }));
    await expect(startDaemon()).rejects.toThrow(/already running \(pid/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('stopExternalDaemon (launchd bootout)', () => {
  it('boots out the launchd job and reports stopped once the port goes quiet', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('darwin', 501);
    stubExecFile(null); // bootout succeeds
    stubFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED'); // port is dead now
    });
    const res = await stopExternalDaemon(1000);
    expect(res.outcome).toBe('stopped');
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'launchctl',
      ['bootout', 'gui/501/com.intrect.openswarm'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('reports not-managed when launchctl has no job under our label', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('darwin', 501);
    stubExecFile(Object.assign(new Error('bootout'), { code: 3 }), 'Boot-out failed: 3: No such process');
    const res = await stopExternalDaemon(1000);
    expect(res.outcome).toBe('not-managed');
  });

  it('reports failed on an unexpected launchctl error', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('darwin', 501);
    stubExecFile(Object.assign(new Error('bootout'), { code: 1 }), 'Operation not permitted');
    const res = await stopExternalDaemon(1000);
    expect(res.outcome).toBe('failed');
    expect(res.detail).toContain('Operation not permitted');
  });

  it('reports failed when the port keeps answering after bootout', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('darwin', 501);
    stubExecFile(null); // bootout "succeeds" but the process never dies
    stubFetch(async () => new Response('{}', { status: 200 }));
    const res = await stopExternalDaemon(300);
    expect(res.outcome).toBe('failed');
  });

  it('reports unsupported off macOS without touching launchctl', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('win32', 501);
    const res = await stopExternalDaemon(1000);
    expect(res.outcome).toBe('unsupported');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('reports unsupported when the platform has no getuid', async () => {
    const { stopExternalDaemon } = await import('./daemon.js');
    setPlatform('darwin', undefined);
    const res = await stopExternalDaemon(1000);
    expect(res.outcome).toBe('unsupported');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});
