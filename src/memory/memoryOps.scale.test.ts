import { vectorFromArray } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Proves the two memory maintenance paths that were bounded by a single
// `.limit(10_000)` query: expired-record cleanup past the first page, and
// duplicate consolidation over the whole table.
//
// The store mock reproduces the two store behaviours that made those bounds
// wrong — a limit truncates, and a vector column reads back as an Arrow Vector
// (indexing that yields undefined, so cosine similarity over it is NaN and
// every comparison silently fails). Page sizes are the production constants: the
// fixtures really do cross the 10,000-row boundary, so the traversal is not
// merely proven with a shrunken page.

interface StoredRow {
  id: string;
  type: string;
  repo: string;
  derivedFrom: string;
  metadata: string;
  title: string;
  content: string;
  vector: number[];
  importance: number;
  confidence: number;
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  trust: number;
  expiresAt: number;
}

interface FixtureRow {
  id: string;
  type: string;
  repo: string;
  vector: number[];
  importance: number;
  confidence: number;
  expiresAt?: number;
}

// 64 rather than the production 768: low-dimensional random vectors sit near the
// similarity threshold by chance, which would fill the reference output with
// accidental filler groups and hide the clusters this test is about.
const DIM = 64;
const SIMILARITY = 0.85;

const state = {
  rows: [] as StoredRow[],
  deleted: [] as string[],
};

const memoryCore = await vi.importActual<typeof import('./memoryCore.js')>('./memoryCore.js');

/** Lance reads a vector column back as an Arrow Vector, not a JS array. */
function readRow(row: StoredRow): Record<string, unknown> {
  return { ...row, vector: vectorFromArray(new Float32Array(row.vector)) };
}

/** Every query the code under test built, so pushdown can be asserted. */
const queries: Array<{ where?: string; columns?: string[]; rows: number }> = [];

/**
 * Evaluates the two predicate shapes memoryOps sends: an id lookup, and the
 * recent-conversations `"type" = '…' AND ("repo" = '…' OR …)` filter.
 */
function matches(predicate: string): (row: StoredRow) => boolean {
  const typeClause = /"type" = '([^']*)'/.exec(predicate);
  if (typeClause) {
    const repos = [...predicate.matchAll(/"repo" = '([^']*)'/g)].map((match) => match[1]);
    return (row) => row.type === typeClause[1] && repos.includes(row.repo);
  }
  const ids = [...predicate.matchAll(/'([^']*)'/g)].map((match) => match[1].replace(/''/g, "'"));
  return (row) => ids.includes(row.id);
}

interface QuerySpec { where?: string; columns?: string[]; offset?: number; limit?: number }

/** Lance-like chainable query: where/select/offset/limit in any order, then toArray. */
function query(spec: QuerySpec = {}) {
  return {
    where: (predicate: string) => query({ ...spec, where: predicate }),
    select: (columns: string[]) => query({ ...spec, columns }),
    offset: (offset: number) => query({ ...spec, offset }),
    limit: (limit: number) => query({ ...spec, limit }),
    toArray: async () => {
      const rows = spec.where ? state.rows.filter(matches(spec.where)) : state.rows;
      const start = spec.offset ?? 0;
      const page = rows.slice(start, start + (spec.limit ?? rows.length));
      queries.push({ where: spec.where, columns: spec.columns, rows: page.length });
      return page.map((row) => {
        const read = readRow(row);
        return spec.columns ? Object.fromEntries(spec.columns.map((column) => [column, read[column]])) : read;
      });
    },
  };
}

const table = {
  query: () => query(),
  update: async ({ where, values }: { where: string; values: Record<string, unknown> }) => {
    const [id] = [...where.matchAll(/'([^']*)'/g)].map((match) => match[1].replace(/''/g, "'"));
    const row = state.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`missing ${id}`);
    Object.assign(row, values);
  },
  delete: async (predicate: string) => {
    const ids = [...predicate.matchAll(/'([^']*)'/g)].map((match) => match[1].replace(/''/g, "'"));
    state.deleted.push(...ids);
    state.rows = state.rows.filter((row) => !ids.includes(row.id));
  },
  // The pre-fix implementation read through `.search(...).limit(10_000)`.
  search: () => ({ limit: (limit: number) => ({ toArray: async () => state.rows.slice(0, limit).map(readRow) }) }),
  name: 'cognitive_memory',
};

