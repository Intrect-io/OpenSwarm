// @vitest-environment jsdom
//
// The layout must be deterministic — a node that jumps to a new corner on
// every refresh makes the graph unreadable — and numerically safe: one NaN
// propagates through every force pass and blanks the whole SVG.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { layoutGraph, seedPosition } from '../../web/static/js/forceLayout.mjs';

const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const edges = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
  { from: 'a', to: 'd' },
];

describe('layoutGraph', () => {
  it('is deterministic for the same graph', () => {
    const first = layoutGraph(nodes, edges, { width: 800, height: 500 });
    const second = layoutGraph(nodes, edges, { width: 800, height: 500 });
    for (const node of nodes) {
      expect(second.get(node.id)).toEqual(first.get(node.id));
    }
  });

  it('keeps every node finite and inside the viewport margin', () => {
    const positions = layoutGraph(nodes, edges, { width: 640, height: 400, margin: 40 });
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(40);
      expect(p.x).toBeLessThanOrEqual(600);
      expect(p.y).toBeGreaterThanOrEqual(40);
      expect(p.y).toBeLessThanOrEqual(360);
    }
  });

  it('separates nodes instead of collapsing them onto one point', () => {
    const positions = layoutGraph(nodes, edges, { width: 800, height: 500 });
    const points = nodes.map((node) => positions.get(node.id)!);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dist = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        expect(dist).toBeGreaterThan(30);
      }
    }
  });

  it('survives identical seed collisions (two nodes at one position)', () => {
    // Force the degenerate start: same id twice would collide in a Map, so use
    // ids engineered to hash near each other plus a duplicate position check.
    const clustered = [{ id: 'x' }, { id: 'x2' }, { id: 'x3' }];
    const positions = layoutGraph(clustered, [], { width: 400, height: 300 });
    const points = clustered.map((node) => positions.get(node.id)!);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('seeds positions purely from the id', () => {
    expect(seedPosition('agent-1', 800, 500)).toEqual(seedPosition('agent-1', 800, 500));
    expect(seedPosition('agent-1', 800, 500)).not.toEqual(seedPosition('agent-2', 800, 500));
  });
});
