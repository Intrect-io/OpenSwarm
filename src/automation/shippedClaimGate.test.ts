import { describe, expect, it } from 'vitest';
import { hasExplicitRemainingDelta, shouldRefuseShippedClaim } from './shippedClaimGate.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const base = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 'id-1',
  source: 'linear',
  title: 't',
  priority: 2,
  createdAt: 1,
  ...over,
});

describe('shippedClaimGate (AGT-4177)', () => {
  it('detects an explicit remaining-work delta', () => {
    expect(hasExplicitRemainingDelta(base({ description: 'Remaining work: fix the fence' }))).toBe(true);
    expect(hasExplicitRemainingDelta(base({ description: 'openswarm-remaining: one more test' }))).toBe(true);
    expect(hasExplicitRemainingDelta(base({ description: 'all done' }))).toBe(false);
  });

  it('refuses a DONE run that already published a PR', () => {
    expect(shouldRefuseShippedClaim(
      base({ linearState: 'Todo' }),
      { hasPrUrl: true, shippedTerminal: true },
    )).toBe(true);
  });

  it('allows reopen when the operator left a remaining-work delta', () => {
    expect(shouldRefuseShippedClaim(
      base({ linearState: 'Todo', description: 'Remaining work: wire the hook' }),
      { hasPrUrl: true, shippedTerminal: true },
    )).toBe(false);
  });

  it('allows explicitDispatch even without a delta', () => {
    expect(shouldRefuseShippedClaim(
      base({ linearState: 'Todo', explicitDispatch: true }),
      { hasPrUrl: true, shippedTerminal: true },
    )).toBe(false);
  });

  it('does not refuse a live (non-terminal) run', () => {
    expect(shouldRefuseShippedClaim(
      base({ linearState: 'In Progress' }),
      { hasPrUrl: true, shippedTerminal: false },
    )).toBe(false);
  });
});
