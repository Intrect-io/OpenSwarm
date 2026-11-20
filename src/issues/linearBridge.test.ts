// ============================================
// OpenSwarm - Linear bridge inbound sync pagination tests (AGT-3421)
// ============================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteIssueStore } from './sqliteStore.js';
import { __setLinearBridgeClientForTests, drainLinearIssuesToStore, LINEAR_SYNC_MAX_PAGES, mapStatusToLinear, syncFromLinear, syncStatusToLinear, type LinearIssuePage } from './linearBridge.js';

const linearAddComment = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../linear/linear.js', () => ({ addComment: linearAddComment }));

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

  it('does not fetch another page when the limit is met exactly at a page end', async () => {
    let calls = 0;
    const fetchPage = async () => {
      calls++;
      return page(Array.from({ length: 5 }, (_, i) => linearNode(`e${calls}-${i}`)), {
        hasNextPage: true,
        endCursor: `c${calls}`,
      });
    };

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 10);

    expect(progress).toEqual({ created: 10, updated: 0, truncated: true });
    expect(calls).toBe(2);
  });

  it('syncFromLinear returns the full progress including truncation', async () => {
    const issues = vi.fn(async (args: { after?: string }) => ({
      nodes: [linearNode(`s-${args.after ?? 'first'}`)],
      pageInfo: { hasNextPage: true, endCursor: `${args.after ?? ''}x` },
    }));
    __setLinearBridgeClientForTests({ issues });

    const progress = await syncFromLinear(store, 'proj', { limit: 2 });

    expect(progress).toEqual({ created: 2, updated: 0, truncated: true });
    expect(issues).toHaveBeenCalledTimes(2);
  });

  it('syncFromLinear surfaces a mid-run failure instead of hiding it behind counts', async () => {
    const issues = vi.fn(async () => ({ nodes: [linearNode('ok')], pageInfo: { hasNextPage: true } }));
    __setLinearBridgeClientForTests({ issues });

    const progress = await syncFromLinear(store, 'proj', { limit: 50 });

    expect(progress.truncated).toBe(false);
    expect(progress.failed?.message).toMatch(/missing cursor/);
  });

  it('reports a clean end when the connection terminates on its own', async () => {
    const fetchPage = async () => page([linearNode('a')], { hasNextPage: false });

    const progress = await drainLinearIssuesToStore(store, 'proj', fetchPage, 50);

    expect(progress).toEqual({ created: 1, updated: 0, truncated: false });
  });
});

describe('syncStatusToLinear companion comment (AGT-4800, #853 review)', () => {
  it('posts a comment through linear.addComment before it changes the Linear state', async () => {
    const updateIssue = vi.fn(async () => ({ success: true }));
    const stateName = mapStatusToLinear('done')[0];
    __setLinearBridgeClientForTests({
      team: async () => ({ states: async () => ({ nodes: [{ id: 'state-done', name: stateName }] }) }),
      updateIssue,
    });
    const store = { getIssue: () => ({ id: 'local-1', linearId: 'lin-1', linearIdentifier: 'AGT-1' }) };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await syncStatusToLinear(store as never, 'local-1', 'done')).toBe(true);
    expect(linearAddComment).toHaveBeenCalledWith('lin-1', expect.stringContaining('Status synced from the local issue store: done'));
    expect(updateIssue).toHaveBeenCalledWith('lin-1', { stateId: 'state-done' });
    expect(linearAddComment.mock.invocationCallOrder[0]).toBeLessThan(updateIssue.mock.invocationCallOrder[0]);
  });
});
