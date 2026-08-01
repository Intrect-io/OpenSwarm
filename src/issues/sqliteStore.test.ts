import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeIssueStore, getIssueStore, SqliteIssueStore } from './sqliteStore.js';

let dir: string | undefined;
function path(name = 'issues.db'): string {
  dir ??= mkdtempSync(join(tmpdir(), 'openswarm-issues-'));
  return join(dir, name);
}

afterEach(() => {
  closeIssueStore();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('SqliteIssueStore durable semantics', () => {
  it('sets closedAt when an issue is created terminal', () => {
    const store = new SqliteIssueStore(path());
    const issue = store.createIssue({ projectId: 'p', title: 'done', status: 'done' });
    expect(issue.closedAt).toBeTruthy();
    store.close();
  });

  it('emits memory_linked only for a newly inserted link', () => {
    const store = new SqliteIssueStore(path());
    const issue = store.createIssue({ projectId: 'p', title: 'link' });
    store.linkMemory(issue.id, 'memory-1');
    store.linkMemory(issue.id, 'memory-1');
    expect(store.getEvents(issue.id).filter((event) => event.type === 'memory_linked')).toHaveLength(1);
    store.close();
  });

  it('clamps malformed pagination before executing SQLite', () => {
    const store = new SqliteIssueStore(path());
    store.createIssue({ projectId: 'p', title: 'one' });
    expect(store.listIssues({ limit: Number.NaN, offset: -10 }).issues).toHaveLength(1);
    expect(store.getRecentEvents(Number.POSITIVE_INFINITY)).toHaveLength(1);
    store.close();
  });

  it('rebuilds FTS rows for an existing database', () => {
    const dbPath = path();
    const store = new SqliteIssueStore(dbPath);
    store.createIssue({ projectId: 'p', title: 'searchable needle' });
    store.close();
    const db = new Database(dbPath);
    db.exec("INSERT INTO issues_fts(issues_fts) VALUES('delete-all')");
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('issues_fts_v1');
    db.close();
    const reopened = new SqliteIssueStore(dbPath);
    expect(reopened.listIssues({ search: 'needle' }).total).toBe(1);
    reopened.close();
  });

  it('rejects a singleton request for a different database path', () => {
    getIssueStore(path('one.db'));
    expect(() => getIssueStore(path('two.db'))).toThrow(/already initialized/);
  });
});

describe('getStats scoping', () => {
  // byProject was the one field that ignored the projectId filter, so a
  // per-project view showed a breakdown counting every project — numbers that
  // did not add up to the total printed beside them.
  it('scopes the project breakdown to the requested project', () => {
    const store = new SqliteIssueStore(path());
    store.createIssue({ projectId: 'alpha', title: 'a1' });
    store.createIssue({ projectId: 'alpha', title: 'a2' });
    store.createIssue({ projectId: 'beta', title: 'b1' });

    const stats = store.getStats('alpha');

    expect(stats.total).toBe(2);
    expect(stats.byProject).toEqual({ alpha: 2 });
    store.close();
  });

  it('agrees with its own total', () => {
    const store = new SqliteIssueStore(path());
    store.createIssue({ projectId: 'alpha', title: 'a1' });
    store.createIssue({ projectId: 'beta', title: 'b1' });
    store.createIssue({ projectId: 'beta', title: 'b2' });

    for (const project of ['alpha', 'beta']) {
      const stats = store.getStats(project);
      const summed = Object.values(stats.byProject).reduce((a, b) => a + b, 0);
      expect(summed).toBe(stats.total);
    }
    store.close();
  });

  it('still reports every project when no filter is given', () => {
    const store = new SqliteIssueStore(path());
    store.createIssue({ projectId: 'alpha', title: 'a1' });
    store.createIssue({ projectId: 'beta', title: 'b1' });

    expect(store.getStats().byProject).toEqual({ alpha: 1, beta: 1 });
    store.close();
  });
});

describe('store permissions (INT-2961 audit)', () => {
  it('keeps the database and its WAL sidecars owner-only', async () => {
    // The store holds issue titles, descriptions and task history for every
    // tracked repository. Under the default umask that is 0644 — readable by
    // any local account — and WAL mode puts most of the payload in the sidecars,
    // which is why the main file alone is not enough.
    const { mkdtempSync, statSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const root = mkdtempSync(join(tmpdir(), 'openswarm-perm-'));
    const dbPath = join(root, 'nested', 'issues.db');
    const store = new SqliteIssueStore(dbPath);

    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(root, 'nested'))).toBe(0o700);
    expect(mode(dbPath)).toBe(0o600);
    // Created by enabling WAL, i.e. after the database file itself — a single
    // chmod at open time would miss both.
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      expect(existsSync(sidecar)).toBe(true);
      expect(mode(sidecar)).toBe(0o600);
    }

    store.close?.();
  });
});
