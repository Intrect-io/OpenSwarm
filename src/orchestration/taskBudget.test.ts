import { describe, expect, it } from 'vitest';
import {
  ITERATION_BUDGET_PARK_REASON,
  TASK_BUDGET_CEILING_MS,
  canStartAnotherIteration,
  resolveHardTaskTimeoutMs,
} from './taskBudget.js';

const MIN = 60_000;
// The deployed cgf-portal shape on 2026-09-18: maxAttempts 5, worker ceiling
// 20 min (timeoutMs 0), reviewer off, tester 6 min.
const DEPLOYED = { maxIterations: 5, workerTimeoutMs: 20 * MIN, otherStagesTimeoutMs: 6 * MIN };

describe('resolveHardTaskTimeoutMs (AGT-4430)', () => {
  it('honours an explicit operations or test override', () => {
    expect(resolveHardTaskTimeoutMs({ ...DEPLOYED, configuredMs: 90_000 })).toBe(90_000);
  });

  it('derives the budget from the iteration count and the stage ceilings', () => {
    // 1 x (20 + 6) + 4 setup + 8 wrap-up
    expect(resolveHardTaskTimeoutMs({ ...DEPLOYED, maxIterations: 1 })).toBe(38 * MIN);
  });

  it('gives the deployed 5-iteration budget more than the 60min watchdog that killed AX-1556', () => {
    const budget = resolveHardTaskTimeoutMs(DEPLOYED);
    expect(budget).toBeGreaterThan(60 * MIN);
    // AX-1556 spent 59 min on four iterations; the same run now fits five.
    expect(budget).toBe(TASK_BUDGET_CEILING_MS);
  });

  it('clamps, so one task can never hold its slot indefinitely', () => {
    expect(resolveHardTaskTimeoutMs({ maxIterations: 10, workerTimeoutMs: 60 * MIN, otherStagesTimeoutMs: 30 * MIN }))
      .toBe(TASK_BUDGET_CEILING_MS);
  });

  it('treats a missing or negative stage ceiling as zero rather than shrinking the budget', () => {
    expect(resolveHardTaskTimeoutMs({ maxIterations: 2, workerTimeoutMs: 10 * MIN }))
      .toBe(2 * 10 * MIN + 12 * MIN);
    expect(resolveHardTaskTimeoutMs({ maxIterations: 2, workerTimeoutMs: 10 * MIN, otherStagesTimeoutMs: -5 * MIN }))
      .toBe(2 * 10 * MIN + 12 * MIN);
  });
});

describe('canStartAnotherIteration (AGT-4430)', () => {
  const base = { budgetMs: 90 * MIN, maxIterations: 5, workerTimeoutMs: 20 * MIN };

  it('always starts the first iteration — a task gets one attempt', () => {
    expect(canStartAnotherIteration({ ...base, elapsedMs: 89 * MIN, iterationsUsed: 0, longestIterationMs: 0 }))
      .toEqual({ start: true });
  });

  it('replays AX-1556: after 43 min and three iterations, a fourth still fits', () => {
    const verdict = canStartAnotherIteration({
      ...base, elapsedMs: 43 * MIN, iterationsUsed: 3, longestIterationMs: 18 * MIN,
    });
    expect(verdict.start).toBe(true);
  });

  it('stops when the longest observed iteration no longer fits, and says so in numbers', () => {
    const verdict = canStartAnotherIteration({
      ...base, elapsedMs: 80 * MIN, iterationsUsed: 4, longestIterationMs: 18 * MIN,
    });
    expect(verdict.start).toBe(false);
    expect(verdict.reason).toContain('80min of 90min');
    expect(verdict.reason).toContain('4/5 iterations');
    expect(verdict.reason).toContain('18min');
  });

  it('keeps the wrap-up reserve — an iteration that would end at the deadline is not started', () => {
    // 90 - 74 = 16 min left, the iteration needs 10, but 8 of those minutes
    // belong to guards, tester and publication.
    expect(canStartAnotherIteration({
      ...base, elapsedMs: 74 * MIN, iterationsUsed: 2, longestIterationMs: 10 * MIN,
    }).start).toBe(false);
    expect(canStartAnotherIteration({
      ...base, elapsedMs: 70 * MIN, iterationsUsed: 2, longestIterationMs: 10 * MIN,
    }).start).toBe(true);
  });

  it('uses the worker ceiling while no iteration has completed yet', () => {
    // Nothing observed: the next one may cost the full 20 min ceiling.
    expect(canStartAnotherIteration({
      ...base, elapsedMs: 70 * MIN, iterationsUsed: 1, longestIterationMs: 0,
    }).start).toBe(false);
  });

  it('stops on the iteration count independently of the clock', () => {
    const verdict = canStartAnotherIteration({
      ...base, elapsedMs: 1 * MIN, iterationsUsed: 5, longestIterationMs: 1 * MIN,
    });
    expect(verdict.start).toBe(false);
    expect(verdict.reason).toContain('5/5');
  });

  it('does not gate on wall clock when no budget was given', () => {
    expect(canStartAnotherIteration({
      ...base, budgetMs: 0, elapsedMs: 10 * 60 * MIN, iterationsUsed: 2, longestIterationMs: 60 * MIN,
    })).toEqual({ start: true });
  });

  it('names the park code once, so the publication path can match on it', () => {
    expect(ITERATION_BUDGET_PARK_REASON).toBe('iteration_budget_spent');
  });
});
