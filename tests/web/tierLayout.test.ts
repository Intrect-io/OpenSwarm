// @vitest-environment jsdom
//
// The layout IS the org chart: a worker rendered above the operator, or a
// tier that reshuffles between refreshes, misstates the chain of command.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { layoutTiers, tierOf, TIERS } from '../../web/static/js/tierLayout.mjs';

function node(over: Record<string, unknown> = {}) {
  return { id: `n-${Math.random()}`, name: 'X', role: 'worker', ...over };
}

describe('tierOf', () => {
  it('maps every role to its command tier and strangers to execution', () => {
    expect(tierOf('human')).toBe(0);
    expect(tierOf('daemon')).toBe(1);
    expect(tierOf('orchestrator')).toBe(2);
    expect(tierOf('review-agent')).toBe(2);
    expect(tierOf('worker')).toBe(3);
    expect(tierOf('reviewer')).toBe(3);
    expect(tierOf('agent')).toBe(3);
    expect(tierOf('something-new')).toBe(3);
  });
});

describe('layoutTiers', () => {
  it('stacks the hierarchy top-down: operator above daemon above coordination above execution', () => {
    const human = node({ id: 'human', name: 'human', role: 'human' });
    const daemon = node({ id: 'daemon', name: 'daemon', role: 'daemon' });
    const orch = node({ id: 'orch', name: 'Castellan', role: 'orchestrator' });
    const worker = node({ id: 'w', name: 'Enginseer', role: 'worker' });
    const { positions, bands } = layoutTiers([worker, human, orch, daemon], { width: 900, height: 600 });

    expect(positions.get('human')!.y).toBeLessThan(positions.get('daemon')!.y);
    expect(positions.get('daemon')!.y).toBeLessThan(positions.get('orch')!.y);
    expect(positions.get('orch')!.y).toBeLessThan(positions.get('w')!.y);
    expect(bands.map((band: { label: string }) => band.label)).toEqual(
      TIERS.map((tier: { label: string }) => tier.label));
  });

  it('draws every tier band even when empty — an empty row is information', () => {
    const { bands } = layoutTiers([node({ id: 'w', role: 'worker' })], { width: 900, height: 600 });
    expect(bands).toHaveLength(4);
    expect(bands[2]).toMatchObject({ label: 'COORDINATION', count: 0 });
  });

  it('seats a task\'s worker and reviewer adjacent in the execution row', () => {
    const { positions } = layoutTiers([
      node({ id: 'w2', name: 'Zeta', role: 'worker', taskId: 'task-2' }),
      node({ id: 'r1', name: 'Adept', role: 'reviewer', taskId: 'task-1' }),
      node({ id: 'w1', name: 'Enginseer', role: 'worker', taskId: 'task-1' }),
      node({ id: 'r2', name: 'Vindicator', role: 'reviewer', taskId: 'task-2' }),
    ], { width: 1200, height: 600 });
    const xs = ['w1', 'r1', 'w2', 'r2'].map((id) => positions.get(id)!.x);
    // task-1 pair first (worker then reviewer), then task-2 pair.
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('is deterministic and keeps everyone inside the drawable area', () => {
    const crowd = Array.from({ length: 9 }, (_, index) =>
      node({ id: `w${index}`, name: `W${index}`, role: 'worker', taskId: `t${index}` }));
    const first = layoutTiers(crowd, { width: 700, height: 500 });
    const second = layoutTiers(crowd, { width: 700, height: 500 });
    for (const member of crowd) {
      expect(second.positions.get(member.id)).toEqual(first.positions.get(member.id));
      const p = first.positions.get(member.id)!;
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(700);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(500);
    }
  });

  it('wraps a crowded tier into sub-rows instead of squeezing below min spacing', () => {
    const crowd = Array.from({ length: 12 }, (_, index) =>
      node({ id: `w${index}`, name: `W${index}`, role: 'worker' }));
    const { positions } = layoutTiers(crowd, { width: 500, height: 600, minSpacing: 96 });
    const ys = new Set(crowd.map((member) => positions.get(member.id)!.y));
    expect(ys.size).toBeGreaterThan(1); // wrapped into multiple execution sub-rows

    const byRow = new Map<number, number[]>();
    for (const member of crowd) {
      const p = positions.get(member.id)!;
      byRow.set(p.y, [...(byRow.get(p.y) ?? []), p.x]);
    }
    for (const xs of byRow.values()) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(60);
      }
    }
  });
});
