import { describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';

describe('KnowledgeGraph traversal', () => {
  it('returns a diamond dependent only once', () => {
    const graph = new KnowledgeGraph('p', '/repo');
    for (const id of ['root', 'left', 'right', 'leaf']) {
      graph.addNode({ id, name: id, path: id, type: 'module' });
    }
    graph.addEdge({ source: 'left', target: 'root', type: 'imports' });
    graph.addEdge({ source: 'right', target: 'root', type: 'imports' });
    graph.addEdge({ source: 'leaf', target: 'left', type: 'imports' });
    graph.addEdge({ source: 'leaf', target: 'right', type: 'imports' });
    expect(graph.getTransitiveDependents('root').map((node) => node.id)).toEqual(['left', 'right', 'leaf']);
  });
});

describe('KnowledgeGraph edge identity (AGT-4659)', () => {
  function graphWith(ids: string[]): KnowledgeGraph {
    const graph = new KnowledgeGraph('p', '/repo');
    for (const id of ids) graph.addNode({ id, name: id, path: id, type: 'module' });
    return graph;
  }

  it('rejects an edge whose endpoints and type already exist', () => {
    const graph = graphWith(['a', 'b']);
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    expect(graph.edgeCount).toBe(1);
    // Same endpoints, different type is a different edge.
    graph.addEdge({ source: 'a', target: 'b', type: 'tests' });
    expect(graph.edgeCount).toBe(2);
  });

  it('accepts the same edge again after removeOutgoingEdges dropped it', () => {
    const graph = graphWith(['a', 'b']);
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    graph.removeOutgoingEdges('a', ['imports']);
    expect(graph.edgeCount).toBe(0);
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    expect(graph.edgeCount).toBe(1);
    expect(graph.getTransitiveDependents('b').map((n) => n.id)).toEqual(['a']);
  });

  it('accepts the same edge again after removeNode dropped it', () => {
    const graph = graphWith(['a', 'b']);
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    graph.removeNode('b');
    expect(graph.edgeCount).toBe(0);
    graph.addNode({ id: 'b', name: 'b', path: 'b', type: 'module' });
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    expect(graph.edgeCount).toBe(1);
  });

  it('accepts the same edge again after clear()', () => {
    const graph = graphWith(['a', 'b']);
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    graph.clear();
    graph.addNode({ id: 'a', name: 'a', path: 'a', type: 'module' });
    graph.addNode({ id: 'b', name: 'b', path: 'b', type: 'module' });
    graph.addEdge({ source: 'a', target: 'b', type: 'imports' });
    expect(graph.edgeCount).toBe(1);
  });

  it('deserializes a 50k-edge graph without scanning every edge per insert', () => {
    // The scan-per-insert version needs ~1.25e9 comparisons here and takes
    // minutes; the bound is loose on purpose so a loaded machine cannot flake it.
    const n = 50_000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `m${i}`, path: `m${i}`, type: 'module' as const }));
    const edges = Array.from({ length: n }, (_, i) => ({ source: `m${i}`, target: `m${(i + 1) % n}`, type: 'imports' as const }));
    const t0 = performance.now();
    const graph = KnowledgeGraph.deserialize({ version: 1, projectSlug: 'p', projectPath: '/repo', scannedAt: 'now', nodes, edges });
    expect(graph.edgeCount).toBe(n);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
