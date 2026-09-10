import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIST_ENTITIES_MAX_LIMIT, SqliteRegistryStore } from './sqliteStore.js';

let dir: string | undefined;
let store: SqliteRegistryStore | undefined;
function createStore(): SqliteRegistryStore {
  dir = mkdtempSync(join(tmpdir(), 'openswarm-registry-'));
  store = new SqliteRegistryStore(join(dir, 'registry.db'));
  return store;
}

afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  store = undefined;
  dir = undefined;
});

describe('SqliteRegistryStore safe queries', () => {
  it('treats malformed FTS and LIKE metacharacters as literal input', () => {
    const registry = createStore();
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'alpha%_\\beta', filePath: 'src/a.ts' });
    expect(() => registry.listEntities({ search: '" OR NOT (' })).not.toThrow();
    expect(() => registry.searchEntities('%_\\')).not.toThrow();
    expect(registry.searchEntities('%_\\').map((entity) => entity.name)).toContain('alpha%_\\beta');
  });

  it('scopes issue, tag-value, and warning lookups by project', () => {
    const registry = createStore();
    const a = registry.registerEntity({ projectId: 'a', kind: 'function', name: 'sameA', filePath: 'src/a.ts' });
    const b = registry.registerEntity({ projectId: 'b', kind: 'function', name: 'sameB', filePath: 'src/b.ts' });
    for (const entity of [a, b]) {
      registry.linkIssue(entity.id, 'INT-1');
      registry.addTag(entity.id, 'layer', 'api');
      registry.addWarning(entity.id, 'warning', 'complexity', 'warning');
    }
    expect(registry.getEntitiesByIssueId('INT-1', 'a').map((entity) => entity.id)).toEqual([a.id]);
    expect(registry.entitiesByTag('layer', 'api', 'b').map((entity) => entity.id)).toEqual([b.id]);
    expect(registry.getUnresolvedWarnings(undefined, 'a').map((warning) => warning.entityId)).toEqual([a.id]);
  });

  it('clamps listEntities page size to the store query cap', () => {
    const registry = createStore();
    for (let i = 0; i < 5; i++) {
      registry.registerEntity({ projectId: 'p', kind: 'function', name: `fn${i}`, filePath: `src/f${i}.ts` });
    }
    const oversize = registry.listEntities({ projectId: 'p', limit: LIST_ENTITIES_MAX_LIMIT + 1000, offset: 0 });
    expect(oversize.entities.length).toBe(5);
    expect(oversize.total).toBe(5);

    const page = registry.listEntities({ projectId: 'p', limit: 2, offset: 2 });
    expect(page.entities).toHaveLength(2);
    expect(page.total).toBe(5);
  });
});
