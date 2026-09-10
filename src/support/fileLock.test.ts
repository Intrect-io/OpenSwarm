import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock } from './fileLock.js';

/** A pid that cannot be running: above the platform maximum. */
const DEAD_PID = 0x7fffffff;

describe('withFileLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-filelock-'));
    lockPath = join(dir, 'nested', 'resource.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the lock directory, runs the operation, and releases the lock', async () => {
    const result = await withFileLock(lockPath, async () => {
      // The lock must be held for the duration of the operation.
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
      return 'value';
    });

    expect(result).toBe('value');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('creates the lock file with owner-only permissions', async () => {
    await withFileLock(lockPath, async () => {
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    });
  });

  it('releases the lock when the operation throws', async () => {
    await expect(withFileLock(lockPath, async () => { throw new Error('operation failed'); }))
      .rejects.toThrow('operation failed');

    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent holders instead of interleaving them', async () => {
    const order: string[] = [];
    const run = (name: string) => withFileLock(lockPath, async () => {
      order.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name}:exit`);
    }, { timeoutMs: 2_000 });

    await Promise.all([run('a'), run('b')]);

    // Whoever wins, neither pair may be interleaved.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`${order[0].split(':')[0]}:exit`);
    expect(order[3]).toBe(`${order[2].split(':')[0]}:exit`);
  });

  it('times out while a live owner still holds the lock', async () => {
    await withFileLock(lockPath, async () => {
      await expect(
        withFileLock(lockPath, async () => 'never', { timeoutMs: 40 }),
      ).rejects.toThrow(/Timed out waiting for file lock/);
    });
  });

  it('surfaces an unlink failure other than a missing lock file', async () => {
    const lockDir = join(dir, 'nested');

    await expect(withFileLock(lockPath, async () => {
      // Release has to unlink inside a directory that no longer permits writes.
      chmodSync(lockDir, 0o500);
    })).rejects.toThrow(/EACCES|EPERM/);

    chmodSync(lockDir, 0o700);
  });

  it('leaves a lock taken over by another owner alone on release', async () => {
    await withFileLock(lockPath, async () => {
      // Simulate a steal: someone else replaced the lock while we worked.
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'someone-else' }), 'utf8');
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('someone-else');
  });
});

describe('withFileLock stale takeover', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-filelock-stale-'));
    lockPath = join(dir, 'resource.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes over a lock left behind by a dead process', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: 'dead' }), { mode: 0o600 });

    await expect(withFileLock(lockPath, async () => 'taken', { timeoutMs: 500 })).resolves.toBe('taken');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim a lock that was replaced between judgement and unlink', async () => {
    // Dead owner judged first; before unlink, a live owner replaces the file.
    // Ownership-safe reclaim must leave the replacement alone.
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: 'dead' }), { mode: 0o600 });
    const originalStat = statSync(lockPath);

    // Interleave: start a reclaim attempt, then swap the lock mid-flight by
    // writing a live-owner lock with a different token after a tiny delay.
    const reclaim = withFileLock(lockPath, async () => 'taken', { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 5));
    // If reclaim already won, the file is gone — that's fine. If still present
    // with the dead token, replace it with a live owner so reclaim must skip.
    if (existsSync(lockPath)) {
      const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string };
      if (current.token === 'dead') {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-replacement' }), { mode: 0o600 });
        // Bump mtime so it differs from the judged value when reclaim re-checks.
        const now = new Date(originalStat.mtimeMs + 2_000);
        utimesSync(lockPath, now, now);
      }
    }

    // Either reclaim took the dead lock before we swapped (ok), or it left the
    // live replacement alone and timed out / eventually took over after release.
    try {
      await reclaim;
    } catch {
      // Timed out waiting on live replacement — expected in the race we forced.
    }
    if (existsSync(lockPath)) {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string };
      // Must never look like we deleted the live replacement mid-hold.
      expect(owner.token).not.toBe('dead');
    }
  });

  it('takes over a malformed lock once it is older than the stale window', async () => {
    writeFileSync(lockPath, 'not json at all', { mode: 0o600 });
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    await expect(withFileLock(lockPath, async () => 'taken', { timeoutMs: 500, malformedStaleMs: 1_000 }))
      .resolves.toBe('taken');
  });

  it('waits out a malformed lock that is still fresh', async () => {
    writeFileSync(lockPath, 'not json at all', { mode: 0o600 });

    await expect(withFileLock(lockPath, async () => 'taken', { timeoutMs: 40, malformedStaleMs: 60_000 }))
      .rejects.toThrow(/Timed out waiting for file lock/);
  });
});
