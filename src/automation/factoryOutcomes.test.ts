import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openOutcomeDb, readHumanMinutesInDb, recordHumanMinutesInDb } from './factoryOutcomes.js';

// AGT-4810: the human-minutes table is created by any writer on a database
// that predates it, and is read in [from, to).

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('human minutes table', () => {
  it('is created by the outcome writer on an older database and read in [from, to)', () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-outcomes-'));
    roots.push(root);
    const dbPath = join(root, 'automation.db');
    new Database(dbPath).close(); // an existing database without the outcome tables
    const db = openOutcomeDb(dbPath);
    try {
      expect(readHumanMinutesInDb(db, 0, 10_000)).toEqual([]);
      recordHumanMinutesInDb(db, { kind: 'review', minutes: 7, at: 1_000, issue: ' AGT-1 ', note: '  ', actor: 'cli:a' }, 5_000);
      recordHumanMinutesInDb(db, { kind: 'answer', minutes: 2, at: 2_000, actor: 'cli:a' }, 5_000);
      expect(readHumanMinutesInDb(db, 1_000, 2_000)).toEqual([
        { id: 1, kind: 'review', minutes: 7, at: 1_000, issueId: 'AGT-1', note: null, actor: 'cli:a', recordedAt: 5_000 },
      ]);
      expect(readHumanMinutesInDb(db, 1_001, 2_001).map((r) => r.minutes)).toEqual([2]);
      expect(() => recordHumanMinutesInDb(db, { kind: 'review', minutes: 5, at: 1_000, actor: ' ' })).toThrow(/actor/);
      expect(() => recordHumanMinutesInDb(db, { kind: 'review', minutes: 5, at: Number.NaN, actor: 'x' })).toThrow(/time/);
    } finally {
      db.close();
    }
  });
});