vi.mock('./memoryCore.js', () => ({
  ...memoryCore,
  EMBEDDING_DIM: DIM,
  initDatabase: vi.fn(async () => {}),
  getTable: () => table,
}));

const {
  cleanupExpired,
  consolidateMemories,
  getMemoryStats,
  getRecentConversations,
  selectNewestRows,
  withMemoryMutationLock,
} = await import('./memoryOps.js');

afterEach(() => {
  state.rows = [];
  state.deleted = [];
  queries.length = 0;
});

/** Deterministic pseudo-random unit vector, centred on zero so unrelated
 *  records are not all mutually similar the way positive-only components are. */
function unitVector(seed: number): number[] {
  const values = Array.from({ length: DIM }, (_, d) => Math.sin(seed * 0.0001 + d * 12.9898) * 43758.5453);
  const centered = values.map((value) => value - Math.floor(value) - 0.5);
  const norm = Math.hypot(...centered);
  return centered.map((value) => value / norm);
}

/** Mostly `base` plus a little of `other` — a near-duplicate of `base`. */
function nearTwin(base: number[], other: number[], mix: number): number[] {
  const blended = base.map((value, i) => (1 - mix) * value + mix * other[i]);
  const norm = Math.hypot(...blended);
  return blended.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b));
}

function store(fixture: FixtureRow[]): void {
  // Fixed timestamps: the grouping keeps a record when its importance *or* its
  // lastUpdated is higher, so per-row Date.now() let same-millisecond rows flip
  // a group's winner between runs.
  const now = 1_700_000_000_000;
  state.rows = fixture.map((row) => ({
    type: 'belief',
    repo: 'alpha',
    derivedFrom: 'same-source',
    metadata: '{"k":1}',
    title: row.id,
    content: `content ${row.id}`,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    trust: 1,
    expiresAt: memoryCore.PERMANENT_EXPIRY,
    ...row,
  }));
}

/** Filler rows, spread over many (type, repo) buckets so no bucket is large. */
function filler(count: number, offset: number): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => {
    const index = offset + i;
    return {
      id: `row-${index}`,
      type: 'belief',
      repo: `filler-${index % 50}`,
      vector: unitVector(index),
      importance: 0.5,
      confidence: 0.7,
    };
  });
}

