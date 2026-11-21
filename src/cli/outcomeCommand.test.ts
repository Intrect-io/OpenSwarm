import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { RunLedger } from '../automation/runLedger.js';
import { readHumanMinutesInDb, recordHumanMinutesInDb } from '../automation/factoryOutcomes.js';
import {
  HUMAN_MINUTES_FUTURE_SKEW_MS, OutcomeUsageError, parseHumanMinutes, parseHumanMinutesAt, registerOutcomeCommand, runHumanMinutesCommand,
} from './outcomeCommand.js';

// AGT-4810: `openswarm outcome human-minutes`, the operator's record of the
// time the factory cost them, which the digest divides merges by.

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const NOW = Date.parse('2026-11-20T12:00:00Z');

function ledgerDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-outcome-'));
  roots.push(root);
  const dbPath = join(root, 'automation.db');
  new RunLedger(dbPath).close(); // the real schema, including automation_human_minutes
  return dbPath;
}

function rowCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM automation_human_minutes').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Run the registered subcommand as the CLI would; returns the exit code and stderr. */
function cli(dbPath: string, argv: string[]): { exitCode: number | undefined; stderr: string[]; out: string[] } {
  const stderr: string[] = [];
  const out: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { stderr.push(String(line)); });
  const program = new Command().exitOverride();
  registerOutcomeCommand(program, { dbPath, now: NOW, actor: 'cli:tester', out: (line) => out.push(line) });
  process.exitCode = undefined;
  program.parse(['outcome', 'human-minutes', ...argv], { from: 'user' });
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { exitCode, stderr, out };
}

describe('openswarm outcome human-minutes', () => {
  it('records human minutes and rejects non-integer or out-of-range values', () => {
    const dbPath = ledgerDb();

    for (const bad of ['2.5', '5abc', '0', '1441', '-3', '', ' 5', '05', '1e2', '+5']) {
      expect(() => parseHumanMinutes(bad), bad).toThrow(OutcomeUsageError);
      const { exitCode, stderr } = cli(dbPath, [bad, '--kind', 'review']);
      expect(exitCode, bad).toBe(2);
      expect(stderr.join('\n'), bad).toMatch(/invalid minutes/);
    }
    expect(cli(dbPath, ['--kind', 'review']).exitCode).toBe(2); // no minutes at all
    expect(rowCount(dbPath)).toBe(0);

    // The other usage errors exit 2 and write nothing either.
    for (const argv of [
      ['5'],                                                    // no --kind
      ['5', '--kind', 'coffee'],                                // unknown kind
      ['5', '--kind', 'review', '--at', 'yesterday'],          // not ISO
      ['5', '--kind', 'review', '--at', '2026-11-20T10:00'],   // a time without a zone
      ['5', '--kind', 'review', '--at', '2026-02-31'],          // not a calendar date
      ['5', '--kind', 'review', '--at', '2026-11-20T12:06Z'],  // 6 minutes ahead: past the 5-minute skew
      ['5', '--kind', 'review', '--issue', ' '],                // empty issue
      ['5', '6', '--kind', 'review'],                           // a second positional
      ['5', '--kind', 'review', '--bogus'],                     // an unknown option
      ['5', '--kind'],                                          // --kind without its value
      ['5', '--kind', 'review', '--at'],                        // --at without its value
      ['5', '--kind', 'review', '--issue'],                     // --issue without its value
      ['5', '--kind', 'review', '--note'],                      // --note without its value
    ]) {
      const { exitCode, stderr } = cli(dbPath, argv);
      expect(exitCode, argv.join(' ')).toBe(2);
      expect(stderr.length, argv.join(' ')).toBe(1);
    }
    expect(rowCount(dbPath)).toBe(0);

    // The skew bound is inclusive; ISO dates and offsets are read as written.
    expect(HUMAN_MINUTES_FUTURE_SKEW_MS).toBe(5 * 60_000);
    expect(parseHumanMinutesAt('2026-11-20T12:05Z', NOW)).toBe(NOW + 5 * 60_000);
    expect(parseHumanMinutesAt('2026-11-20', NOW)).toBe(Date.parse('2026-11-20T00:00:00Z'));
    expect(parseHumanMinutesAt('2026-11-20T20:30:00+09:00', NOW)).toBe(Date.parse('2026-11-20T11:30:00Z'));

    // The record function fails closed on its own, and so does the table.
    const db = new Database(dbPath);
    try {
      for (const minutes of [2.5, 0, 1441, Number.NaN]) {
        expect(() => recordHumanMinutesInDb(db, { kind: 'review', minutes, at: NOW, actor: 'x' }), String(minutes)).toThrow(/whole number/);
      }
      expect(() => recordHumanMinutesInDb(db, { kind: 'nap' as 'review', minutes: 5, at: NOW, actor: 'x' })).toThrow(/kind/);
      const insert = db.prepare("INSERT INTO automation_human_minutes(kind, minutes, at, actor, recorded_at) VALUES (?, ?, 0, 'x', 0)");
      expect(() => insert.run('review', 2.5)).toThrow(/CHECK/);
      expect(() => insert.run('review', 0)).toThrow(/CHECK/);
      expect(() => insert.run('review', 1441)).toThrow(/CHECK/);
      expect(() => insert.run('nap', 5)).toThrow(/CHECK/);
    } finally {
      db.close();
    }
    expect(rowCount(dbPath)).toBe(0);

    // A valid record round-trips, through the CLI and directly.
    const ok = cli(dbPath, ['1440', '--kind', 'intervention', '--at', '2026-11-20T09:15:00Z', '--issue', 'AGT-4810', '--note', 'unstuck the merge queue']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr).toEqual([]);
    expect(ok.out).toEqual([`Recorded 1440 intervention minute(s) at 2026-11-20T09:15:00.000Z for AGT-4810 (${dbPath})`]);
    expect(runHumanMinutesCommand('1', { kind: 'answer' }, { dbPath, now: NOW, actor: 'cli:tester', out: () => {} })).toBe(0); // --at defaults to now

    const read = new Database(dbPath, { readonly: true });
    try {
      expect(readHumanMinutesInDb(read, Date.parse('2026-11-20T00:00:00Z'), NOW + 1)).toEqual([
        { id: 1, kind: 'intervention', minutes: 1440, at: Date.parse('2026-11-20T09:15:00Z'), issueId: 'AGT-4810', note: 'unstuck the merge queue', actor: 'cli:tester', recordedAt: NOW },
        { id: 2, kind: 'answer', minutes: 1, at: NOW, issueId: null, note: null, actor: 'cli:tester', recordedAt: NOW },
      ]);
      // [from, to): a row exactly at `to` is not read.
      expect(readHumanMinutesInDb(read, Date.parse('2026-11-20T00:00:00Z'), NOW).map((r) => r.id)).toEqual([1]);
    } finally {
      read.close();
    }
    // Absent table: null, not an empty list, and reading never creates it.
    const bare = new Database(':memory:');
    expect(readHumanMinutesInDb(bare, 0, NOW)).toBeNull();
    expect(bare.prepare("SELECT 1 FROM sqlite_master WHERE name = 'automation_human_minutes'").get()).toBeUndefined();
    bare.close();
  });
});
