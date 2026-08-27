import { describe, expect, it } from 'vitest';
import { isRouteReasonAllowed, planAdapterAttempts } from './routingPolicy.js';

const policy = {
  primary: 'codex' as const,
  fallbacks: ['cc-router' as const, 'cursor' as const],
  allowReasons: ['quota' as const, 'infra' as const, 'capability' as const],
};
const allAvailable = { codex: true, 'cc-router': true, cursor: true };

describe('adapter routing policy', () => {
  it('permits only the configured typed reasons', () => {
    expect(isRouteReasonAllowed(policy, 'quota')).toBe(true);
    expect(isRouteReasonAllowed(policy, 'explicit')).toBe(false);
    expect(isRouteReasonAllowed(undefined, 'quota')).toBe(false);
  });

  it('tries the primary first, then the fallbacks that are actually available', () => {
    expect(planAdapterAttempts({ policy, primary: 'codex', available: allAvailable }).attempts)
      .toEqual(['codex', 'cc-router', 'cursor']);
    expect(planAdapterAttempts({ policy, primary: 'codex', available: { codex: true, cursor: true } }).attempts)
      .toEqual(['codex', 'cursor']);
  });

  it('ignores a policy written for a different primary than the run uses', () => {
    // Otherwise an operator who sets `adapter: cursor` silently gets codex's
    // routing policy applied to a provider it was never written for.
    expect(planAdapterAttempts({ policy, primary: 'cursor', available: allAvailable }).attempts).toEqual(['cursor']);
  });

  it('skips a primary known to be missing when capability routing is allowed', () => {
    const plan = planAdapterAttempts({ policy, primary: 'codex', available: { ...allAvailable, codex: false } });
    expect(plan.attempts).toEqual(['cc-router', 'cursor']);
    expect(plan.skipped).toEqual({ adapter: 'codex', reason: 'capability' });
  });

  it('still tries a missing primary when capability routing is not allowed', () => {
    const strict = { ...policy, allowReasons: ['quota' as const] };
    const plan = planAdapterAttempts({ policy: strict, primary: 'codex', available: { ...allAvailable, codex: false } });
    expect(plan.attempts[0]).toBe('codex');
    expect(plan.skipped).toBeUndefined();
  });

  it('never drops an unprobed primary on a guess', () => {
    const plan = planAdapterAttempts({ policy, primary: 'codex', available: { 'cc-router': true } });
    expect(plan.attempts).toEqual(['codex', 'cc-router']);
    expect(plan.skipped).toBeUndefined();
  });
});
