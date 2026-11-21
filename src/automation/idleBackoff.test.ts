import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { IdleBackoff } from './idleBackoff.js';

const IDLE = () => ({ queued: 0, running: 0 });

/** One cron tick: run the heartbeat when the gate allows it, selecting nothing. */
function emptyTick(idle: IdleBackoff): boolean {
  if (!idle.shouldRunTick()) return false;
  idle.beginHeartbeat();
  idle.beginSelection();
  idle.endHeartbeat(IDLE);
  return true;
}

describe('IdleBackoff (AGT-4607)', () => {
  it('backs off the heartbeat after K empty selections and logs it', () => {
    const lines: string[] = [];
    const idle = new IdleBackoff({ emptyThreshold: 3, maxMultiplier: 8, baseIntervalMs: 5 * 60_000, log: (l) => lines.push(l) });

    // 60 cron ticks with nothing selectable: the first K run back to back,
    // then the interval doubles up to the 8x cap.
    const ran: number[] = [];
    for (let tick = 0; tick < 60; tick++) if (emptyTick(idle)) ran.push(tick);
    expect(ran.slice(0, 3)).toEqual([0, 1, 2]);
    expect(ran[3] - ran[2]).toBe(2);
    expect(ran[4] - ran[3]).toBe(4);
    expect(ran[5] - ran[4]).toBe(8);
    expect(ran[6] - ran[5]).toBe(8); // capped
    // The heartbeat (and its Linear fetch) ran far fewer times than the ticks.
    expect(ran.length).toBeLessThan(15);
    expect(idle.getMultiplier()).toBe(8);

    // Logged once per streak, not once per heartbeat.
    const streakLines = lines.filter((l) => l.includes('consecutive empty selections'));
    expect(streakLines).toHaveLength(1);
    expect(streakLines[0]).toContain('3 consecutive empty selections');
    expect(streakLines[0]).toContain('2x');
  });

  it('caps the stretch at maxIntervalMs of wall time', () => {
    const idle = new IdleBackoff({ emptyThreshold: 1, maxMultiplier: 8, baseIntervalMs: 20 * 60_000, maxIntervalMs: 60 * 60_000, log: () => {} });
    for (let tick = 0; tick < 40; tick++) emptyTick(idle);
    expect(idle.getMultiplier()).toBe(3); // 1x -> 2x -> min(floor(60/20), 4) = 3x, i.e. one hour
  });

  it('resets the interval when a task is selected', () => {
    const lines: string[] = [];
    const idle = new IdleBackoff({ emptyThreshold: 3, log: (l) => lines.push(l) });
    const scheduler = new EventEmitter();
    idle.attach(scheduler);
    for (let tick = 0; tick < 20; tick++) emptyTick(idle);
    expect(idle.getMultiplier()).toBeGreaterThan(1);

    // A heartbeat that enqueues a task resets the streak and the interval.
    idle.beginHeartbeat();
    idle.beginSelection();
    scheduler.emit('enqueued', {});
    idle.endHeartbeat(() => ({ queued: 1, running: 0 }));
    expect(idle.getMultiplier()).toBe(1);
    expect(idle.getConsecutiveEmpty()).toBe(0);
    expect(idle.shouldRunTick()).toBe(true);
    expect(lines.some((l) => l.includes('back to the base interval'))).toBe(true);
    expect(idle.snapshot(true).lastProgressAt).not.toBeNull();

    // An explicit runNow resets too, and a new streak is logged again.
    for (let tick = 0; tick < 20; tick++) emptyTick(idle);
    expect(idle.getMultiplier()).toBeGreaterThan(1);
    idle.reset('runNow');
    expect(idle.getMultiplier()).toBe(1);
    expect(lines.filter((l) => l.includes('consecutive empty selections'))).toHaveLength(2);
  });

  it('does not count holds, busy schedulers or unreadable load as empty selections', () => {
    const idle = new IdleBackoff({ emptyThreshold: 1, log: () => {} });
    for (let i = 0; i < 5; i++) {
      // Returned before the fetch (time window, pause, fetch error).
      idle.beginHeartbeat();
      idle.endHeartbeat(IDLE);
      // Reached selection but tasks are still running.
      idle.beginHeartbeat();
      idle.beginSelection();
      idle.endHeartbeat(() => ({ queued: 0, running: 2 }));
      // Scheduler load unreadable: fail toward the base interval.
      idle.beginHeartbeat();
      idle.beginSelection();
      idle.endHeartbeat(() => { throw new Error('boom'); });
    }
    expect(idle.getConsecutiveEmpty()).toBe(0);
    expect(idle.getMultiplier()).toBe(1);
  });
});
