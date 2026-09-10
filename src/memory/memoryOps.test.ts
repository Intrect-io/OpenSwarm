import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = {
  records: new Map<string, any>(),
  inFlightUpdates: 0,
  maxInFlightUpdates: 0,
};

vi.mock('./memoryCore.js', () => ({
  EMBEDDING_DIM: 4,
  PERMANENT_EXPIRY: Number.MAX_SAFE_INTEGER,
  normalizeRecords: (records: any[]) => records,
  initDatabase: vi.fn(async () => {}),
  embedPassage: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
  getTable: () => ({
    query: () => ({
      where: (pred: string) => ({
        limit: () => ({
          toArray: async () => {
            const match = /id = '([^']+)'/.exec(pred);
            const id = match?.[1];
            const row = id ? state.records.get(id) : undefined;
            return row ? [{ ...row }] : [];
          },
        }),
      }),
    }),
    update: async ({ where, values }: { where: string; values: Record<string, any> }) => {
      const match = /id = '([^']+)'/.exec(where);
      const id = match?.[1];
      if (!id || !state.records.has(id)) throw new Error(`missing ${id}`);
      state.inFlightUpdates += 1;
      state.maxInFlightUpdates = Math.max(state.maxInFlightUpdates, state.inFlightUpdates);
      await new Promise((r) => setTimeout(r, 15));
      state.records.set(id, { ...state.records.get(id), ...values, id });
      state.inFlightUpdates -= 1;
    },
    delete: async (pred: string) => {
      const ids = [...pred.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      for (const id of ids) state.records.delete(id);
    },
    search: () => ({
      limit: () => ({
        toArray: async () => [...state.records.values()].map((r) => ({ ...r })),
      }),
    }),
  }),
  searchMemory: vi.fn(async () => []),
  calculateFreshness: () => 1,
  safeParseMetadata: (value: unknown) => {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return {}; }
    }
    return (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  },
  logWork: vi.fn(async () => 'id'),
  withMemoryWriteRetry: async <T>(op: () => Promise<T>) => op(),
}));

vi.mock('./embeddingConfig.js', () => ({
  embeddingTextFor: (title: string, content: string) => `${title}\n${content}`,
}));

const {
  withMemoryMutationLock,
  reviseMemory,
  consolidateMemories,
  reconcileContradiction,
} = await import('./memoryOps.js');

function seed(id: string, over: Record<string, unknown> = {}) {
  state.records.set(id, {
    id,
    type: 'belief',
    title: id,
    content: `content-${id}`,
    vector: [1, 0, 0, 0],
    importance: 0.5,
    confidence: 0.7,
    metadata: '{}',
    repo: 'test',
    ...over,
  });
}

beforeEach(() => {
  state.records.clear();
  state.inFlightUpdates = 0;
  state.maxInFlightUpdates = 0;
});

describe('withMemoryMutationLock', () => {
  it('serializes overlapping read-modify-write critical sections', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withMemoryMutationLock(async () => {
      order.push('a:enter');
      await firstHeld;
      order.push('a:exit');
      return 'a';
    });

    await Promise.resolve();
    await Promise.resolve();

    const second = withMemoryMutationLock(async () => {
      order.push('b:enter');
      order.push('b:exit');
      return 'b';
    });

    await Promise.resolve();
    expect(order).toEqual(['a:enter']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });
});

describe('concurrent reviseMemory and consolidateMemories', () => {
  it('keeps Lance updates from concurrent RMW ops from overlapping', async () => {
    seed('keep', {
      vector: [1, 0, 0, 0],
      importance: 0.95,
      confidence: 0.95,
      content: 'shared',
    });
    seed('dup', {
      vector: [1, 0, 0, 0],
      importance: 0.2,
      confidence: 0.2,
      content: 'shared',
    });

    const [revised, consolidated] = await Promise.all([
      reviseMemory('keep', 'revised-by-test', { reason: 'concurrent' }),
      consolidateMemories(),
    ]);

    expect(revised).toBe(true);
    expect(consolidated.merged).toBeGreaterThanOrEqual(0);
    expect(state.maxInFlightUpdates).toBe(1);
    expect(state.records.get('keep')?.content).toBeTruthy();
    expect(() => JSON.parse(state.records.get('keep')!.metadata)).not.toThrow();
  });

  it('queues reconcileContradiction behind an in-flight mutation lock holder', async () => {
    seed('keep');
    seed('archive');

    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const first = withMemoryMutationLock(async () => {
      order.push('outer:enter');
      await hold;
      order.push('outer:exit');
    });

    await Promise.resolve();
    await Promise.resolve();

    const reconcile = reconcileContradiction('keep', 'archive', 'test-reason').then((ok) => {
      order.push('reconcile:done');
      return ok;
    });

    await Promise.resolve();
    expect(order).toEqual(['outer:enter']);

    release();
    await first;
    await expect(reconcile).resolves.toBe(true);
    expect(order).toEqual(['outer:enter', 'outer:exit', 'reconcile:done']);
    expect(JSON.parse(state.records.get('archive')!.metadata).archived.supersededBy).toBe('keep');
  });
});