/** Drain pending microtasks: no wall clock, enough hops for the lock chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('cleanupExpired', () => {
  it('removes expired records that live past the first scan page', async () => {
    const pageSize = memoryCore.LEGACY_MIGRATION_PAGE_SIZE;
    const total = pageSize + 50;
    const past = 1_600_000_000_000;
    const fixture = filler(total, 0).map((row, i) =>
      // Only rows past the first page are expired: a single 10,000-row query
      // saw none of them and reported a clean sweep.
      i >= pageSize ? { ...row, expiresAt: past } : row);

    store(fixture);
    await expect(cleanupExpired()).resolves.toBe(50);

    expect(state.deleted).toHaveLength(50);
    expect(state.rows.map((row) => row.id)).toEqual(
      fixture.slice(0, pageSize).map((row) => row.id),
    );
  });

  it('deletes under the mutation lock rather than racing live writers', async () => {
    store(filler(3, 0).map((row) => ({ ...row, expiresAt: 1_600_000_000_000 })));

    const held = Promise.withResolvers<void>();
    const blocker = withMemoryMutationLock(async () => { await held.promise; });
    await flush();

    const cleanup = cleanupExpired();
    await flush();
    // Nothing may be deleted while another mutation holds the lock.
    expect(state.deleted).toEqual([]);

    held.resolve();
    await blocker;
    await expect(cleanup).resolves.toBe(3);
    expect(state.deleted).toHaveLength(3);
  });
});

describe('consolidateMemories', () => {
  it('finds the same duplicate groups as the pairwise reference', async () => {
    const pageSize = memoryCore.LEGACY_MIGRATION_PAGE_SIZE;
    const total = pageSize + 30;

    const familyA = unitVector(500_001);
    const familyB = unitVector(500_002);
    const fixture = filler(total, 0);

    // A duplicate cluster early in scan order. Its own repo bucket keeps filler
    // rows out, so what happens to these ids is unambiguous.
    fixture[2] = { id: 'early-seed', type: 'belief', repo: 'cluster-a', vector: familyA, importance: 0.4, confidence: 0.5 };
    fixture[3] = { id: 'early-late', type: 'belief', repo: 'cluster-a', vector: nearTwin(familyA, familyB, 0.04), importance: 0.9, confidence: 0.9 };
    fixture[4] = { id: 'early-mid', type: 'belief', repo: 'cluster-a', vector: nearTwin(familyA, familyB, 0.08), importance: 0.5, confidence: 0.6 };

    // …and one straddling the page boundary, which a per-page traversal misses.
    fixture[pageSize - 1] = { id: 'boundary-a', type: 'belief', repo: 'cluster-b', vector: familyB, importance: 0.5, confidence: 0.5 };
    fixture[pageSize] = { id: 'boundary-b', type: 'belief', repo: 'cluster-b', vector: nearTwin(familyB, familyA, 0.04), importance: 0.8, confidence: 0.8 };

    // Same vector as the cluster above but another type/repo: never a duplicate.
    fixture[5] = { id: 'other-repo', type: 'belief', repo: 'gamma', vector: familyA, importance: 0.9, confidence: 0.9 };
    fixture[6] = { id: 'other-type', type: 'strategy', repo: 'cluster-a', vector: familyA, importance: 0.9, confidence: 0.9 };

    expect(cosine(familyA, nearTwin(familyA, familyB, 0.08))).toBeGreaterThanOrEqual(SIMILARITY);
    expect(cosine(familyB, nearTwin(familyB, familyA, 0.04))).toBeGreaterThanOrEqual(SIMILARITY);

    const reference = pairwiseReference(fixture);
    const referenceGroups = reference.filter((group) =>
      group.kept.startsWith('early-') || group.kept.startsWith('boundary-'));
    expect(referenceGroups).toEqual([
      { kept: 'early-late', merged: ['early-mid', 'early-seed'] },
      { kept: 'boundary-b', merged: ['boundary-a'] },
    ]);

    store(fixture);
    const result = await consolidateMemories();

    // Acceptance: the bucketed traversal reports exactly what the all-pairs
    // reference reports, boundary-straddling cluster included.
    expect(result.groups).toEqual(reference);
    expect(result.merged).toBe(reference.reduce((sum, group) => sum + group.merged.length, 0));
    expect([...state.deleted].sort()).toEqual(reference.flatMap((group) => group.merged).sort());

    const survivors = state.rows.map((row) => row.id);
    expect(survivors).toContain('early-late');
    expect(survivors).toContain('boundary-b');
    expect(survivors).not.toContain('boundary-a');
    expect(survivors).toContain('other-repo');
    expect(survivors).toContain('other-type');

    // The kept record is boosted and records what it absorbed.
    const kept = state.rows.find((row) => row.id === 'early-late');
    const metadata = memoryCore.safeParseMetadata(kept?.metadata);
    expect([...(metadata.consolidatedFrom as string[])].sort()).toEqual(['early-mid', 'early-seed']);
    expect(kept?.confidence).toBeCloseTo(0.9 + 0.05 * 2, 5);
  }, 120_000);
});

describe('consolidateMemories bounded memory', () => {
  it('consolidateMemories holds at most one bucket of rows at peak', async () => {
    // "Materialised" counts rows that carry the embedding vector: the projected
    // discovery and position scans read only ids/type/repo, so the rows whose
    // size scales with the table are the vector-bearing ones. Each such query
    // must be scoped to one (type, repo) bucket or one id, and no single read
    // may return more rows than the largest bucket. Buckets here are smaller
    // than a page, so a whole bucket arrives in one read.
    const cluster = unitVector(900_001);
    const largest = 30;
    const fixture: FixtureRow[] = [
      ...filler(200, 0),  // 50 filler buckets of 4 rows each
      ...Array.from({ length: largest }, (_, i): FixtureRow => ({
        id: `big-${i}`,
        type: 'strategy',
        repo: 'big',
        vector: nearTwin(cluster, unitVector(900_100 + i), 0.02),
        importance: 0.5,
        confidence: i === 7 ? 0.9 : 0.5,
      })),
    ];
    store(fixture);

    const reference = pairwiseReference(fixture);
    const result = await consolidateMemories();
    expect(result.groups).toEqual(reference);
    expect(result.groups).toContainEqual({
      kept: 'big-7',
      merged: Array.from({ length: largest }, (_, i) => `big-${i}`).filter((id) => id !== 'big-7'),
    });

    const vectorReads = queries.filter((q) => q.columns === undefined || q.columns.includes('vector'));
    expect(vectorReads.length).toBeGreaterThan(0);
    for (const q of vectorReads) {
      expect(q.where).toBeDefined();
      expect(q.where).toMatch(/^("type" = '[^']*' AND "repo" = '[^']*'|id = '[^']*')$/);
    }
    const peak = Math.max(...vectorReads.map((q) => q.rows));
    expect(peak).toBeLessThanOrEqual(largest);
    expect(peak).toBe(largest);
  });
});

describe('getMemoryStats', () => {
  function statsFixture(): FixtureRow[] {
    const pageSize = memoryCore.LEGACY_MIGRATION_PAGE_SIZE;
    const rows = filler(pageSize + 25, 0).map((row, i) => ({
      ...row,
      type: i % 3 === 0 ? 'strategy' : 'belief',
      importance: (i % 10) / 10,
    }));
    // The init sentinel is never counted.
    rows.unshift({ ...rows[0], id: 'init', repo: 'system', type: 'system_pattern' });
    return rows;
  }

  it('getMemoryStats totals rows across more than one page', async () => {
    const fixture = statsFixture();
    store(fixture);

    const counted = fixture.filter((row) => row.id !== 'init');
    const byRepo: Record<string, number> = {};
    for (const row of counted) byRepo[row.repo] = (byRepo[row.repo] ?? 0) + 1;

    const stats = await getMemoryStats();

    expect(stats.total).toBe(counted.length);
    expect(stats.total).toBeGreaterThan(memoryCore.LEGACY_MIGRATION_PAGE_SIZE);
    expect(stats.byType.strategy).toBe(counted.filter((row) => row.type === 'strategy').length);
    expect(stats.byType.belief).toBe(counted.filter((row) => row.type === 'belief').length);
    expect(stats.byType.system_pattern).toBe(0);
    expect(stats.byRepo).toEqual(byRepo);
    expect(stats.avgImportance).toBeCloseTo(
      counted.reduce((sum, row) => sum + row.importance, 0) / counted.length, 9);
    // The table was read in more than one page.
    expect(queries.length).toBeGreaterThanOrEqual(2);
  });

  it('getMemoryStats never selects the vector column', async () => {
    store(statsFixture());
    await getMemoryStats();

    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      // An undefined projection would read every column, vector included.
      expect(q.columns).toBeDefined();
      expect(q.columns).not.toContain('vector');
      expect(q.columns).toEqual(expect.arrayContaining(['id', 'type', 'repo', 'importance']));
    }
  });
});

/**
 * The all-pairs scan consolidation replaced: every record against every later
 * record of the same type/repo, keeping each group anchored on its first member.
 * `merged` is a Set here only because the reference runs over a 10,000-row
 * fixture; the rule itself is what is being mirrored, not its data structure.
 */
