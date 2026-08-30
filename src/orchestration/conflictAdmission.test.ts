import { describe, expect, it } from 'vitest';
import {
  buildConflictFreeWaves,
  selectGreedyMaximalIndependentSet,
} from './conflictAdmission.js';

describe('deterministic conflict admission', () => {
  const conflicts = (left: string, right: string): boolean =>
    new Set(['A:B', 'B:A', 'B:C', 'C:B']).has(`${left}:${right}`);

  it('puts directly disjoint endpoints of a conflict chain in the first wave', () => {
    expect(buildConflictFreeWaves(['A', 'B', 'C'], conflicts)).toEqual([
      ['A', 'C'],
      ['B'],
    ]);
  });

  it('returns the first wave as the greedy maximal independent set', () => {
    expect(selectGreedyMaximalIndependentSet(['A', 'B', 'C'], conflicts)).toEqual(['A', 'C']);
    expect(selectGreedyMaximalIndependentSet([], conflicts)).toEqual([]);
  });
});
