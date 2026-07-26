// ============================================
// OpenSwarm - store constructor cleanup tests
// ============================================
//
// Adding a retrying WAL conversion gave these constructors a failure path they
// did not have before: setup can now throw. Both stores are reached through
// module-level singletons, so a handle left open on that path stays attached to
// the file for the life of the process.
//
// The obvious version of this test — fail the constructor, then check another
// connection can still convert the database — is worthless: an idle SQLite
// connection holds no lock, so it passes whether or not the handle leaked
// (confirmed by mutation before this was rewritten). The leak has to be
// observed directly, by capturing every Database the constructor opens and
// asserting its state afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RealDatabase from 'better-sqlite3';

const opened = vi.hoisted(() => [] as Array<{ open: boolean }>);

vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof RealDatabase }>();
  const Wrapped = function (...args: unknown[]) {
    const Ctor = actual.default as unknown as new (...a: unknown[]) => { open: boolean };
    const db = new Ctor(...args);
    opened.push(db);
    return db;
  } as unknown as typeof RealDatabase;
  return { ...actual, default: Wrapped };
});

const { SqliteIssueStore } = await import('../issues/sqliteStore.js');
const { SqliteRegistryStore } = await import('../registry/sqliteStore.js');

const roots: string[] = [];
let holder: InstanceType<typeof RealDatabase> | undefined;

/**
 * A database that can never convert to WAL: pinned in delete mode with a read
 * transaction held open, so the exclusive lock the conversion needs is
 * permanently unavailable.
 */
function unconvertibleDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-store-cleanup-'));
  roots.push(root);
  const path = join(root, 'store.db');
  holder = new RealDatabase(path);
  holder.pragma('journal_mode = DELETE');
  holder.exec('CREATE TABLE probe(x)');
  holder.exec('BEGIN');
  holder.prepare('SELECT * FROM probe').all();
  opened.length = 0; // the holder is fixture setup, not the code under test
  return path;
}

beforeEach(() => {
  opened.length = 0;
});

afterEach(() => {
  if (holder) {
    try {
      holder.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone; closing the handle is what matters.
    }
    holder.close();
    holder = undefined;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each([
  ['SqliteIssueStore', (p: string) => new SqliteIssueStore(p) as { close?: () => void }],
  ['SqliteRegistryStore', (p: string) => new SqliteRegistryStore(p) as { close?: () => void }],
])('%s constructor', (_name, construct) => {
  it('closes its handle when WAL setup fails', () => {
    const path = unconvertibleDbPath();

    expect(() => construct(path)).toThrow(/WAL within \d+ms/);

    expect(opened).toHaveLength(1);
    expect(opened[0].open).toBe(false);
  });

  it('keeps the handle open on the success path', () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-store-ok-'));
    roots.push(root);
    const store = construct(join(root, 'store.db'));

    expect(opened).toHaveLength(1);
    expect(opened[0].open).toBe(true);
    store.close?.();
  });
});
