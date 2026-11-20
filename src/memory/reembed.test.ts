import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// memoryCore owns the LanceDB handles and the encoder; reembed is pure orchestration
// over them, so the seam is replaced by a small in-memory table store that honours
// offset/limit paging, add, countRows and overwrite.
const LIVE = 'cognitive_memory';
const state = {
  tables: new Map<string, any[]>(),
  /** Largest page any query asked for or returned, per table. */
  maxPageRead: new Map<string, number>(),
  createTable: vi.fn(),
  createEmptyTable: vi.fn(),
  dropTable: vi.fn(),
  openTable: vi.fn(),
  setTable: vi.fn(),
  embedCalls: [] as string[],
  /** Commit counter per table, like Lance's table version. */
  versions: new Map<string, number>(),
  optimize: vi.fn(),
  lockHeld: false,
  /** Fail appends to the live table, i.e. die mid-swap after the first overwrite. */
  failLiveAdd: false,
  /** Was the cross-process lock held at each live-table overwrite? */
  lockHeldAtOverwrite: [] as boolean[],
};

function bump(name: string) {
  state.versions.set(name, (state.versions.get(name) ?? 0) + 1);
}

function fakeTable(name: string) {
  return {
    name,
    schema: async () => ({ fields: [] }),
    countRows: async () => state.tables.get(name)!.length,
    version: async () => state.versions.get(name) ?? 0,
    optimize: async () => state.optimize(name),
    add: async (rows: any[]) => {
      if (name === LIVE && state.failLiveAdd) throw new Error('killed mid-swap');
      state.tables.get(name)!.push(...rows.map((r) => ({ ...r })));
      bump(name);
      return {};
    },
    query: () => {
      let offset = 0;
      let limit = Infinity;
      const q = {
        offset: (n: number) => { offset = n; return q; },
        limit: (n: number) => { limit = n; return q; },
        toArray: async () => {
          const page = state.tables.get(name)!.slice(offset, offset + limit);
          state.maxPageRead.set(name, Math.max(state.maxPageRead.get(name) ?? 0, page.length, limit));
          return page.map((r) => ({ ...r }));
        },
      };
      return q;
    },
  };
}

function resetDb() {
  state.tables = new Map([[LIVE, []]]);
  state.maxPageRead = new Map();
  state.versions = new Map();
  state.optimize.mockReset();
  state.lockHeld = false;
  state.failLiveAdd = false;
  state.lockHeldAtOverwrite = [];
  state.createTable.mockReset().mockImplementation(async (name: string, rows: any[], opts?: { mode?: string }) => {
    if (state.tables.has(name) && opts?.mode !== 'overwrite') throw new Error(`table ${name} exists`);
    if (name === LIVE) state.lockHeldAtOverwrite.push(state.lockHeld);
    state.tables.set(name, rows.map((r) => ({ ...r })));
    bump(name);
    return fakeTable(name);
  });
  state.createEmptyTable.mockReset().mockImplementation(async (name: string) => {
    state.tables.set(name, []);
    bump(name);
    return fakeTable(name);
  });
  state.dropTable.mockReset().mockImplementation(async (name: string) => { state.tables.delete(name); });
  state.openTable.mockReset().mockImplementation(async (name: string) => fakeTable(name));
  state.setTable.mockReset();
}

vi.mock('./memoryCore.js', () => ({
  EMBEDDING_DIM: 4,
  MEMORY_DIR: '/tmp/does-not-matter',
  initDatabase: vi.fn(async () => {}),
  getDb: () => ({
    createTable: state.createTable,
    createEmptyTable: state.createEmptyTable,
    dropTable: state.dropTable,
    openTable: state.openTable,
    tableNames: async () => [...state.tables.keys()],
  }),
  // Call-through stand-in for the real file lock (which would live under the
  // real home directory): records whether the body runs while it is held.
  withCrossProcessMemoryMutationLock: vi.fn(async (op: () => Promise<unknown>) => {
    state.lockHeld = true;
    try {
      return await op();
    } finally {
      state.lockHeld = false;
    }
  }),
  getTable: () => fakeTable(LIVE),
  setTable: state.setTable,
  embedPassage: vi.fn(async (text: string) => {
    state.embedCalls.push(text);
    return [1, 2, 3, 4];
  }),
  normalizeRecords: (rows: any[]) =>
    rows.map((r) => ({ ...r, title: String(r.title ?? ''), content: String(r.content ?? ''), vector: r.vector ?? [] })),
}));

