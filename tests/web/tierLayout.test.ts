// @vitest-environment jsdom
//
// The layout IS the org chart: a worker rendered above the operator, or a
// tier that reshuffles between refreshes, misstates the chain of command.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { layoutTiers, planBands, slotHash, tierOf, TIERS } from '../../web/static/js/tierLayout.mjs';

type Band = { id: string; label: string; kind: string; count: number; taskId: string | null };

let born = 0;
function node(over: Record<string, unknown> = {}) {
  born += 1;
  // `firstSeen` ascending in declaration order unless a test pins it: the
  // layout seats oldest first, so "who arrived when" is the interesting axis.
  return { id: `n-${born}`, name: 'X', role: 'worker', firstSeen: born, lastSeen: born, ...over };
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
    // The rails keep their fixed bands; below them the execution tier is no
    // longer one band but a lane per task.
    expect(bands.slice(0, 3).map((band: Band) => band.label)).toEqual(
      TIERS.slice(0, 3).map((tier: { label: string }) => tier.label));
    expect(bands.slice(0, 3).every((band: Band) => band.kind === 'rail')).toBe(true);
    expect(bands.slice(3).every((band: Band) => band.kind === 'lane')).toBe(true);
  });

  it('draws every rail band even when empty — an empty row is information', () => {
    const { bands } = layoutTiers([node({ id: 'w', role: 'worker' })], { width: 900, height: 600 });
    expect(bands.filter((band: Band) => band.kind === 'rail')).toHaveLength(3);
    expect(bands[2]).toMatchObject({ label: 'COORDINATION', count: 0 });
  });

  // The headline of AGT-4066: a live task is one lane holding its own
  // participants, so six conversations read as six lanes and not as forty
  // dots sharing one band.
  it('gives each task its own lane and seats its participants together', () => {
    const nodes = [
      node({ id: 'w2', name: 'Zeta', role: 'worker', taskId: 'task-2', taskLabel: 'AGT-2' }),
      node({ id: 'r1', name: 'Adept', role: 'reviewer', taskId: 'task-1' }),
      node({ id: 'w1', name: 'Enginseer', role: 'worker', taskId: 'task-1', taskLabel: 'AGT-1' }),
      node({ id: 'r2', name: 'Vindicator', role: 'reviewer', taskId: 'task-2' }),
    ];
    const { positions, bands } = layoutTiers(nodes, { width: 1200, height: 600 });

    // Same task ⇒ same band; different task ⇒ different band.
    expect(positions.get('w1')!.y).toBe(positions.get('r1')!.y);
    expect(positions.get('w2')!.y).toBe(positions.get('r2')!.y);
    expect(positions.get('w1')!.y).not.toBe(positions.get('w2')!.y);

    const lanes = bands.filter((band: Band) => band.kind === 'lane');
    expect(lanes.map((lane: Band) => lane.taskId)).toEqual(['task-2', 'task-1']);
    // The publisher's label names the lane; the raw uuid is the fallback.
    expect(lanes.map((lane: Band) => lane.label)).toEqual(['AGT-2', 'AGT-1']);
    expect(lanes.map((lane: Band) => lane.count)).toEqual([2, 2]);
  });

  it('lands untasked execution nodes in one shared lane, not a lane each', () => {
    const bands = planBands([
      node({ id: 'a', role: 'agent' }),
      node({ id: 'b', role: 'agent' }),
    ]) as Array<Band & { members: unknown[] }>;
    const lanes = bands.filter((band) => band.kind === 'lane');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ label: 'NO TASK' });
    expect(lanes[0].members).toHaveLength(2);
  });

  // Cause #2 in the issue: x was `(index + 0.5) / rowMembers.length`, so one
  // arrival re-indexed and slid every node in the band sideways.
  it('does not move anyone already on screen when a new agent joins', () => {
    const opts = { width: 1200, height: 600 };
    const settled = [
      node({ id: 'alpha', taskId: 'task-1', firstSeen: 10, lastSeen: 10 }),
      node({ id: 'bravo', taskId: 'task-1', firstSeen: 20, lastSeen: 20 }),
      node({ id: 'charlie', taskId: 'task-1', firstSeen: 30, lastSeen: 30 }),
    ];
    const before = layoutTiers(settled, opts);
    // A name that sorts first, so the old index-based placement would have
    // pushed every incumbent one slot to the right.
    const joiner = node({ id: 'aaaaa-newcomer', name: 'Aaaa', taskId: 'task-1', firstSeen: 40, lastSeen: 40 });
    const after = layoutTiers([joiner, ...settled], opts);

    for (const member of settled) {
      expect(after.positions.get(member.id)).toEqual(before.positions.get(member.id));
    }
    expect(after.positions.get('aaaaa-newcomer')).toBeDefined();
  });

  // The same guarantee under the worst case the hash can produce: the joiner
  // wants a slot an incumbent already holds. Seating oldest-first is what
  // makes the newcomer yield rather than evict.
  it('makes a colliding newcomer yield the slot, not the incumbent', () => {
    const opts = { width: 1200, height: 600, minSpacing: 96 };
    const perRow = Math.floor((1200 - 120 - 24) / 96);
    const incumbent = node({ id: 'incumbent', taskId: 't', firstSeen: 1, lastSeen: 1 });
    // Search for an id that hashes onto the incumbent's slot.
    // The id deliberately sorts BEFORE the incumbent's: under the old
    // name-ordered placement it would have been seated first and taken the
    // slot. Only seating by age keeps the incumbent put.
    const wanted = slotHash('incumbent', perRow);
    let collider = '';
    for (let n = 0; n < 5000 && !collider; n += 1) {
      if (slotHash(`aaa-${n}`, perRow) === wanted) collider = `aaa-${n}`;
    }
    expect(collider).not.toBe('');
    expect(collider < 'incumbent').toBe(true);

    const before = layoutTiers([incumbent], opts);
    const after = layoutTiers([
      node({ id: collider, taskId: 't', firstSeen: 99, lastSeen: 99 }), incumbent,
    ], opts);
    expect(after.positions.get('incumbent')).toEqual(before.positions.get('incumbent'));
    expect(after.positions.get(collider)!.x).not.toBe(before.positions.get('incumbent')!.x);
  });

  // A lane's age is the minimum over the members it can see, so filtering away
  // a lane's earliest member raises it and every lane below shifts. `laneOrder`
  // comes from the unfiltered board and pins the stack.
  it('keeps the lane stack put when a filter hides a lane\'s earliest member', () => {
    const all = [
      node({ id: 'veteran', taskId: 't-old', firstSeen: 1, lastSeen: 1 }),
      node({ id: 'latecomer', taskId: 't-old', firstSeen: 90, lastSeen: 90 }),
      node({ id: 'other', taskId: 't-new', firstSeen: 50, lastSeen: 50 }),
    ];
    const laneOrder = ['t-old', 't-new'];
    const opts = { width: 1200, height: 600, laneOrder };
    const labelsOf = (bands: Band[]) =>
      bands.filter((band) => band.kind === 'lane').map((band) => band.taskId);

    const full = layoutTiers(all, opts);
    // 'veteran' goes idle and drops out; without laneOrder t-old would now
    // look younger than t-new and swap below it.
    const filtered = layoutTiers(all.slice(1), opts);

    expect(labelsOf(full.bands)).toEqual(['t-old', 't-new']);
    expect(labelsOf(filtered.bands)).toEqual(['t-old', 't-new']);
    expect(labelsOf(layoutTiers(all.slice(1), { width: 1200, height: 600 }).bands))
      .toEqual(['t-new', 't-old']); // the unpinned ordering this guards against
  });

  it('folds the least recently active tasks into one lane past the cap', () => {
    const nodes = Array.from({ length: 8 }, (_, index) =>
      node({ id: `w${index}`, taskId: `t${index}`, firstSeen: index, lastSeen: index }));
    const bands = planBands(nodes, { maxLanes: 4 }) as Array<Band & { members: unknown[] }>;
    const lanes = bands.filter((band) => band.kind === 'lane');
    expect(lanes).toHaveLength(4);
    // The three most recent tasks keep their own lane; the rest share one.
    expect(lanes.slice(0, 3).map((lane) => lane.taskId)).toEqual(['t5', 't6', 't7']);
    expect(lanes[3].label).toBe('5 OLDER TASKS');
    expect(lanes[3].members).toHaveLength(5);
  });

  // Seating is by age. A node from before `firstSeen` existed compares as NaN
  // against a dated one, and a NaN comparison is not merely wrong — it is
  // non-transitive, which makes the whole sort arbitrary. Treating an undated
  // node as the oldest keeps the comparator total.
  it('seats a legacy node as the oldest rather than comparing NaN', () => {
    // `minSpacing` past the usable width forces one seat per row, so the row a
    // node lands in IS its seating order — otherwise the hash hides it.
    const opts = { width: 400, height: 600, minSpacing: 1000 };
    const { positions } = layoutTiers([
      { id: 'zzz-legacy', name: 'Z', role: 'worker', taskId: 't' },
      { id: 'aaa-dated', name: 'A', role: 'worker', taskId: 't', firstSeen: 5, lastSeen: 5 },
    ], opts);

    const legacy = positions.get('zzz-legacy')!;
    const dated = positions.get('aaa-dated')!;
    expect(Number.isFinite(legacy.x) && Number.isFinite(legacy.y)).toBe(true);
    // Undated ⇒ oldest ⇒ seated first, despite an id that sorts last.
    expect(legacy.y).toBeLessThan(dated.y);
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
