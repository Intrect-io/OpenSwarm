import { describe, expect, it } from 'vitest';
import { DispatchRamp } from './dispatchRamp.js';

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
});