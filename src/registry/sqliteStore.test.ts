import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_QUERY_MAX_LIMIT, ISSUE_LINK_MAX_ENTITIES, LIST_ENTITIES_MAX_LIMIT, SqliteRegistryStore } from './sqliteStore.js';

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
    expect(() => registry.listEntities({ search: '" OR NOT (', limit: 20, offset: 0 })).not.toThrow();
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
      registry.addWarning(entity.id, 'warning', 'correctness', 'warning');
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

// AGT-3421: the risk/status helpers and issue-link lookups were unbounded
// full scans with an N+1 per row — bound and batch them.
describe('bounded helper and issue-link queries (AGT-3421)', () => {
  it('paginates the risk/status helper queries', () => {
    const registry = createStore();
    for (let i = 0; i < 6; i++) {
      registry.registerEntity({
        projectId: 'p', kind: 'function', name: `dep${i}`, filePath: `src/dep${i}.ts`, status: 'deprecated',
      });
    }
    for (let i = 0; i < 4; i++) {
      registry.registerEntity({
        projectId: 'p', kind: 'function', name: `risk${i}`, filePath: `src/risk${i}.ts`,
        hasTests: false, riskLevel: 'high',
      });
    }
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'good', filePath: 'src/g.ts', hasTests: true });

    const deprecatedPage1 = registry.deprecatedEntities('p', 4, 0);
    const deprecatedPage2 = registry.deprecatedEntities('p', 4, 4);
    expect(deprecatedPage1).toHaveLength(4);
    expect(deprecatedPage2).toHaveLength(2);
    const page1Ids = new Set(deprecatedPage1.map(e => e.id));
    expect(deprecatedPage2.every(e => !page1Ids.has(e.id))).toBe(true);

    const untestedPage1 = registry.untestedEntities('p', 2, 0);
    const untestedPage2 = registry.untestedEntities('p', 2, 2);
    expect(untestedPage1).toHaveLength(2);
    expect(untestedPage2).toHaveLength(2);
    expect(new Set([...untestedPage1, ...untestedPage2]).size).toBe(4);

    expect(registry.highRiskEntities('p')).toHaveLength(4);
    expect(registry.highRiskEntities('p', 2, 2)).toHaveLength(2);
    // Small limit pages do not lose data across offsets.
    expect(registry.deprecatedEntities('p', 1000, 0)).toHaveLength(6);
  });

  it('clamps helper page sizes and caps the entities loaded per issue id', () => {
    const registry = createStore();
    // HELPER_QUERY_MAX_LIMIT + 5 high-risk entities, 3 more links than
    // ISSUE_LINK_MAX_ENTITIES: both answers must be capped, not full scans.
    const total = HELPER_QUERY_MAX_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const entity = registry.registerEntity({
        projectId: 'p', kind: 'function', name: `cap${i}`, filePath: `src/cap${i}.ts`, riskLevel: 'high',
      });
      if (i < ISSUE_LINK_MAX_ENTITIES + 3) registry.linkIssue(entity.id, 'INT-CAP');
    }

    expect(registry.highRiskEntities('p', 1_000_000, 0)).toHaveLength(HELPER_QUERY_MAX_LIMIT);
    const linked = registry.getEntitiesByIssueId('INT-CAP');
    expect(linked).toHaveLength(ISSUE_LINK_MAX_ENTITIES);
    // Batch path keeps relation hydration intact.
    expect(linked.every(e => e.projectId === 'p')).toBe(true);
  });

  it('batch-loads entities by issue id and preserves link coverage across projects', () => {
    const registry = createStore();
    const a1 = registry.registerEntity({ projectId: 'a', kind: 'function', name: 'a1', filePath: 'src/a1.ts' });
    const a2 = registry.registerEntity({ projectId: 'a', kind: 'function', name: 'a2', filePath: 'src/a2.ts' });
    const a3 = registry.registerEntity({ projectId: 'a', kind: 'function', name: 'a3', filePath: 'src/a3.ts' });
    const b1 = registry.registerEntity({ projectId: 'b', kind: 'function', name: 'b1', filePath: 'src/b1.ts' });
    for (const entity of [a1, a2, a3, b1]) {
      registry.linkIssue(entity.id, 'INT-9');
      registry.addTag(entity.id, 'layer', 'api');
      registry.addWarning(entity.id, 'warning', 'correctness', 'w');
    }

    const linked = registry.getEntitiesByIssueId('INT-9', 'a');
    expect(new Set(linked.map(e => e.id))).toEqual(new Set([a1.id, a2.id, a3.id]));
    expect(linked.every(e => e.projectId === 'a')).toBe(true);
    // Relations arrive through the batch loaders, not the per-row path.
    expect(linked.every(e => e.tags.length === 1 && e.warnings.length === 1 && e.linkedIssueIds.includes('INT-9'))).toBe(true);

    expect(registry.getEntitiesByIssueId('INT-9', 'b').map(e => e.id)).toEqual([b1.id]);
    expect(registry.getEntitiesByIssueId('INT-404')).toEqual([]);
  });
});
