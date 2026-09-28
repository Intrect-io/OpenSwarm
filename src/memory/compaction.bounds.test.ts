import { afterEach, describe, expect, it, vi } from 'vitest';

// Compaction rewrites the whole table from the candidate set it collected. If
// that collection silently stops early — which is what a single
// `.search().limit(N)` query does past N, and what an indexed store does at any
// size, since the search returns an approximate candidate set — the rewrite
// drops everything it never saw while still reporting success. The scan must
// therefore be complete, and must refuse rather than truncate when the survivor
// set exceeds what a replacement table can be built from.

const DIM = 4;
const MAX_SURVIVORS = 100_000;

const state = {
  rows: [] as Array<Record<string, unknown>>,
  offsetCalls: 0,
  searchCalls: 0,
  writes: 0,
};

const memoryCore = await vi.importActual<typeof import('./memoryCore.js')>('./memoryCore.js');

vi.mock('./memoryCore.js', () => ({
  ...memoryCore,
  EMBEDDING_DIM: DIM,
  initDatabase: vi.fn(async () => {}),
  getDb: () => ({
    createTable: async () => { state.writes++; },
    createEmptyTable: async () => { state.writes++; },
    openTable: async () => ({}),
    dropTable: async () => {},
  }),
  setTable: () => {},
  getTable: () => ({
    name: 'cognitive_memory',
    schema: async () => ({ fields: [] }),
    query: () => ({
      offset: (offset: number) => {
        state.offsetCalls++;
        return { limit: (limit: number) => ({ toArray: async () => state.rows.slice(offset, offset + limit) }) };
      },
    }),
    // Only reachable if the scan regresses to a capped search().
    search: () => {
      state.searchCalls++;
      return { limit: (limit: number) => ({ toArray: async () => state.rows.slice(0, limit) }) };
    },
  }),
}));

const { compactMemoryTable, removeDuplicates } = await import('./compaction.js');

afterEach(() => {
  state.rows = [];
  state.offsetCalls = 0;
  state.searchCalls = 0;
  state.writes = 0;
});

function storedRow(id: string, vector: number[]) {
  return {
    id,
    type: 'belief',
    repo: 'alpha',
    derivedFrom: 'source',
    metadata: '{"k":1}',
    title: id,
    content: id,
    vector,
    importance: 0.5,
    confidence: 0.7,
    createdAt: 1,
    lastUpdated: 1,
    lastAccessed: 1,
    trust: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe('compactMemoryTable candidate bounds', () => {
  it('refuses instead of rewriting a table whose candidate set exceeds the bound', async () => {
    state.rows = Array.from(
      { length: MAX_SURVIVORS + 1 },
      (_, i) => storedRow(`row-${i}`, [1, 0, 0, 0]),
    );

    await expect(compactMemoryTable()).rejects.toThrow(/refused/);

    // The refusal must land before the replacement, not after a partial rewrite:
    // a compaction that threw halfway would leave a truncated table behind.
    expect(state.writes).toBe(0);
    expect(state.rows).toHaveLength(MAX_SURVIVORS + 1);
  });

  it('scans every page of a table larger than one page instead of a capped query', async () => {
    const total = memoryCore.LEGACY_MIGRATION_PAGE_SIZE + 25;
    state.rows = Array.from({ length: total }, (_, i) =>
      // The tail rows can never be duplicates (each has its own repo bucket), so
      // a scan that skips them cannot hide behind deduplication: they either
      // survive the rewrite or they are gone.
      i < memoryCore.LEGACY_MIGRATION_PAGE_SIZE
        ? storedRow(`row-${i}`, [1, 0, 0, 0])
        : { ...storedRow(`row-${i}`, [1, 0, 0, 0]), repo: `tail-${i}` });

    const stats = await compactMemoryTable();

    // A capped single query would have reported `before` as one page. The 10,000
    // identical rows also deduplicate to exactly one, so the rewrite is proven to
    // carry the tail rather than a partial copy of it.
    expect(stats.before).toBe(total);
    expect(stats.deduplicated).toBe(memoryCore.LEGACY_MIGRATION_PAGE_SIZE - 1);
    expect(stats.after).toBe(26);
  }, 60_000);

  it('never reads through the store search, which is capped and index-approximate', async () => {
    const total = memoryCore.LEGACY_MIGRATION_PAGE_SIZE + 25;
    state.rows = Array.from({ length: total }, (_, i) =>
      storedRow(`row-${i}`, i >= memoryCore.LEGACY_MIGRATION_PAGE_SIZE ? [0, 1, (i % 5) / 10, 0] : [1, 0, 0, 0]));

    await compactMemoryTable();

    // The measured store behaviour: an unfiltered `search()` truncates at its
    // limit, and once a vector index exists it returns an approximate candidate
    // set (24,995 of 25,000 rows on a real store), so a compaction that read
    // through it would rewrite the table without the rows it never received.
    // The scan must therefore page the scalar columns and never call search().
    expect(state.searchCalls).toBe(0);
    expect(state.offsetCalls).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('removeDuplicates bucketing', () => {
  it('keeps unrelated records that share the bucket key but not the similarity', () => {
    // Same repo/type/derivedFrom/metadata — only the vectors differ, so the
    // bucket must still measure similarity rather than treat the key as a match.
    const records = Array.from({ length: 5 }, (_, i) => ({
      ...storedRow(`row-${i}`, Array.from({ length: DIM }, (_, d) => (d === i ? 1 : 0))),
    })) as unknown as Parameters<typeof removeDuplicates>[0];

    expect(removeDuplicates(records).map((record) => record.id)).toEqual([
      'row-0', 'row-1', 'row-2', 'row-3', 'row-4',
    ]);
  });

  it('keeps the most important record of a duplicate group regardless of arrival order', () => {
    const records = [
      { ...storedRow('low', [1, 0, 0, 0]), importance: 0.2 },
      { ...storedRow('high', [1, 0, 0, 0]), importance: 0.9 },
      { ...storedRow('mid', [1, 0, 0, 0]), importance: 0.5 },
    ] as unknown as Parameters<typeof removeDuplicates>[0];

    expect(removeDuplicates(records).map((record) => record.id)).toEqual(['high']);
  });
});
