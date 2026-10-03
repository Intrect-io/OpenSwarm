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

describe('SqliteRegistryStore.getStats (AGT-4668)', () => {
  type Input = Parameters<SqliteRegistryStore['registerEntity']>[0];

  function seed(registry: SqliteRegistryStore): Input[] {
    const inputs: Input[] = [];
    const kinds = ['function', 'class', 'module'] as const;
    const statuses = ['active', 'active', 'deprecated', 'broken'] as const;
    const risks = ['low', 'medium', 'high'] as const;
    for (let index = 0; index < 60; index++) {
      inputs.push({
        projectId: index % 5 === 0 ? 'other' : 'p',
        kind: kinds[index % kinds.length],
        name: `entity${index}`,
        filePath: `src/file${index}.ts`,
        status: statuses[index % statuses.length],
        hasTests: index % 3 === 0,
        riskLevel: risks[index % risks.length],
      });
    }
    for (const input of inputs) registry.registerEntity(input);
    return inputs;
  }

  // The expected figures are counted straight from the inputs, so a change to the
  // grouped query cannot agree with itself by accident.
  it('reports the same figures as counting the entities one by one', () => {
    const registry = createStore();
    const inputs = seed(registry).filter((input) => input.projectId === 'p');
    const stats = registry.getStats('p');

    expect(stats.total).toBe(inputs.length);
    expect(stats.deprecated).toBe(inputs.filter((input) => input.status === 'deprecated').length);
    expect(stats.untested).toBe(inputs.filter((input) => input.status === 'active' && !input.hasTests).length);
    expect(stats.highRisk).toBe(inputs.filter((input) => input.riskLevel === 'high').length);
    const count = (key: 'kind' | 'status') => Object.fromEntries(
      [...new Set(inputs.map((input) => input[key]))].map((value) => [value, inputs.filter((input) => input[key] === value).length]),
    );
    expect(Object.fromEntries(stats.byKind.map((entry) => [entry.kind, entry.count]))).toEqual(count('kind'));
    expect(Object.fromEntries(stats.byStatus.map((entry) => [entry.status, entry.count]))).toEqual(count('status'));
  });

  it('counts every project when none is given', () => {
    const registry = createStore();
    const inputs = seed(registry);
    expect(registry.getStats().total).toBe(inputs.length);
  });

  it('counts unresolved warnings once per entity, scoped to the project', () => {
    const registry = createStore();
    const a = registry.registerEntity({ projectId: 'p', kind: 'function', name: 'a', filePath: 'src/a.ts' });
    const b = registry.registerEntity({ projectId: 'other', kind: 'function', name: 'b', filePath: 'src/b.ts' });
    registry.addWarning(a.id, 'one', 'complexity', 'warning');
    registry.addWarning(a.id, 'two', 'complexity', 'warning');
    registry.addWarning(b.id, 'three', 'complexity', 'warning');
    expect(registry.getStats('p').withWarnings).toBe(1);
    expect(registry.getStats().withWarnings).toBe(2);
  });

  it('is always fresh unless the caller allows an age', () => {
    const registry = createStore();
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'first', filePath: 'src/a.ts' });
    expect(registry.getStats('p', { maxAgeMs: 60_000 }).total).toBe(1);

    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'second', filePath: 'src/b.ts' });

    // No age given: computed now, so it sees both.
    expect(registry.getStats('p').total).toBe(2);
    // An age given: the recent result is served, by design.
    expect(registry.getStats('p', { maxAgeMs: 60_000 }).total).toBe(1);
  });

  it('recomputes once the allowed age has passed', async () => {
    const registry = createStore();
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'first', filePath: 'src/a.ts' });
    expect(registry.getStats('p', { maxAgeMs: 20 }).total).toBe(1);
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'second', filePath: 'src/b.ts' });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(registry.getStats('p', { maxAgeMs: 20 }).total).toBe(2);
  });

  it('reuses a recent result for the same project only', () => {
    const registry = createStore();
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'first', filePath: 'src/a.ts' });
    const first = registry.getStats('p', { maxAgeMs: 60_000 });
    registry.registerEntity({ projectId: 'p', kind: 'function', name: 'second', filePath: 'src/b.ts' });
    registry.registerEntity({ projectId: 'q', kind: 'function', name: 'third', filePath: 'src/c.ts' });

    expect(registry.getStats('p', { maxAgeMs: 60_000 })).toBe(first);
    expect(registry.getStats('q', { maxAgeMs: 60_000 }).total).toBe(1);
  });
});