const { reembedMemoryTable } = await import('./reembed.js');

function row(over: Record<string, unknown> = {}) {
  return { id: 'x', type: 'belief', title: 'T', content: 'C', ...over };
}

const tmp = () => mkdtempSync(resolve(tmpdir(), 'osw-re-'));

const { embedPassage } = await import('./memoryCore.js');
const embedMock = () => embedPassage as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDb();
  state.embedCalls = [];
  embedMock().mockImplementation(async (text: string) => {
    state.embedCalls.push(text);
    return [1, 2, 3, 4];
  });
});

describe('reembedMemoryTable', () => {
  it('re-encodes every record and reports the counts', async () => {
    state.tables.set(LIVE, [row({ id: 'a' }), row({ id: 'b', title: 'T2', content: 'C2' })]);

    const result = await reembedMemoryTable({ memoryDir: tmp() });

    expect(result.total).toBe(2);
    expect(result.reembedded).toBe(2);
    expect(result.empty).toBe(0);
    expect(state.embedCalls).toEqual(['T\nC', 'T2\nC2']);
    expect(state.tables.get(LIVE)!.map((r) => r.vector)).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);
  });

  it('writes a zero vector for a record with no text instead of calling the encoder', async () => {
    state.tables.set(LIVE, [row({ id: 'blank', title: '', content: '' })]);

    const result = await reembedMemoryTable({ memoryDir: tmp() });

    expect(result.empty).toBe(1);
    expect(result.reembedded).toBe(0);
    expect(state.embedCalls).toEqual([]);
    const written = state.createTable.mock.calls[0][1];
    expect(written[0].vector).toEqual([0, 0, 0, 0]);
  });

  it('builds a temp table before overwriting the live one, then drops it', async () => {
    state.tables.set(LIVE, [row()]);

    await reembedMemoryTable({ memoryDir: tmp() });

    const names = state.createTable.mock.calls.map((c) => c[0]);
    expect(names[0]).toMatch(/^cognitive_memory_reembed_/); // validated replacement first
    expect(names[1]).toBe(LIVE);
    expect(state.createTable.mock.calls[1][2]).toEqual({ mode: 'overwrite' });
    expect(state.dropTable).toHaveBeenCalledWith(names[0]);
    expect(state.tables.has(names[0])).toBe(false);
    expect(state.setTable).toHaveBeenCalled();
  });

  it('keeps the recoverable temp table and does not claim the signature when the swap fails', async () => {
    state.tables.set(LIVE, [row()]);
    const dir = tmp();
    const create = state.createTable.getMockImplementation()!;
    // Building the temp table works; the overwrite of the live table fails.
    state.createTable.mockImplementation(async (name: string, rows: any[], opts?: { mode?: string }) => {
      if (opts?.mode === 'overwrite') throw new Error('disk full');
      return create(name, rows, opts);
    });

    await expect(reembedMemoryTable({ memoryDir: dir })).rejects.toThrow('disk full');

    expect(state.dropTable).not.toHaveBeenCalled();
    // A signature written here would advertise vectors the store does not have.
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);
  });

  it('records the embedding signature once the swap succeeded', async () => {
    state.tables.set(LIVE, [row()]);
    const dir = tmp();

    const result = await reembedMemoryTable({ memoryDir: dir });

    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(true);
    const stored = JSON.parse(readFileSync(resolve(dir, 'embedding.json'), 'utf8'));
    expect(stored.signature).toBe(result.signature);
    expect(result.signature).toContain('multilingual-e5-base');
  });

  it('reports progress at the configured interval', async () => {
    state.tables.set(LIVE, [row(), row(), row(), row()]);
    const onProgress = vi.fn();

    await reembedMemoryTable({ memoryDir: tmp(), onProgress, progressEvery: 2 });

    expect(onProgress).toHaveBeenCalledWith(2, 4);
    expect(onProgress).toHaveBeenLastCalledWith(4, 4);
  });

  it('handles an empty store without creating a data table', async () => {
    const result = await reembedMemoryTable({ memoryDir: tmp() });

    expect(result.total).toBe(0);
    expect(state.createEmptyTable).toHaveBeenCalled();
    expect(state.createTable).not.toHaveBeenCalled();
  });

  it('re-embeds a store larger than the batch size without reading more than a batch at once', async () => {
    const source = Array.from({ length: 23 }, (_, i) => row({ id: `r${i}`, title: `T${i}` }));
    state.tables.set(LIVE, source);

    const result = await reembedMemoryTable({ memoryDir: tmp(), batchSize: 5 });

    expect(result.total).toBe(23);
    expect(result.reembedded).toBe(23);
    const live = state.tables.get(LIVE)!;
    expect(live).toHaveLength(23);
    expect(live.map((r) => r.id)).toEqual(source.map((r) => r.id));
    expect(live.every((r) => r.vector.length === 4 && r.vector[0] === 1)).toBe(true);
    for (const [, max] of state.maxPageRead) expect(max).toBeLessThanOrEqual(5);
    // Every write is a batch, never the whole table.
    for (const call of state.createTable.mock.calls) expect(call[1].length).toBeLessThanOrEqual(5);
  });

  it('refuses to swap and keeps the live table when the source row count changes mid-run', async () => {
    const source = Array.from({ length: 12 }, (_, i) => row({ id: `r${i}` }));
    state.tables.set(LIVE, source);
    const dir = tmp();
    // A row lands in the live table while the batches are being read: the
    // count taken up front no longer matches what was read.
    let reads = 0;
    embedMock().mockImplementation(async (text: string) => {
      state.embedCalls.push(text);
      if (++reads === 1) state.tables.get(LIVE)!.push(row({ id: 'late' }));
      return [1, 2, 3, 4];
    });

    await expect(reembedMemoryTable({ memoryDir: dir, batchSize: 5 })).rejects.toThrow(/Re-embed refused/);

    expect(state.createTable.mock.calls.some((c) => c[0] === LIVE)).toBe(false);
    expect(state.tables.get(LIVE)!.every((r) => r.vector === undefined)).toBe(true);
    expect([...state.tables.keys()]).toEqual([LIVE]); // incomplete temp table dropped
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);
  });
  it('runs the build and the swap under the cross-process memory mutation lock', async () => {
    state.tables.set(LIVE, [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    const heldDuringEncode: boolean[] = [];
    embedMock().mockImplementation(async () => {
      heldDuringEncode.push(state.lockHeld);
      return [1, 2, 3, 4];
    });

    await reembedMemoryTable({ memoryDir: tmp(), batchSize: 2 });

    expect(heldDuringEncode).toEqual([true, true, true]);
    expect(state.lockHeldAtOverwrite).toEqual([true]);
    expect(state.lockHeld).toBe(false);
  });

  it('refuses to swap when another writer committed to the source although the row count still matches', async () => {
    state.tables.set(LIVE, [row({ id: 'a' }), row({ id: 'b' })]);
    const dir = tmp();
    let calls = 0;
    embedMock().mockImplementation(async () => {
      // An update commit from a writer that ignored the lock: same row count, new version.
      if (++calls === 1) bump(LIVE);
      return [1, 2, 3, 4];
    });

    await expect(reembedMemoryTable({ memoryDir: dir })).rejects.toThrow(/Re-embed refused: source table changed/);

    expect(state.createTable.mock.calls.some((c) => c[0] === LIVE)).toBe(false);
    expect([...state.tables.keys()]).toEqual([LIVE]);
    expect(existsSync(resolve(dir, '.reembed-swap.json'))).toBe(false);
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);
  });

  it('keeps a swap marker and the full temp table when the swap dies after the first overwrite, and the next run refuses', async () => {
    state.tables.set(LIVE, Array.from({ length: 5 }, (_, i) => row({ id: `r${i}` })));
    const dir = tmp();
    state.failLiveAdd = true;

    await expect(reembedMemoryTable({ memoryDir: dir, batchSize: 2 })).rejects.toThrow('killed mid-swap');

    const markerPath = resolve(dir, '.reembed-swap.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.liveTable).toBe(LIVE);
    expect(marker.sourceRows).toBe(5);
    expect(state.tables.get(marker.tempTable)).toHaveLength(5);
    expect(state.tables.get(LIVE)).toHaveLength(2); // partial live table
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);

    state.failLiveAdd = false;
    const encodesBefore = state.embedCalls.length;
    await expect(reembedMemoryTable({ memoryDir: dir, batchSize: 2 })).rejects.toThrow(
      new RegExp(`interrupted.*${marker.tempTable}`),
    );
    expect(state.embedCalls.length).toBe(encodesBefore);
    expect(state.tables.get(marker.tempTable)).toHaveLength(5);
    expect(state.tables.get(LIVE)).toHaveLength(2);
  });

  it('refuses to run while a leftover re-embed table exists without a swap marker', async () => {
    state.tables.set(LIVE, [row()]);
    state.tables.set(`${LIVE}_reembed_123`, [row()]);

    await expect(reembedMemoryTable({ memoryDir: tmp() })).rejects.toThrow(/leftover table\(s\) cognitive_memory_reembed_123/);

    expect(state.embedCalls).toEqual([]);
    expect(state.createTable).not.toHaveBeenCalled();
  });

  it('optimizes the swapped live table once and no other table', async () => {
    state.tables.set(LIVE, Array.from({ length: 4 }, (_, i) => row({ id: `r${i}` })));

    await reembedMemoryTable({ memoryDir: tmp(), batchSize: 2 });

    expect(state.optimize).toHaveBeenCalledTimes(1);
    expect(state.optimize).toHaveBeenCalledWith(LIVE);
  });

  it('retries a row whose encode fails before giving up on the run', async () => {
    state.tables.set(LIVE, [row({ id: 'a' })]);
    let calls = 0;
    embedMock().mockImplementation(async () => {
      if (++calls <= 2) throw new Error('transient encoder failure');
      return [1, 2, 3, 4];
    });

    const result = await reembedMemoryTable({ memoryDir: tmp(), embedRetryDelayMs: 0 });

    expect(calls).toBe(3);
    expect(result.reembedded).toBe(1);
    expect(state.tables.get(LIVE)![0].vector).toEqual([1, 2, 3, 4]);
  });

  it('aborts with the live table untouched when a row keeps failing to encode', async () => {
    state.tables.set(LIVE, [row({ id: 'a' }), row({ id: 'b' })]);
    const dir = tmp();
    let calls = 0;
    embedMock().mockImplementation(async () => {
      calls++;
      throw new Error('encoder down');
    });

    await expect(reembedMemoryTable({ memoryDir: dir, embedRetryDelayMs: 0 })).rejects.toThrow('encoder down');

    expect(calls).toBe(3);
    expect(state.tables.get(LIVE)!.every((r) => r.vector === undefined)).toBe(true);
    expect([...state.tables.keys()]).toEqual([LIVE]);
    expect(existsSync(resolve(dir, '.reembed-swap.json'))).toBe(false);
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);
  });

  it('rebuilds an empty store on the lean schema with the current vector width', async () => {
    await reembedMemoryTable({ memoryDir: tmp() });

    expect(state.createEmptyTable).toHaveBeenCalledTimes(2); // temp table, then the live overwrite
    for (const [, schema] of state.createEmptyTable.mock.calls) {
      const fields = schema.fields as Array<{ name: string; type: { listSize?: number } }>;
      expect(fields.find((f) => f.name === 'vector')?.type.listSize).toBe(4);
      // The live table's own schema (empty in this fake) is no longer copied.
      expect(fields.map((f) => f.name)).toEqual(expect.arrayContaining(['id', 'title', 'content', 'vector']));
    }
    expect(state.createEmptyTable.mock.calls[1][2]).toEqual({ mode: 'overwrite' });
  });
});
