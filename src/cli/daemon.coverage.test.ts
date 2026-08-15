// Coverage for daemon.ts paths not exercised by daemon.test.ts: the dead-pid
// branch of isProcessAlive, stale-pid-file cleanup, the full startDaemon spawn
// flow (success, spawn failure, missing pid), stopDaemon, and readLogTail.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the PID/log files: daemon.ts derives its state dir from homedir() at
// module load, so point homedir at a temp dir BEFORE importing the module.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'osw-daemon-coverage-test-home-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// resolveIndexPath() computes a path ending in "index.js" from this module's
// own (transpiled, in-memory) location — that file never exists under test.
// Fake that one existsSync check through by default (toggle via indexPathState
// to also exercise the "entrypoint missing" branch); everything else is real fs.
const indexPathState = vi.hoisted(() => ({ exists: true }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
      if (String(path).endsWith('index.js')) return indexPathState.exists;
      return actual.existsSync(path);
    }),
  };
});

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn(),
  execFileSync: vi.fn(() => `${process.execPath} ${join(process.cwd(), 'src', 'index.js')}`),
}));

function stubFetch(impl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

const STATE_DIR = join(TEST_HOME, '.config', 'openswarm');
const PID_FILE = join(STATE_DIR, 'openswarm.pid');
const LOG_FILE = join(STATE_DIR, 'logs', 'openswarm.log');

beforeAll(() => {
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  indexPathState.exists = true;
  rmSync(PID_FILE, { force: true });
  rmSync(LOG_FILE, { force: true });
});

describe('startDaemon', () => {
  it('throws when the compiled entrypoint is missing', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    indexPathState.exists = false;

    await expect(startDaemon()).rejects.toThrow(/Service entrypoint not found/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('cleans up a stale PID file (dead process) before checking the port', async () => {
    const { startDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, '999999999'); // astronomically unlikely to be a live pid
    stubFetch(async () => new Response('', { status: 500 })); // port not serving
    spawnMock.mockImplementation(() => ({ pid: 4242, unref: vi.fn() }));

    const result = await startDaemon();

    expect(result.pid).toBe(4242);
    // Stale file was removed and replaced with the freshly spawned pid.
    expect(readFileSync(PID_FILE, 'utf8').trim()).toBe('4242');
  });

  it('spawns successfully, writes the PID file, and unrefs the child', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    const unref = vi.fn();
    spawnMock.mockImplementation(() => ({ pid: 5150, unref }));

    const result = await startDaemon();

    expect(result).toEqual({ pid: 5150, logFile: LOG_FILE });
    expect(existsSync(PID_FILE)).toBe(true);
    expect(readFileSync(PID_FILE, 'utf8').trim()).toBe('5150');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('closes the log fd and rethrows when spawn() itself throws', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    spawnMock.mockImplementation(() => {
      throw new Error('ENOMEM: cannot fork');
    });

    await expect(startDaemon()).rejects.toThrow(/ENOMEM/);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('throws when the spawned child has no pid assigned', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    spawnMock.mockImplementation(() => ({ pid: undefined, unref: vi.fn() }));

    await expect(startDaemon()).rejects.toThrow(/no pid assigned/);
    expect(existsSync(PID_FILE)).toBe(false);
  });
});

describe('stopDaemon', () => {
  it('returns false when no PID file exists', async () => {
    const { stopDaemon } = await import('./daemon.js');
    expect(await stopDaemon()).toBe(false);
  });

  it('removes a stale PID file (dead process) and returns false', async () => {
    const { stopDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, '999999999');
    expect(await stopDaemon()).toBe(false);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('wraps a failed SIGTERM signal in a descriptive error', async () => {
    const { stopDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true; // alive check passes
      throw new Error('EPERM: not permitted');
    });

    await expect(stopDaemon()).rejects.toThrow(/Failed to signal pid/);
  });

  it('signals and resolves true once the process disappears', async () => {
    const { stopDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    let aliveChecks = 0;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        aliveChecks += 1;
        if (aliveChecks === 1) return true; // pre-check: still alive
        throw new Error('ESRCH'); // first poll inside the wait loop: exited
      }
      return true; // SIGTERM delivered fine
    });

    expect(await stopDaemon()).toBe(true);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('throws when the process outlives the timeout', async () => {
    const { stopDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true; // always alive
      return true;
    });

    await expect(stopDaemon(50)).rejects.toThrow(/did not exit within/);
  });
});

describe('readLogTail', () => {
  it('reports unavailable when the log file does not exist', async () => {
    const { readLogTail } = await import('./daemon.js');
    expect(readLogTail()).toBe('(log file unavailable)');
  });

  it('returns only the last N lines of the log', async () => {
    const { readLogTail } = await import('./daemon.js');
    mkdirSync(join(STATE_DIR, 'logs'), { recursive: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    writeFileSync(LOG_FILE, lines.join('\n'));

    const tail = readLogTail(5);
    expect(tail.split('\n')).toEqual(['line-25', 'line-26', 'line-27', 'line-28', 'line-29']);
  });
});
