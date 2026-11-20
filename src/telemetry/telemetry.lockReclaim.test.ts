// recoverTelemetryLock used to read the lock owner, judge it, then unlink the
// PATH. If a live process took a fresh lock between the judgement and the
// unlink, that live lock was deleted (AGT-4903). Reclaimers are now serialized
// by a guard file and judge the lock again under it; only a lock that is still
// the judged one is deleted.
//
// Liveness and namespace proof are stubbed so the race can be injected at the
// exact point of judgement: the stub for processAppearsAlive swaps the lock on
// disk before answering "dead".
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveness = vi.hoisted(() => ({
  processAppearsAlive: vi.fn<(pid: number) => boolean>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: actual, homedir: () => process.env.OSW_TEST_HOME ?? actual.homedir() };
});

vi.mock('../support/processLiveness.js', () => ({
  isProofCapableSpace: () => true,
  sameProcessNamespace: () => true,
  processNamespaceId: () => 'ns-test',
  processAppearsAlive: liveness.processAppearsAlive,
}));

const DEAD_PID = 0x7fffffff;

let home: string;
let previousHome: string | undefined;

function stateDir(): string {
  return join(home, '.config', 'openswarm');
}

function stateFile(): string {
  return join(stateDir(), 'telemetry.json');
}

function lockFile(): string {
  return `${stateFile()}.lock`;
}

function writeLock(owner: { pid: number; token: string }): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(lockFile(), JSON.stringify({ ...owner, ns: 'ns-test' }), { mode: 0o600 });
}

function leftoverQuarantines(): string[] {
  return readdirSync(stateDir()).filter((entry) => entry.includes('.reclaim-'));
}

async function loadTelemetry() {
  vi.resetModules();
  const mod = await import('./telemetry.js');
  mod.initTelemetry({ version: '0.0.0-test', enabled: true });
  return mod;
}

/** Run with the 2 s lock wait collapsed: first Date.now() sets the deadline. */
function withExpiredLockWait(run: () => void): void {
  const base = Date.now();
  let calls = 0;
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
    calls += 1;
    return calls === 1 ? base : base + 6_000;
  });
  try {
    run();
  } finally {
    nowSpy.mockRestore();
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'osw-telemetry-reclaim-'));
  previousHome = process.env.OSW_TEST_HOME;
  process.env.OSW_TEST_HOME = home;
  delete process.env.OPENSWARM_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  liveness.processAppearsAlive.mockReset();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OSW_TEST_HOME;
  else process.env.OSW_TEST_HOME = previousHome;
  vi.restoreAllMocks();
});

describe('telemetry stale lock reclaim — atomic and ownership-safe', () => {
  it('keeps a live lock taken right after the dead owner was judged', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    writeLock({ pid: DEAD_PID, token: 'dead-owner' });

    // While the dead owner is being judged, another process removes the stale
    // file and takes a fresh lock at the same path. Every later liveness check
    // sees that new, live owner.
    liveness.processAppearsAlive.mockImplementation((pid: number) => {
      if (pid === DEAD_PID) {
        writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, token: 'fresh-owner', ns: 'ns-test' }));
        return false;
      }
      return true;
    });

    withExpiredLockWait(() => maybeShowNotice());

    expect(existsSync(lockFile())).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).token).toBe('fresh-owner');
    expect(leftoverQuarantines()).toEqual([]);
  });

  it('still reclaims the lock of a dead owner and writes state under it', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    writeLock({ pid: DEAD_PID, token: 'dead-owner' });
    liveness.processAppearsAlive.mockImplementation((pid: number) => pid !== DEAD_PID);

    maybeShowNotice();

    expect(liveness.processAppearsAlive).toHaveBeenCalledWith(DEAD_PID);
    // Reclaimed, then this process's own lock was taken and released.
    expect(existsSync(lockFile())).toBe(false);
    expect(leftoverQuarantines()).toEqual([]);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8')).installId).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it('reclaims a malformed lock once it is older than the stale window', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lockFile(), 'not-json', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);

    maybeShowNotice();

    expect(existsSync(lockFile())).toBe(false);
    expect(leftoverQuarantines()).toEqual([]);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8')).noticeShown).toBe(true);
  });
});

describe('telemetry lock reclaimers are serialized (#920 review)', () => {
  const guardFile = () => `${lockFile()}.reclaim`;

  it('leaves the stale lock alone while another reclaimer holds the guard', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    writeLock({ pid: DEAD_PID, token: 'dead-owner' });
    writeFileSync(guardFile(), '', { mode: 0o600 });
    liveness.processAppearsAlive.mockImplementation((pid: number) => pid !== DEAD_PID);

    withExpiredLockWait(() => maybeShowNotice());

    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).token).toBe('dead-owner');
    expect(existsSync(guardFile())).toBe(true);
  });

  it('clears a guard left by a reclaimer that died, then reclaims on the next attempt', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    writeLock({ pid: DEAD_PID, token: 'dead-owner' });
    writeFileSync(guardFile(), '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(guardFile(), old, old);
    liveness.processAppearsAlive.mockImplementation((pid: number) => pid !== DEAD_PID);

    maybeShowNotice();

    expect(existsSync(guardFile())).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8')).installId).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });
});
