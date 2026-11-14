import { describe, expect, it } from 'vitest';
import { DispatchRamp, dispatchBudget } from './dispatchRamp.js';

describe('DispatchRamp', () => {
  it('caps first-heartbeat claims with eight free slots and a full queue', () => {
    const ramp = new DispatchRamp();
    expect(ramp.budget(8)).toBe(2);
  });

  it('lifts the cap after the configured warm-up heartbeats', () => {
    const ramp = new DispatchRamp();
    expect(ramp.budget(8)).toBe(2);
    expect(ramp.budget(8)).toBe(2);
    expect(ramp.budget(8)).toBe(8);
  });

  it('uses the configured claim cap', () => {
    expect(new DispatchRamp(3).budget(8)).toBe(3);
  });

  it('never grants more than the free slots', () => {
    expect(new DispatchRamp(4).budget(1)).toBe(1);
  });
});

describe('dispatchBudget', () => {
  it('keeps one ramp per owner and starts fresh for a new owner (daemon restart)', () => {
    const first = {};
    expect(dispatchBudget(first, undefined, 8)).toBe(2);
    expect(dispatchBudget(first, undefined, 8)).toBe(2);
    expect(dispatchBudget(first, undefined, 8)).toBe(8);
    const restarted = {};
    expect(dispatchBudget(restarted, 3, 8)).toBe(3);
  });
});
