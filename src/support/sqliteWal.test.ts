// ============================================
// OpenSwarm - SQLite WAL negotiation tests
// ============================================

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { enableWalWithRetry, isRetryableBusyError } from './sqliteWal.js';

describe('isRetryableBusyError', () => {
  // Extended busy codes must retry like the bare one. Treating them as fatal
  // would rethrow at construction — the exact crash the retry loop prevents.
  it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_TIMEOUT'])(
    'retries on %s',
    (code) => {
      expect(isRetryableBusyError(Object.assign(new Error('busy'), { code }))).toBe(true);
    },
  );

  // Anything else is a real fault and must surface immediately rather than
  // being swallowed into a retry loop that can only time out.
  it.each(['SQLITE_CORRUPT', 'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'SQLITE_LOCKED'])(
    'rethrows on %s',
    (code) => {
      expect(isRetryableBusyError(Object.assign(new Error('fatal'), { code }))).toBe(false);
    },
  );

  it('rethrows errors that carry no code at all', () => {
    expect(isRetryableBusyError(new Error('no code'))).toBe(false);
    expect(isRetryableBusyError(undefined)).toBe(false);
  });
});

describe('enableWalWithRetry', () => {
  it('converts a file database to WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walhelper-'));
    const db = new Database(join(dir, 'a.db'));
    try {
      enableWalWithRetry(db, 1_000);
      expect((db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0].journal_mode).toBe('wal');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An in-memory database reports 'memory' and can never be WAL. Treating that
  // as contention makes the loop spin for the whole budget and then fail an
  // open that previously worked — 13 suite tests went red on exactly this.
  it('accepts an in-memory database instead of retrying to death', () => {
    const db = new Database(':memory:');
    const started = Date.now();
    try {
      expect(() => enableWalWithRetry(db, 5_000)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      db.close();
    }
  });

  it('leaves the caller busy_timeout in place afterwards', () => {
    const db = new Database(':memory:');
    try {
      enableWalWithRetry(db, 4_321);
      expect((db.pragma('busy_timeout') as Array<{ timeout: number }>)[0].timeout).toBe(4_321);
    } finally {
      db.close();
    }
  });
});
