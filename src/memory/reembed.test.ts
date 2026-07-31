import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// memoryCore owns the LanceDB handles and the encoder; reembed is pure orchestration
// over them, so the seam is mocked rather than standing up a real table.
const state = {
  rows: [] as any[],
  createTable: vi.fn(async (_name: string, _rows: any[], _opts?: any) => ({})),
  createEmptyTable: vi.fn(async () => ({})),
  dropTable: vi.fn(async () => {}),
  openTable: vi.fn(async () => ({ name: 'cognitive_memory' })),
  setTable: vi.fn(),
  embedCalls: [] as string[],
};

vi.mock('./memoryCore.js', () => ({
  EMBEDDING_DIM: 4,
  MEMORY_DIR: '/tmp/does-not-matter',
  initDatabase: vi.fn(async () => {}),
  getDb: () => ({
    createTable: state.createTable,
    createEmptyTable: state.createEmptyTable,
    dropTable: state.dropTable,
    openTable: state.openTable,
  }),
  getTable: () => ({
    name: 'cognitive_memory',
    schema: async () => ({ fields: [] }),
    query: () => ({ limit: () => ({ toArray: async () => state.rows }) }),
  }),
  setTable: state.setTable,
  embedPassage: vi.fn(async (text: string) => {
    state.embedCalls.push(text);
    return [1, 2, 3, 4];
  }),
  normalizeRecords: (rows: any[]) =>
    rows.map((r) => ({ ...r, title: String(r.title ?? ''), content: String(r.content ?? ''), vector: [] })),
}));

const { reembedMemoryTable } = await import('./reembed.js');

function row(over: Record<string, unknown> = {}) {
  return { id: 'x', type: 'belief', title: 'T', content: 'C', ...over };
}

beforeEach(() => {
  state.rows = [];
  state.embedCalls = [];
  state.createTable.mockClear().mockImplementation(async () => ({}));
  state.createEmptyTable.mockClear();
  state.dropTable.mockClear();
  state.setTable.mockClear();
});

describe('reembedMemoryTable', () => {
  it('re-encodes every record and reports the counts', async () => {
    state.rows = [row({ id: 'a' }), row({ id: 'b', title: 'T2', content: 'C2' })];

    const result = await reembedMemoryTable({ memoryDir: mkdtempSync(resolve(tmpdir(), 'osw-re-')) });

    expect(result.total).toBe(2);
    expect(result.reembedded).toBe(2);
    expect(result.empty).toBe(0);
    expect(state.embedCalls).toEqual(['T\nC', 'T2\nC2']);
  });

  it('writes a zero vector for a record with no text instead of calling the encoder', async () => {
    state.rows = [row({ id: 'blank', title: '', content: '' })];

    const result = await reembedMemoryTable({ memoryDir: mkdtempSync(resolve(tmpdir(), 'osw-re-')) });

    expect(result.empty).toBe(1);
    expect(result.reembedded).toBe(0);
    expect(state.embedCalls).toEqual([]);
    const written = state.createTable.mock.calls[0][1];
    expect(written[0].vector).toEqual([0, 0, 0, 0]);
  });

  it('builds a temp table before overwriting the live one, then drops it', async () => {
    state.rows = [row()];

    await reembedMemoryTable({ memoryDir: mkdtempSync(resolve(tmpdir(), 'osw-re-')) });

    const names = state.createTable.mock.calls.map((c) => c[0]);
    expect(names[0]).toMatch(/^cognitive_memory_reembed_/); // validated replacement first
    expect(names[1]).toBe('cognitive_memory');
    expect(state.createTable.mock.calls[1][2]).toEqual({ mode: 'overwrite' });
    expect(state.dropTable).toHaveBeenCalledWith(names[0]);
    expect(state.setTable).toHaveBeenCalled();
  });

  it('keeps the recoverable temp table and does not claim the signature when the swap fails', async () => {
    state.rows = [row()];
    const dir = mkdtempSync(resolve(tmpdir(), 'osw-re-'));
    // First call builds the temp table; the overwrite of the live table fails.
    state.createTable
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => { throw new Error('disk full'); });

    await expect(reembedMemoryTable({ memoryDir: dir })).rejects.toThrow('disk full');

    expect(state.dropTable).not.toHaveBeenCalled();
    // A signature written here would advertise vectors the store does not have.
    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(false);
  });

  it('records the embedding signature once the swap succeeded', async () => {
    state.rows = [row()];
    const dir = mkdtempSync(resolve(tmpdir(), 'osw-re-'));

    const result = await reembedMemoryTable({ memoryDir: dir });

    expect(existsSync(resolve(dir, 'embedding.json'))).toBe(true);
    const stored = JSON.parse(readFileSync(resolve(dir, 'embedding.json'), 'utf8'));
    expect(stored.signature).toBe(result.signature);
    expect(result.signature).toContain('multilingual-e5-base');
  });

  it('reports progress at the configured interval', async () => {
    state.rows = [row(), row(), row(), row()];
    const onProgress = vi.fn();

    await reembedMemoryTable({
      memoryDir: mkdtempSync(resolve(tmpdir(), 'osw-re-')),
      onProgress,
      progressEvery: 2,
    });

    expect(onProgress).toHaveBeenCalledWith(2, 4);
    expect(onProgress).toHaveBeenLastCalledWith(4, 4);
  });

  it('handles an empty store without creating a data table', async () => {
    state.rows = [];

    const result = await reembedMemoryTable({ memoryDir: mkdtempSync(resolve(tmpdir(), 'osw-re-')) });

    expect(result.total).toBe(0);
    expect(state.createEmptyTable).toHaveBeenCalled();
    expect(state.createTable).not.toHaveBeenCalled();
  });
});
