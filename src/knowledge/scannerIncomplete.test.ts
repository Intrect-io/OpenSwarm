// AGT-3490 — a truncated knowledge-graph scan must be distinguishable from a
// complete one, in the graph, its persisted form, and its exported snapshot.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import { buildSnapshot } from './graphqlExporter.js';
import { incrementalUpdate, scanProject } from './scanner.js';
import { SerializedGraphSchema } from './types.js';

let tmp: string;

async function writeProjectFile(path: string, content: string): Promise<void> {
  const fullPath = join(tmp, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

describe('knowledge scan incompleteness', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-knowledge-incomplete-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reports an incomplete graph when the depth limit truncates the walk', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');
    await writeProjectFile('src/deep/nested/module.ts', 'export const deep = 1;\n');

    const graph = await scanProject(tmp, 'test-project', { maxDepth: 1 });

    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons.some(reason => reason.includes('depth limit 1'))).toBe(true);
    // The truncated directory really was skipped, so the signal is not cosmetic.
    expect(graph.hasNode('src/deep/nested/module.ts')).toBe(false);
  });

  it('reports an incomplete graph when the timeout truncates the walk', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');

    const graph = await scanProject(tmp, 'test-project', { timeoutMs: -1 });

    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons.some(reason => reason.includes('timeout'))).toBe(true);
  });

  it('reports an incomplete graph when a source file is skipped by the size limit', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');
    await writeProjectFile('src/huge.ts', `// ${'x'.repeat(600 * 1024)}\nexport const huge = 1;\n`);

    const graph = await scanProject(tmp, 'test-project');

    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons.some(reason => reason.includes('src/huge.ts'))).toBe(true);
    expect(graph.hasNode('src/huge.ts')).toBe(false);
  });

  it('round-trips the incompleteness signal through serialization and the exported snapshot', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');
    await writeProjectFile('src/deep/nested/module.ts', 'export const deep = 1;\n');

    const graph = await scanProject(tmp, 'test-project', { maxDepth: 1 });

    // The exact JSON path store.ts uses to persist and reload a graph.
    const persisted = JSON.parse(JSON.stringify(graph.serialize()));
    const parsed = SerializedGraphSchema.safeParse(persisted);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.incomplete).toBe(true);
    expect(parsed.data?.incompleteReasons.some(reason => reason.includes('depth limit 1'))).toBe(true);

    const restored = KnowledgeGraph.deserialize(parsed.data!);
    expect(restored.incomplete).toBe(true);
    expect(restored.incompleteReasons).toEqual(graph.incompleteReasons);

    expect(buildSnapshot(graph, tmp).incomplete).toBe(true);
    expect(buildSnapshot(graph, tmp).incompleteReasons.some(reason => reason.includes('depth limit 1'))).toBe(true);
  });

  it('still loads a legacy snapshot that predates the incompleteness field', async () => {
    const graph = new KnowledgeGraph('legacy-project', tmp);
    graph.scannedAt = Date.now();
    graph.addNode({ id: 'src/app.ts', type: 'module', name: 'app.ts', path: 'src/app.ts' });

    // Exactly the shape persisted before AGT-3490: no incomplete* keys at all.
    const legacy = JSON.parse(JSON.stringify(graph.serialize()));
    delete legacy.incomplete;
    delete legacy.incompleteReasons;

    const parsed = SerializedGraphSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);

    const restored = KnowledgeGraph.deserialize(parsed.data!);
    expect(restored.incomplete).toBe(false);
    expect(restored.incompleteReasons).toEqual([]);
    expect(restored.hasNode('src/app.ts')).toBe(true);
  });

  it('reports a complete graph when no limit was hit', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');

    const graph = await scanProject(tmp, 'test-project');
    const snapshot = buildSnapshot(graph, tmp);

    expect(graph.incomplete).toBe(false);
    expect(graph.incompleteReasons).toEqual([]);
    expect(graph.serialize().incomplete).toBe(false);
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.incompleteReasons).toEqual([]);
  });

  // AGT-4871 — total-size budgets so a huge repository cannot grow the graph
  // without bound until the timeout fires.
  it('stops at the file budget and records it as an incomplete reason', async () => {
    for (let i = 0; i < 12; i++) {
      await writeProjectFile(`src/m${i}.ts`, `export const m${i} = ${i};\n`);
    }

    const graph = await scanProject(tmp, 'test-project', { maxFiles: 5 });
    const sourceNodes = [...graph.getNodesByType('module'), ...graph.getNodesByType('test_file')];

    expect(sourceNodes.length).toBe(5);
    // Name-ordered walk: the same five files survive every scan.
    expect(sourceNodes.map(n => n.id).sort()).toEqual(['src/m0.ts', 'src/m1.ts', 'src/m10.ts', 'src/m11.ts', 'src/m2.ts']);
    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons.some(reason => reason.includes('file budget 5'))).toBe(true);
  });

  it('keeps the node count at or below the node budget', async () => {
    for (let d = 0; d < 6; d++) {
      for (let i = 0; i < 4; i++) {
        await writeProjectFile(`pkg${d}/m${i}.ts`, `export const m${i} = ${i};\n`);
      }
    }

    const graph = await scanProject(tmp, 'test-project', { maxNodes: 10 });

    expect(graph.nodeCount).toBeLessThanOrEqual(10);
    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons.some(reason => reason.includes('node budget 10'))).toBe(true);
  });

  it('keeps the budget reason when more than 50 other reasons were recorded', async () => {
    for (let i = 0; i < 60; i++) {
      await writeProjectFile(`a/huge${String(i).padStart(2, '0')}.ts`, `// ${'x'.repeat(520 * 1024)}\n`);
    }
    for (let i = 0; i < 5; i++) {
      await writeProjectFile(`z/m${i}.ts`, `export const m${i} = ${i};\n`);
    }

    // Size-limited files reserve a node but are not added, so use the file budget.
    const graph = await scanProject(tmp, 'test-project', { maxFiles: 2 });

    // Directories are walked in name order, so all 60 size reasons come first.
    expect(graph.incompleteReasons.length).toBe(50);
    expect(graph.incompleteReasons.some(reason => reason.includes('file budget 2'))).toBe(true);
  });

  it('does not report a budget when the project fits inside it', async () => {
    for (let i = 0; i < 3; i++) {
      await writeProjectFile(`src/m${i}.ts`, `export const m${i} = ${i};\n`);
    }

    const graph = await scanProject(tmp, 'test-project', { maxFiles: 3, maxNodes: 5 });

    // root + src + 3 modules = 5 nodes, exactly at both budgets.
    expect(graph.nodeCount).toBe(5);
    expect(graph.incomplete).toBe(false);
  });

  it('does not grow a budget-capped graph through incremental updates, but refreshes existing files', async () => {
    for (let i = 0; i < 12; i++) {
      await writeProjectFile(`src/m${i}.ts`, `export const m${i} = ${i};\n`);
    }
    const graph = await scanProject(tmp, 'test-project', { maxNodes: 6 });
    expect(graph.incomplete).toBe(true);
    const reasons = [...graph.incompleteReasons];
    const before = graph.nodeCount;
    expect(before).toBeLessThanOrEqual(6);
    const existing = graph.getNodesByType('module')[0].id;

    await writeProjectFile('src/zz_new.ts', 'export const fresh = 1;\n');
    await writeProjectFile(existing, 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    await incrementalUpdate(graph, tmp, ['src/zz_new.ts', existing], { maxNodes: 6 });

    expect(graph.hasNode('src/zz_new.ts')).toBe(false);
    expect(graph.nodeCount).toBe(before);
    expect(graph.getNode(existing)?.metrics?.exportCount).toBe(3);
    expect(graph.incomplete).toBe(true);
    expect(graph.incompleteReasons).toEqual(reasons);
  });

  it('still adds new files through incremental updates when the graph is complete', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');
    const graph = await scanProject(tmp, 'test-project', { maxNodes: 3 });
    expect(graph.incomplete).toBe(false);

    await writeProjectFile('src/extra.ts', 'export const extra = 1;\n');
    await incrementalUpdate(graph, tmp, ['src/extra.ts'], { maxNodes: 3 });

    expect(graph.hasNode('src/extra.ts')).toBe(true);
  });
});
