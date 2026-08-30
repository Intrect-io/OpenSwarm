import { describe, it, expect } from 'vitest';
import { plannedNewChildren, refuseForChildCap } from './decompositionLimits.js';

const scope = (over: Partial<Parameters<typeof plannedNewChildren>[0]>) => ({
  existingChildren: 0,
  recovering: false,
  plannedChildren: 1,
  ...over,
});

describe('plannedNewChildren', () => {
  it('charges a fresh plan for everything it proposes', () => {
    expect(plannedNewChildren(scope({ plannedChildren: 4 }))).toBe(4);
  });

  it('charges a recovering plan only for the surplus it adds', () => {
    // Re-proposed children are deduped by idempotencyId downstream, so summing
    // them would spend budget on issues that already exist.
    expect(plannedNewChildren(scope({ existingChildren: 3, plannedChildren: 4, recovering: true }))).toBe(1);
  });

  it('never goes negative when a recovery re-proposes fewer than exist', () => {
    expect(plannedNewChildren(scope({ existingChildren: 5, plannedChildren: 2, recovering: true }))).toBe(0);
  });
});

describe('refuseForChildCap', () => {
  it('admits a plan that lands exactly on the cap', () => {
    expect(refuseForChildCap(scope({ plannedChildren: 3 }), 3)).toBeNull();
  });

  it('refuses a plan that would leave more children than the cap', () => {
    expect(refuseForChildCap(scope({ plannedChildren: 4 }), 3)).toMatch(/4 sub-issues.*over the 3 cap/);
  });

  it('counts children the parent already has toward the cap', () => {
    // The pre-check upstream only asks "is the parent already at the cap?", so
    // 2 existing + 2 planned slipped through and left 4. (AGT-4122)
    expect(refuseForChildCap(scope({ existingChildren: 2, plannedChildren: 2 }), 3)).toMatch(/4 sub-issues/);
  });

  it('admits a recovery that re-proposes exactly what exists', () => {
    expect(refuseForChildCap(scope({ existingChildren: 3, plannedChildren: 3, recovering: true }), 3)).toBeNull();
  });

  it('refuses a recovery whose parent already sits over the cap', () => {
    // Re-proposing fewer children than exist does not delete the surplus, so
    // admitting this would leave 5 against a cap of 3.
    expect(refuseForChildCap(scope({ existingChildren: 5, plannedChildren: 2, recovering: true }), 3))
      .toMatch(/5 sub-issues.*over the 3 cap/);
  });

  it('still refuses a recovering plan that grows past the cap', () => {
    expect(refuseForChildCap(scope({ existingChildren: 3, plannedChildren: 4, recovering: true }), 3))
      .toMatch(/4 sub-issues.*over the 3 cap/);
  });
});
