import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import { buildSnapshot } from './graphqlExporter.js';
import { incrementalUpdate, scanProject } from './scanner.js';
import type { GraphNode } from './types.js';

let tmp: string;

async function writeProjectFile(path: string, content: string): Promise<void> {
  const fullPath = join(tmp, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

function moduleNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'module',
    name: id.split('/').pop()!,
    path: id,
    metrics: { loc: 1, exportCount: 1, importCount: 0, language: 'typescript' },
    ...overrides,
  };
}

function testNode(id: string): GraphNode {
  return {
    id,
    type: 'test_file',
    name: id.split('/').pop()!,
    path: id,
    metrics: { loc: 1, exportCount: 0, importCount: 0, language: 'typescript' },
  };
}

describe('knowledge scanner', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-knowledge-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('clears stale test edges during incremental remapping', async () => {
    await writeProjectFile('src/foo.ts', 'export const foo = 1;\n');
    await writeProjectFile('src/bar.ts', 'export const bar = 1;\n');
    await writeProjectFile('tests/subject.test.ts', "import { foo } from '../src/foo';\n");

    const graph = await scanProject(tmp, 'test-project');

    expect(graph.getTests('src/foo.ts').map(n => n.id)).toContain('tests/subject.test.ts');

    await writeProjectFile('tests/subject.test.ts', "import { bar } from '../src/bar';\n");
    await incrementalUpdate(graph, tmp, ['tests/subject.test.ts']);

    expect(graph.getTests('src/foo.ts').map(n => n.id)).not.toContain('tests/subject.test.ts');
    expect(graph.getTests('src/bar.ts').map(n => n.id)).toContain('tests/subject.test.ts');
  });

  it('rejects incremental paths that escape through traversal or symlinks', async () => {
    const graph = await scanProject(tmp, 'test-project');
    await expect(incrementalUpdate(graph, tmp, ['../outside.ts'])).rejects.toThrow(/escapes repository root/);
    const outsideDir = await mkdtemp(join(tmpdir(), 'openswarm-scanner-outside-'));
    const outside = join(outsideDir, 'outside.ts');
    await writeFile(outside, 'export const secret = 1;\n');
    await symlink(outside, join(tmp, 'linked.ts'));
    try {
      await expect(incrementalUpdate(graph, tmp, ['linked.ts'])).rejects.toThrow(/symlink/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('maps Python relative imports to modules in the same package', async () => {
    await writeProjectFile('src/pkg/foo.py', 'def foo():\n    return 1\n');
    await writeProjectFile('src/pkg/test_foo.py', 'from .foo import foo\n');

    const graph = await scanProject(tmp, 'test-project');

    expect(graph.getTests('src/pkg/foo.py').map(n => n.id)).toContain('src/pkg/test_foo.py');
  });

  it('maps test naming conventions to source fallbacks', async () => {
    await writeProjectFile('src/foo.ts', 'export const foo = 1;\n');
    await writeProjectFile('src/bar.py', 'def bar():\n    return 1\n');
    await writeProjectFile('src/baz.py', 'def baz():\n    return 1\n');
    await writeProjectFile('tests/foo.test.ts', 'expect(1).toBe(1);\n');
    await writeProjectFile('tests/test_bar.py', 'def test_bar():\n    assert True\n');
    await writeProjectFile('tests/baz_test.py', 'def test_baz():\n    assert True\n');

    const graph = await scanProject(tmp, 'test-project');

    expect(graph.getTests('src/foo.ts').map(n => n.id)).toContain('tests/foo.test.ts');
    expect(graph.getTests('src/bar.py').map(n => n.id)).toContain('tests/test_bar.py');
    expect(graph.getTests('src/baz.py').map(n => n.id)).toContain('tests/baz_test.py');
  });

  it('builds self-contained source snapshots with GraphQL enum state values', () => {
    const graph = new KnowledgeGraph('test-project', tmp);
    graph.scannedAt = Date.now();
    graph.addNode(moduleNode('src/included.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 1, churnScore: 0.2 },
      metadata: { state: 'stable' },
    }));
    graph.addNode(moduleNode('generated/outside.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 10, churnScore: 0.9 },
      metadata: { state: 'experimental' },
    }));
    graph.addNode(testNode('tests/included.test.ts'));
    graph.addEdge({ source: 'src/included.ts', target: 'generated/outside.ts', type: 'imports' });
    graph.addEdge({ source: 'generated/outside.ts', target: 'src/included.ts', type: 'imports' });
    graph.addEdge({ source: 'tests/included.test.ts', target: 'src/included.ts', type: 'tests' });
    graph.addEdge({ source: 'tests/included.test.ts', target: 'generated/outside.ts', type: 'tests' });

    const snapshot = buildSnapshot(graph, tmp);
    const moduleIds = new Set(snapshot.modules.map(m => m.id));
    const included = snapshot.modules.find(m => m.id === 'src/included.ts');

    expect(moduleIds.has('generated/outside.ts')).toBe(false);
    expect(snapshot.project.totalModules).toBe(1);
    expect(snapshot.project.totalTests).toBe(1);
    expect(snapshot.project.summary.hotModules).toEqual(['src/included.ts']);
    expect(snapshot.project.summary.untestedModules).toEqual([]);
    expect(included?.state).toBe('STABLE');

    for (const mod of snapshot.modules) {
      for (const ref of [...mod.dependsOn, ...mod.dependedBy, ...mod.tests]) {
        expect(moduleIds.has(ref)).toBe(true);
      }
    }
  });

  it('skips vendored third-party trees (INT-2320)', async () => {
    await writeProjectFile('src/app.ts', 'export const app = 1;\n');
    await writeProjectFile('google-cloud-sdk/lib/surface/run.py', 'x = 1\n');
    await writeProjectFile('third_party/requests/api.py', 'x = 1\n');
    await writeProjectFile('vendor/dns/a.py', 'x = 1\n');

    const graph = await scanProject(tmp, 'test-project');
    const ids = graph.getNodesByType('module').map(n => n.id);
    expect(ids).toContain('src/app.ts');
    expect(ids.filter(id => id.includes('google-cloud-sdk') || id.includes('third_party') || id.includes('vendor/'))).toEqual([]);
  });
});
