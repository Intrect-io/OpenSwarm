import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

// Named `fsyncSync` imports in logRotation.ts are closed over at load time; spyOn
// on the namespace is unreliable under Vitest ESM. Intercept via vi.mock instead.
const fsyncControl = vi.hoisted(() => ({
  failOnCall: null as number | null,
  calls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      fsyncControl.calls += 1;
      if (fsyncControl.failOnCall !== null && fsyncControl.calls === fsyncControl.failOnCall) {
        throw Object.assign(new Error('fsync failed'), { code: 'EIO' });
      }
      return actual.fsyncSync(fd);
    },
  };
});

const { rotateServiceLogs } = await import('./logRotation.js');

const roots: string[] = [];
function logDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-log-rotation-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  fsyncControl.failOnCall = null;
  fsyncControl.calls = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rotateServiceLogs', () => {
  it('copy-truncates oversized logs and keeps fixed generations', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'new-current');
    writeFileSync(join(dir, 'stdout.log.1'), 'previous-one');
    writeFileSync(join(dir, 'stdout.log.2'), 'previous-two');

    expect(rotateServiceLogs({ logDir: dir, maxBytes: 4, generations: 2 })).toEqual({
      rotated: ['stdout.log'], skippedLocked: false,
    });
    expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('');
    expect(readFileSync(join(dir, 'stdout.log.1'), 'utf8')).toBe('new-current');
    expect(readFileSync(join(dir, 'stdout.log.2'), 'utf8')).toBe('previous-one');
    expect(existsSync(join(dir, 'stdout.log.3'))).toBe(false);
  });

  it('does not rotate small files or follow symlinks/non-files', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'ok');
    mkdirSync(join(dir, 'stderr.log'));
    expect(rotateServiceLogs({ logDir: dir, maxBytes: 10 })).toEqual({ rotated: [], skippedLocked: false });
    expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('ok');
  });

  it('skips an overlapping rotation and proceeds once the kernel-owned lock is released', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'oversized');
    const lock = new Database(join(dir, '.rotation-lock.db'), { timeout: 0 });
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect(rotateServiceLogs({ logDir: dir, maxBytes: 4 }))
        .toEqual({ rotated: [], skippedLocked: true });
      expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('oversized');
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }

    expect(rotateServiceLogs({ logDir: dir, maxBytes: 4 }))
      .toEqual({ rotated: ['stdout.log'], skippedLocked: false });
  });

  it('restores the active log from the staged archive when post-truncate fsync fails', () => {
    const dir = logDir();
    const logPath = join(dir, 'stdout.log');
    const precious = 'precious-log-data-that-must-survive';
    writeFileSync(logPath, precious);

    // First fsync is the archive; second is the active fd after truncate.
    fsyncControl.failOnCall = 2;

    expect(() => rotateServiceLogs({ logDir: dir, maxBytes: 4 })).toThrow(/fsync failed|EIO/);
    expect(readFileSync(logPath, 'utf8')).toBe(precious);
  });
});