function pairwiseReference(rows: FixtureRow[]): Array<{ kept: string; merged: string[] }> {
  const merged = new Set<string>();
  const groups: Array<{ kept: string; merged: string[] }> = [];

  for (let i = 0; i < rows.length; i++) {
    const seed = rows[i];
    if (merged.has(seed.id)) continue;

    const group = [seed];
    for (let j = i + 1; j < rows.length; j++) {
      const candidate = rows[j];
      if (merged.has(candidate.id)) continue;
      if (seed.type !== candidate.type || seed.repo !== candidate.repo) continue;
      if (cosine(seed.vector, candidate.vector) >= SIMILARITY) {
        group.push(candidate);
        merged.add(candidate.id);
      }
    }

    if (group.length > 1) {
      group.sort((a, b) => b.importance * b.confidence - a.importance * a.confidence);
      groups.push({ kept: group[0].id, merged: group.slice(1).map((row) => row.id) });
    }
  }

  return groups;
}

describe('getRecentConversations', () => {
  /** Chat journal row; everything else about it is irrelevant to the lookup. */
  function chatRow(id: string, createdAt: number, channel: string): StoredRow {
    return {
      id,
      type: 'journal',
      repo: 'chat',
      derivedFrom: channel,
      metadata: '{}',
      title: id,
      content: `content ${id}`,
      vector: [0],
      importance: 0.5,
      confidence: 0.7,
      createdAt,
      lastUpdated: createdAt,
      lastAccessed: createdAt,
      trust: 1,
      expiresAt: memoryCore.PERMANENT_EXPIRY,
    };
  }

  it('finds the newest messages even when they sit past the first 100,000 rows', async () => {
    // The previous single `.limit(100_000)` read never reached these rows, so
    // the newest conversation turns of a large store were silently dropped.
    const boundary = 100_000;
    const old = Array.from({ length: boundary }, (_, i) =>
      chatRow(`old-${i}`, 1_000 + (i % 500), i % 2 === 0 ? 'chan-1' : 'chan-2'));
    const newest = [
      chatRow('new-a', 9_000, 'chan-1'),
      chatRow('new-other-channel', 9_500, 'chan-2'),
      chatRow('new-b', 9_100, 'chan-1'),
    ];
    state.rows = [...old, ...newest];

    const recent = await getRecentConversations('chan-1', 3);
    expect(recent.map((r) => r.id)).toEqual(['new-b', 'new-a', 'old-498']);
  });

  it('pushes the type/repo filter down and never reads the vector column', async () => {
    state.rows = [
      chatRow('chat-1', 2_000, 'chan-1'),
      { ...chatRow('discord-1', 3_000, 'chan-1'), repo: 'discord' },
      { ...chatRow('not-journal', 9_000, 'chan-1'), type: 'belief' },
      { ...chatRow('other-repo', 9_000, 'chan-1'), repo: 'alpha' },
    ];

    const recent = await getRecentConversations('chan-1', 10);

    expect(recent.map((r) => r.id)).toEqual(['discord-1', 'chat-1']);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.where).toBe(`"type" = 'journal' AND ("repo" = 'chat' OR "repo" = 'discord')`);
      expect(q.columns).toBeDefined();
      expect(q.columns).not.toContain('vector');
      expect(q.columns).toEqual(expect.arrayContaining(['id', 'createdAt', 'derivedFrom', 'metadata']));
    }
  });
});

