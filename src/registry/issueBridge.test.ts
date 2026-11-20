import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteRegistryStore as StoreType } from './sqliteStore.js';

// A real store on a temp database, injected through getRegistryStore so the
// bridge runs the production queries rather than a hand-written fake.
const holder: { store?: StoreType } = {};

vi.mock('./sqliteStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sqliteStore.js')>();
  return { ...actual, getRegistryStore: () => holder.store! };
});

const { SqliteRegistryStore } = await import('./sqliteStore.js');
const { getEntitiesForIssue, getEntitiesForIssueBounded } = await import('./issueBridge.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openswarm-issue-bridge-'));
  holder.store = new SqliteRegistryStore(join(dir, 'registry.db'));
});

afterEach(() => {
  holder.store?.close();
  holder.store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('getEntitiesForIssue (AGT-3470)', () => {
  it('merges explicit links and relevant-file entities without duplicates', () => {
    const store = holder.store!;
    const linked = store.registerEntity({ projectId: 'p', kind: 'function', name: 'linked', filePath: 'src/a.ts' });
    store.registerEntity({ projectId: 'p', kind: 'function', name: 'sibling', filePath: 'src/a.ts' });
    store.registerEntity({ projectId: 'p', kind: 'function', name: 'other', filePath: 'src/b.ts' });
    store.linkIssue(linked.id, 'INT-1');

    const names = getEntitiesForIssue('INT-1', ['src/a.ts', 'src/b.ts'], 'p').map((e) => e.name).sort();
    expect(names).toEqual(['linked', 'other', 'sibling']);
  });

  it('caps the aggregate, explicit links first, and stops reading files at the cap', () => {
    const store = holder.store!;
    for (let i = 0; i < 4; i++) {
      const entity = store.registerEntity({ projectId: 'p', kind: 'function', name: `link${i}`, filePath: `src/l${i}.ts` });
      store.linkIssue(entity.id, 'INT-2');
    }
    for (let i = 0; i < 6; i++) {
      store.registerEntity({ projectId: 'p', kind: 'function', name: `file${i}`, filePath: 'src/many.ts' });
    }
    const fileBrief = vi.spyOn(store, 'fileBrief');

    const capped = getEntitiesForIssue('INT-2', ['src/many.ts', 'src/unused.ts'], 'p', { maxEntities: 6 });
    expect(capped).toHaveLength(6);
    expect(capped.slice(0, 4).map((e) => e.name).sort()).toEqual(['link0', 'link1', 'link2', 'link3']);
    // The cap was reached inside the first file, so the second is never read.
    expect(fileBrief).toHaveBeenCalledTimes(1);

    expect(getEntitiesForIssue('INT-2', undefined, 'p', { maxEntities: 2 })).toHaveLength(2);
    expect(getEntitiesForIssue('INT-2', undefined, 'p', { maxEntities: 0 })).toEqual([]);
  });

  it('consults at most maxFiles relevant files', () => {
    const store = holder.store!;
    const files = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
    for (const file of files) store.registerEntity({ projectId: 'p', kind: 'function', name: 'fn', filePath: file });
    const fileBrief = vi.spyOn(store, 'fileBrief');

    expect(getEntitiesForIssue('INT-3', files, 'p', { maxFiles: 2 })).toHaveLength(2);
    expect(fileBrief).toHaveBeenCalledTimes(2);
  });
  it('reports truncated only when a cap cut the result short', () => {
    const store = holder.store!;
    for (let i = 0; i < 3; i++) {
      const entity = store.registerEntity({ projectId: 'p', kind: 'function', name: `t${i}`, filePath: `src/t${i}.ts` });
      store.linkIssue(entity.id, 'INT-4');
    }
    store.registerEntity({ projectId: 'p', kind: 'function', name: 'extra', filePath: 'src/extra.ts' });

    // Everything fits: not truncated.
    expect(getEntitiesForIssueBounded('INT-4', ['src/extra.ts'], 'p', { maxEntities: 4 }))
      .toMatchObject({ truncated: false });
    // Explicit links alone exceed the cap.
    const linksCapped = getEntitiesForIssueBounded('INT-4', undefined, 'p', { maxEntities: 2 });
    expect(linksCapped.entities).toHaveLength(2);
    expect(linksCapped.truncated).toBe(true);
    // Exactly at the cap with nothing left over: not truncated.
    expect(getEntitiesForIssueBounded('INT-4', undefined, 'p', { maxEntities: 3 }).truncated).toBe(false);
    // A relevant-file entity left out at the cap.
    expect(getEntitiesForIssueBounded('INT-4', ['src/extra.ts'], 'p', { maxEntities: 3 }).truncated).toBe(true);
    // Relevant files past maxFiles were never consulted.
    expect(getEntitiesForIssueBounded('INT-4', ['src/extra.ts', 'src/t0.ts'], 'p', { maxFiles: 1 }).truncated).toBe(true);
  });
});
