import { describe, expect, it, vi } from 'vitest';
import { evaluateDecompositionTrigger } from './decompositionTrigger.js';

const base = { enableDecomposition: true, resumesPreservedWork: false, priorFailures: 0, decomposeAfterFailures: 3 };

describe('evaluateDecompositionTrigger (AGT-4287)', () => {
  it('forces a split on a resumed worktree once the failure budget is spent — the case the signal could never reach', () => {
    const heuristic = vi.fn(() => false);
    expect(evaluateDecompositionTrigger({ ...base, resumesPreservedWork: true, priorFailures: 3, heuristicNeedsDecomposition: heuristic }))
      .toEqual({ checked: true, forced: true });
    expect(heuristic).not.toHaveBeenCalled();
  });

  it('does not pay for the planner on an ordinary resume below the budget', () => {
    expect(evaluateDecompositionTrigger({ ...base, resumesPreservedWork: true, priorFailures: 2, heuristicNeedsDecomposition: () => true }))
      .toEqual({ checked: false, forced: false });
  });

  it('never decomposes when the operator switched it off, whatever the count', () => {
    expect(evaluateDecompositionTrigger({ ...base, enableDecomposition: false, priorFailures: 99, heuristicNeedsDecomposition: () => true }))
      .toEqual({ checked: false, forced: false });
  });

  it('treats a budget of 0 or -1 as "never force", not "force every first attempt"', () => {
    for (const decomposeAfterFailures of [0, -1]) {
      expect(evaluateDecompositionTrigger({ ...base, decomposeAfterFailures, priorFailures: 0, heuristicNeedsDecomposition: () => false }))
        .toEqual({ checked: false, forced: false });
      expect(evaluateDecompositionTrigger({ ...base, decomposeAfterFailures, priorFailures: 50, heuristicNeedsDecomposition: () => false }))
        .toEqual({ checked: false, forced: false });
    }
  });

  it('leaves a fresh first attempt to the duration heuristic', () => {
    expect(evaluateDecompositionTrigger({ ...base, heuristicNeedsDecomposition: () => true })).toEqual({ checked: true, forced: false });
    expect(evaluateDecompositionTrigger({ ...base, heuristicNeedsDecomposition: () => false })).toEqual({ checked: false, forced: false });
  });
});
