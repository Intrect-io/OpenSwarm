import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RAMP_INTERVAL_MS, DispatchRamp, dispatchBudget, recordDispatchClaims, scheduleIntervalMs } from './dispatchRamp.js';

const MIN = 60_000;

/** A ramp on a controllable clock. */
function clockedRamp(options: { claimsPerHeartbeat?: number; intervalMs?: number } = {}) {
  let t = 1_000_000;
  const ramp = new DispatchRamp({ ...options, now: () => t });
  return { ramp, advance: (ms: number) => { t += ms; } };
}

describe('DispatchRamp', () => {
  it('caps first-heartbeat claims with eight free slots and a full queue', () => {
    const ramp = new DispatchRamp();
    expect(ramp.budget(8)).toBe(2);
  });

  it('lifts the cap after the configured warm-up heartbeats', () => {
    const { ramp, advance } = clockedRamp({ intervalMs: 15 * MIN });
    expect(ramp.budget(8)).toBe(2);
    ramp.record(2);
    expect(ramp.budget(8)).toBe(2);
    ramp.record(2);
    advance(15 * MIN);
    expect(ramp.budget(8)).toBe(8);
  });

  it('uses the configured claim cap', () => {
    expect(new DispatchRamp({ claimsPerHeartbeat: 3 }).budget(8)).toBe(3);
  });

  it('never grants more than the free slots', () => {
    expect(new DispatchRamp({ claimsPerHeartbeat: 4 }).budget(1)).toBe(1);
  });

  it('keeps the cap through back-to-back heartbeats until one interval has passed', () => {
    const { ramp, advance } = clockedRamp({ intervalMs: 15 * MIN });
    // Startup triggerNow, then the setTimeout(0) re-fires: many claiming passes within seconds.
    for (let i = 0; i < 5; i++) {
      expect(ramp.budget(8)).toBe(2);
      ramp.record(2);
      advance(1_000);
    }
    advance(15 * MIN - 5_000 - 1);
    expect(ramp.budget(8)).toBe(2);
    advance(1);
    expect(ramp.budget(8)).toBe(8);
  });

  it('keeps the cap after the interval until two heartbeats have actually claimed', () => {
    const { ramp, advance } = clockedRamp({ intervalMs: 15 * MIN });
    advance(60 * MIN);
    expect(ramp.budget(8)).toBe(2);
    ramp.record(1);
    expect(ramp.budget(8)).toBe(2);
    ramp.record(1);
    expect(ramp.budget(8)).toBe(8);
  });

  it('does not count passes that enqueued nothing', () => {
    const { ramp, advance } = clockedRamp({ intervalMs: 15 * MIN });
    advance(60 * MIN);
    for (let i = 0; i < 4; i++) {
      expect(ramp.budget(8)).toBe(2);
      ramp.record(0);
    }
    ramp.record(2);
    expect(ramp.budget(8)).toBe(2);
    ramp.record(2);
    expect(ramp.budget(8)).toBe(8);
  });
});

describe('scheduleIntervalMs', () => {
  it('derives the heartbeat interval from the cron schedule', () => {
    expect(scheduleIntervalMs('*/30 * * * *')).toBe(30 * MIN);
    expect(scheduleIntervalMs('*/5 * * * *')).toBe(5 * MIN);
  });

  it('falls back to fifteen minutes when the schedule is unknown or invalid', () => {
    expect(DEFAULT_RAMP_INTERVAL_MS).toBe(15 * MIN);
    expect(scheduleIntervalMs(undefined)).toBe(DEFAULT_RAMP_INTERVAL_MS);
    expect(scheduleIntervalMs('not a cron')).toBe(DEFAULT_RAMP_INTERVAL_MS);
  });
});

describe('dispatchBudget', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps one ramp per owner and starts fresh for a new owner (daemon restart)', () => {
    let t = 0;
    const now = () => t;
    const first = {};
    expect(dispatchBudget(first, undefined, 8, '*/5 * * * *', now)).toBe(2);
    recordDispatchClaims(first, 2);
    expect(dispatchBudget(first, undefined, 8)).toBe(2);
    recordDispatchClaims(first, 2);
    t += 5 * MIN;
    expect(dispatchBudget(first, undefined, 8)).toBe(8);
    const restarted = {};
    expect(dispatchBudget(restarted, 3, 8, '*/5 * * * *', now)).toBe(3);
  });

  it('holds the cap under fake time until the schedule interval elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T00:00:00Z'));
    const owner = {};
    expect(dispatchBudget(owner, undefined, 8, '*/30 * * * *')).toBe(2);
    recordDispatchClaims(owner, 2);
    vi.advanceTimersByTime(1_000);
    expect(dispatchBudget(owner, undefined, 8)).toBe(2);
    recordDispatchClaims(owner, 2);
    vi.advanceTimersByTime(29 * MIN);
    expect(dispatchBudget(owner, undefined, 8)).toBe(2);
    vi.advanceTimersByTime(MIN);
    expect(dispatchBudget(owner, undefined, 8)).toBe(8);
  });
});
