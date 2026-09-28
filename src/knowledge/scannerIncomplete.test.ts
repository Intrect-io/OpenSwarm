// AGT-3490 — a truncated knowledge-graph scan must be distinguishable from a
// complete one, in the graph, its persisted form, and its exported snapshot.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import { buildSnapshot } from './graphqlExporter.js';
import { scanProject } from './scanner.js';
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
});
