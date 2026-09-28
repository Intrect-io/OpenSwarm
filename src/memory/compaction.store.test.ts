import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// memoryCore resolves MEMORY_DIR from homedir() when the module loads, so the
// store path has to be redirected before it is imported. Everything below is
// imported dynamically, after the redirect, for that reason.
const home = mkdtempSync(join(tmpdir(), 'openswarm-compaction-store-'));
process.env.HOME = home;

const { connect } = await import('@lancedb/lancedb');
const {
  EMBEDDING_DIM,

  PERMANENT_EXPIRY,
} = await import('./memoryCore.js');
const { compactMemoryTable } = await import('./compaction.js');

const memoryDir = join(home, '.openswarm', 'memory');

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(home, { recursive: true, force: true });
});

/**
 * Deterministic pseudo-random unit vector.
 *
 * Unrelated records must be far apart in cosine terms (≈ 1/√dim apart in
 * practice), otherwise the fixture manufactures duplicates of its own and the
 * test cannot tell a boundary miss from a mass merge.
 */
function vector(seed: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIM }, (_, d) => {
    const x = Math.sin(seed * 0.0001 + d * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  });
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

/** A near-twin of `base`: mostly `base` plus a little of a different vector. */
function nearTwin(base: number[], other: number[], mix: number): number[] {
  const blended = base.map((value, i) => (1 - mix) * value + mix * other[i]);
  const norm = Math.hypot(...blended);
  return blended.map((value) => value / norm);
}

function storedRecord(id: string, seed: number, overrides: Record<string, unknown> = {}) {
  // One fixed timestamp for every fixture row. Using Date.now() per row made the
  // "more recent wins" tiebreak depend on whether two records landed in the same
  // millisecond, so a duplicate pair's winner — and this test's outcome — varied
  // between runs.
  const now = 1_700_000_000_000;
  return {
    id,
    type: 'belief',
    repo: 'alpha',
    derivedFrom: 'same-source',
    metadata: '{"k":1}',
    title: id,
    content: `content ${id}`,
    vector: vector(seed),
    importance: 0.5,
    confidence: 0.7,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    trust: 1,
    expiresAt: PERMANENT_EXPIRY,
    ...overrides,
  };
}

describe('compactMemoryTable over a stored table', () => {
  it('merges a duplicate pair that spans a scan page boundary', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(memoryDir, { recursive: true });
    const db = await connect(memoryDir);

    // One page plus one row, with the duplicate pair straddling the boundary:
    // the last row of the first page is a near-twin of the first row of the
    // second page. Deduplicating page by page reports success and keeps both.
    //
    // The page size is injected (25 instead of the 10,000 default) so this
    // drives the REAL paging loop against a REAL LanceDB store without
    // materialising 10,001 × 768-dimension rows. At the default it took ~53 s
    // on an idle machine and blew its own budget under full-suite load — a
    // correct test that fails only when the whole suite runs is not a guard.
    const pageSize = 25;
    // 24 unrelated rows BETWEEN the twin and its near-twin guarantees they land
    // in different pages (row 0 in page 1, row 25 in page 2). Placing them
    // adjacent at the boundary instead would put both in the same page, and a
    // deliberately per-page dedup mutation then still merges them — a test that
    // cannot fail on the bug it names. Verified by mutation.
    const total = pageSize + 1;
    const rows = Array.from({ length: total }, (_, i) => storedRecord(`row-${i}`, i));
    const twinVector = vector(999_001);
    rows[0] = storedRecord('twin', 0, {
      importance: 0.9,
      vector: twinVector,
    });
    rows[pageSize] = storedRecord('twin-duplicate', 0, {
      importance: 0.4,
      vector: nearTwin(twinVector, vector(999_002), 0.03),
    });

    await db.createTable('cognitive_memory', rows, { mode: 'overwrite' });
    const stats = await compactMemoryTable({ pageSize });

    expect(stats.before).toBe(total);
    // The higher-importance twin from the first page replaces the later record.
    expect(stats.deduplicated).toBe(1);
    expect(stats.after).toBe(total - 1);

    const compacted = await db.openTable('cognitive_memory');
    const survivors = await compacted.query().limit(total).toArray();
    const ids = survivors.map((row) => String(row.id));
    expect(ids).toContain('twin');
    expect(ids).not.toContain('twin-duplicate');

    // Rewriting must not destroy embeddings: reading a stored vector back gives
    // an Arrow vector, and treating that as a JS array silently zeroed it.
    const kept = survivors.find((row) => String(row.id) === 'twin');
    const keptVector = Array.from(kept!.vector as Iterable<unknown>, Number);
    expect(keptVector).toHaveLength(EMBEDDING_DIM);
    expect(keptVector.every((value) => Number.isFinite(value))).toBe(true);
    // Lance stores float32, so compare with that precision.
    keptVector.forEach((value, i) => expect(value).toBeCloseTo(twinVector[i], 5));
  }, 120_000);
});
