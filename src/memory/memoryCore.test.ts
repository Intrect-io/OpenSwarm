import { describe, expect, it } from 'vitest';
import { fetchAllTableRows, LEGACY_MIGRATION_PAGE_SIZE } from './memoryCore.js';

function mockTable(totalRows: number) {
  const rows = Array.from({ length: totalRows }, (_, i) => ({ id: `row-${i}` }));
  const calls: Array<{ offset: number; limit: number }> = [];

  return {
    calls,
    table: {
      query: () => ({
        offset: (offset: number) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              calls.push({ offset, limit });
              return rows.slice(offset, offset + limit);
            },
          }),
        }),
      }),
    },
  };
}

describe('fetchAllTableRows (legacy migration pagination)', () => {
  it('reads every row when the dataset spans more than one page', async () => {
    const pageSize = 7;
    const total = pageSize * 3 + 2; // 23 — past two full page boundaries
    const { table, calls } = mockTable(total);

    const fetched = await fetchAllTableRows(table, pageSize);

    expect(fetched).toHaveLength(total);
    expect(fetched.map((r) => r.id)).toEqual(
      Array.from({ length: total }, (_, i) => `row-${i}`),
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toEqual({ offset: 0, limit: pageSize });
    expect(calls.at(-1)?.offset).toBe(pageSize * 3);
  });

  it('does not stop at the historical 100_000 single-page ceiling', async () => {
    // Simulate a store larger than the old hard cap without allocating 100k objects:
    // page through a virtual count using the real default page size.
    const virtualTotal = LEGACY_MIGRATION_PAGE_SIZE + 3;
    const calls: Array<{ offset: number; limit: number }> = [];
    const table = {
      query: () => ({
        offset: (offset: number) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              calls.push({ offset, limit });
              const end = Math.min(offset + limit, virtualTotal);
              if (offset >= virtualTotal) return [];
              return Array.from({ length: end - offset }, (_, i) => ({ id: offset + i }));
            },
          }),
        }),
      }),
    };

    const fetched = await fetchAllTableRows(table);

    expect(fetched).toHaveLength(virtualTotal);
    expect(calls.length).toBe(2);
    expect(calls[0].limit).toBe(LEGACY_MIGRATION_PAGE_SIZE);
    expect(fetched[LEGACY_MIGRATION_PAGE_SIZE].id).toBe(LEGACY_MIGRATION_PAGE_SIZE);
  });

  it('returns an empty list when the table has no rows', async () => {
    const { table, calls } = mockTable(0);
    await expect(fetchAllTableRows(table, 10)).resolves.toEqual([]);
    expect(calls).toEqual([{ offset: 0, limit: 10 }]);
  });
});
