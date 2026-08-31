import { describe, expect, it, vi } from 'vitest';

import { parkRunForHuman } from './autonomousRunner.js';

// The decision is tested directly rather than through AutonomousRunner: that
// harness carries global singletons, timers and real state files, which made
// equivalent tests flaky (INT-2521).
describe('parkRunForHuman — the publish gate for a terminal park', () => {
  it('grants publication when the durable park succeeded', () => {
    const durableRuns = { isPrimary: true, markNeedsHuman: vi.fn(() => true) };

    expect(parkRunForHuman(durableRuns, 'issue-1', 'retries exhausted')).toBe(true);
    expect(durableRuns.markNeedsHuman).toHaveBeenCalledWith('issue-1', 'retries exhausted');
  });

  it('withholds publication when the park was refused', () => {
    // markNeedsHuman refuses a row that still carries an owner or lease, so a
    // refusal means this executor no longer speaks for the run and must not
    // push work under its branch.
    const durableRuns = { isPrimary: true, markNeedsHuman: vi.fn(() => false) };

    expect(parkRunForHuman(durableRuns, 'issue-1', 'retries exhausted')).toBe(false);
  });

  it('does not attempt a durable park without ledger authority', () => {
    // mode off/shadow has no durable claim to prove, so behaviour stays what it
    // was before publication existed rather than silently disabling it.
    const durableRuns = { isPrimary: false, markNeedsHuman: vi.fn(() => false) };

    expect(parkRunForHuman(durableRuns, 'issue-1', 'retries exhausted')).toBe(true);
    expect(durableRuns.markNeedsHuman).not.toHaveBeenCalled();
  });
});