describe('selectNewestRows', () => {
  it('matches a full stable sort while holding only the requested rows', async () => {
    const rows = Array.from({ length: 257 }, (_, i) => ({
      id: `r-${i}`,
      // Many ties, so the stable tie-break is exercised.
      createdAt: (i * 7919) % 31,
      keep: i % 3 !== 0,
    }));
    const pages: number[] = [];
    const pageTable = {
      query: () => ({
        offset: (offset: number) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              pages.push(offset);
              return rows.slice(offset, offset + limit);
            },
          }),
        }),
      }),
    };

    const expected = rows
      .filter((r) => r.keep)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((r) => r.id);
    const selected = await selectNewestRows(pageTable, (r) => r.keep, 10, 16);

    expect(selected.map((r) => r.id)).toEqual(expected);
    // Every page was read: 257 rows in pages of 16 is 17 pages.
    expect(pages).toHaveLength(17);
  });

  it('counts a row once when an offset shift returns it on two pages', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r-${i}`, createdAt: 100 + i }));
    // A concurrent insert at the head shifts every row down by one between
    // pages, so the last row of page one is read again at the top of page two.
    const pageTable = {
      query: () => ({
        offset: (offset: number) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              const start = offset === 0 ? 0 : offset - 1;
              return rows.slice(start, start + limit);
            },
          }),
        }),
      }),
    };

    const selected = await selectNewestRows(pageTable, () => true, 8, 4);
    const ids = selected.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['r-7', 'r-6', 'r-5', 'r-4', 'r-3', 'r-2', 'r-1', 'r-0']);
  });

  it('returns nothing for a non-positive limit without reading the table', async () => {
    const query = vi.fn();
    await expect(selectNewestRows({ query }, () => true, 0)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
