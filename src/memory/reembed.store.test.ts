import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Same module-load boundary as compaction.store.test.ts: memoryCore resolves
// MEMORY_DIR from homedir() at import time, so HOME is redirected first and
// everything is imported dynamically. Only the encoder is replaced — loading
// the ONNX model is not what this test is about — the table is a real LanceDB
// store, so the batch reads, appends and the swap run against real Arrow rows.
const home = mkdtempSync(join(tmpdir(), 'openswarm-reembed-store-'));
process.env.HOME = home;
const lockPath = join(home, 'memory-mutation.lock');
process.env.OPENSWARM_MEMORY_MUTATION_LOCK = lockPath;

/** Test hook run inside every encode, i.e. in the middle of the build. */
type EmbedHook = (() => Promise<void>) | null;
const hooks = globalThis as typeof globalThis & { __reembedStoreHook?: EmbedHook };

vi.mock('./memoryCore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memoryCore.js')>();
  return {
    ...actual,
    embedPassage: async (text: string) => {
      await (globalThis as { __reembedStoreHook?: (() => Promise<void>) | null }).__reembedStoreHook?.();
      return Array.from({ length: actual.EMBEDDING_DIM }, (_, d) => ((text.length + d) % 7) / 7 + 0.01);
    },
  };
});

const { connect } = await import('@lancedb/lancedb');
const { EMBEDDING_DIM, PERMANENT_EXPIRY } = await import('./memoryCore.js');
const { reembedMemoryTable } = await import('./reembed.js');

const memoryDir = join(home, '.openswarm', 'memory');

afterAll(async () => {
  hooks.__reembedStoreHook = null;
  delete process.env.OPENSWARM_MEMORY_MUTATION_LOCK;
  await rm(home, { recursive: true, force: true });
});

function storedRecord(i: number) {
  const now = 1_700_000_000_000;
  return {
    id: `row-${i}`,
    type: 'belief',
    repo: 'alpha',
    derivedFrom: 'src',
    metadata: '{}',
    title: `title ${i}`,
    content: `content ${i}`,
    vector: Array.from({ length: EMBEDDING_DIM }, () => 0),
    importance: 0.5,
    confidence: 0.7,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    trust: 1,
    expiresAt: PERMANENT_EXPIRY,
  };
}

describe('reembedMemoryTable over a stored table', () => {
  it('rewrites a store larger than the batch size with every row and a real vector', async () => {
    await mkdir(memoryDir, { recursive: true });
    const db = await connect(memoryDir);
    const total = 7;
    await db.createTable('cognitive_memory', Array.from({ length: total }, (_, i) => storedRecord(i)), { mode: 'overwrite' });
    const before = await db.openTable('cognitive_memory');
    const vectorTypeBefore = String((await before.schema()).fields.find((f) => f.name === 'vector')?.type);

    const result = await reembedMemoryTable({ memoryDir, batchSize: 3 });

    expect(result.total).toBe(total);
    expect(result.reembedded).toBe(total);
    const after = await db.openTable('cognitive_memory');
    expect(await after.countRows()).toBe(total);
    expect(String((await after.schema()).fields.find((f) => f.name === 'vector')?.type)).toBe(vectorTypeBefore);
    const rows = await after.query().limit(total + 1).toArray();
    expect(rows.map((r) => String(r.id)).sort()).toEqual(Array.from({ length: total }, (_, i) => `row-${i}`).sort());
    for (const row of rows) {
      const v = Array.from(row.vector as Iterable<unknown>, Number);
      expect(v).toHaveLength(EMBEDDING_DIM);
      // The fixture stored zero vectors; every row must now carry the new one.
      expect(v.some((x) => x !== 0)).toBe(true);
    }
    // The temp table is gone once the swap succeeded.
    expect((await db.tableNames()).filter((n) => n.includes('_reembed_'))).toEqual([]);
  }, 120_000);
  it('holds the mutation lock and refuses the swap when a second connection commits mid-build', async () => {
    const db = await connect(memoryDir);
    const before = await (await db.openTable('cognitive_memory')).countRows();
    let lockHeldDuringBuild = false;
    let wrote = false;
    hooks.__reembedStoreHook = async () => {
      lockHeldDuringBuild ||= existsSync(lockPath);
      if (wrote) return;
      wrote = true;
      // A writer in another process that does not take the lock.
      const writer = await connect(memoryDir);
      await (await writer.openTable('cognitive_memory')).add([storedRecord(999)]);
    };
    try {
      await expect(reembedMemoryTable({ memoryDir, batchSize: 3 })).rejects.toThrow(
        /Re-embed refused: source table changed during the run/,
      );
    } finally {
      hooks.__reembedStoreHook = null;
    }

    expect(lockHeldDuringBuild).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    const live = await db.openTable('cognitive_memory');
    expect(await live.countRows()).toBe(before + 1);
    expect((await live.query().where(`id = 'row-999'`).toArray())).toHaveLength(1);
    expect((await db.tableNames()).filter((n) => n.includes('_reembed_'))).toEqual([]);
    expect(existsSync(join(memoryDir, '.reembed-swap.json'))).toBe(false);
  }, 120_000);

  it('rebuilds an empty table on the lean schema with the current vector width', async () => {
    const db = await connect(memoryDir);
    // An empty table left on an old encoder's width with a dropped v2 column.
    await db.createTable(
      'cognitive_memory',
      [{ ...storedRecord(0), vector: [0, 0, 0], decay: 0.1 }],
      { mode: 'overwrite' },
    );
    await (await db.openTable('cognitive_memory')).delete('true');

    const result = await reembedMemoryTable({ memoryDir });

    expect(result.total).toBe(0);
    const live = await db.openTable('cognitive_memory');
    expect(await live.countRows()).toBe(0);
    const fields = (await live.schema()).fields;
    const vector = fields.find((f) => f.name === 'vector');
    expect((vector?.type as { listSize?: number }).listSize).toBe(EMBEDDING_DIM);
    expect(fields.map((f) => f.name)).not.toContain('decay');
  }, 120_000);
});
