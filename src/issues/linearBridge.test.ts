// ============================================
// OpenSwarm - Linear bridge inbound sync pagination tests (AGT-3421)
// ============================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteIssueStore } from './sqliteStore.js';
import { drainLinearIssuesToStore, LINEAR_SYNC_MAX_PAGES, type LinearIssuePage } from './linearBridge.js';

function linearNode(id: string, priority = 3): Record<string, unknown> {
  return {
    id,
    identifier: `INT-${id}`,
    title: `Linear issue ${id}`,
    url: `https://linear.app/i/${id}`,
    description: 'desc',
    priority,
    state: Promise.resolve({ name: 'Todo' }),
  };
}

function page(nodes: unknown[], opts?: { hasNextPage?: boolean; endCursor?: string }): LinearIssuePage {
  return {
    nodes: nodes as any[],
    hasNextPage: opts?.hasNextPage ?? false,
    endCursor: opts?.endCursor,
  };
}

describe('drainLinearIssuesToStore', () => {
  let store: SqliteIssueStore;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new SqliteIssueStore(':memory:');
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    store.close();
  });

  it('applies the limit to the TOTAL imported count across pages, not per page', async () => {
    // Two pages of 30 with a total limit of 50: 50 must be imported and the
    // run must stop there (the old code capped each page at `limit`).
    const pages = [
      page(Array.from({ length: 30 }, (_, i) => linearNode(`a${i}`)), { hasNextPage: true, endCursor: 'c1' }),
      page(Array.from({ length: 30 }, (_, i) => linearNode(`b${i}`)), { hasNextPage: false }),
    ];
    let calls = 0;
    const fetchPage = async () => pages[calls++] ?? page([]);

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 50);

    expect(progress.created).toBe(50);
    expect(progress.updated).toBe(0);
    expect(progress.truncated).toBe(true);
    expect(progress.failed).toBeUndefined();
    expect(calls).toBe(2); // never fetched a third page
    // Durable: the 50th imported issue is queryable by its linear id.
    expect(store.getIssueByLinearId('b19')).not.toBeNull();
    expect(store.listIssues({ source: 'linear', limit: 500, offset: 0 }).total).toBe(50);
  });

  it('bails with an explicit error on a cursor that never advances (repeated)', async () => {
    const fetchPage = async (after?: string) =>
      page(Array.from({ length: 3 }, (_, i) => linearNode(`n${after ?? '0'}-${i}`)), {
        hasNextPage: true,
        endCursor: 'stuck',
      });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 1000);

    // Terminated BEFORE applying the re-served window: only page one is durable.
    expect(progress.failed?.message).toMatch(/repeated cursor/);
    expect(progress.created).toBe(3);
    expect(store.listIssues({ source: 'linear', limit: 500, offset: 0 }).total).toBe(3);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('created 3, updated 0'),
      expect.any(Error),
    );
  });

  it('bails with an explicit error on a missing cursor', async () => {
    const fetchPage = async () =>
      page([linearNode('only')], { hasNextPage: true, endCursor: undefined });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 1000);

    // The first page already claims more data but offers no cursor to continue
    // with — refuse to apply it rather than import an unverifiable window.
    expect(progress.failed?.message).toMatch(/missing cursor/);
    expect(progress.created).toBe(0);
  });

  it('reports the durable import count when an issue fails mid-run', async () => {
    // First issue creates fine; the second (an existing local issue) fails to
    // update. Everything before the failure is committed and reported.
    store.createIssue({ projectId: 'proj', title: 'existing', source: 'linear', linearId: 'lin-2' });
    vi.spyOn(store, 'updateIssue').mockImplementation(() => {
      throw new Error('update exploded');
    });

    const fetchPage = async () =>
      page([linearNode('lin-1'), linearNode('lin-2'), linearNode('lin-3')], { hasNextPage: false });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 1000);

    expect(progress.created).toBe(1);
    expect(progress.updated).toBe(0);
    expect(progress.failed).toBeInstanceOf(Error);
    expect(progress.failed?.message).toBe('update exploded');
    expect(store.getIssueByLinearId('lin-1')).not.toBeNull(); // durable
    expect(store.getIssueByLinearId('lin-3')).toBeNull(); // never reached
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('created 1, updated 0'),
      expect.anything(),
    );
  });

  it('stops deterministically at the page cap even with an endless connection', async () => {
    let cursor = 0;
    const fetchPage = async () => page([linearNode(`p${cursor}`)], {
      hasNextPage: true,
      endCursor: `c${++cursor}`,
    });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, Number.MAX_SAFE_INTEGER);

    expect(cursor).toBe(LINEAR_SYNC_MAX_PAGES);
    expect(progress.created).toBe(LINEAR_SYNC_MAX_PAGES);
    expect(progress.truncated).toBe(true);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('페이지 상한'));
  });

  it('reports a clean end when the connection terminates on its own', async () => {
    const fetchPage = async () => page([linearNode('a')], { hasNextPage: false });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 50);

    expect(progress).toEqual({ created: 1, updated: 0, truncated: false });
  });
});
