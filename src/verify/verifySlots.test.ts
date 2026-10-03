import { describe, expect, it, vi } from 'vitest';
import { VerifySlots, verifySlots } from './verifySlots.js';
import { runVerify } from './runner.js';

// Eight suites at once on a loaded machine each reached 3% in the 300 s pytest cap and
// fell back to the LLM tester (AGT-4676). The bound has to hold, queue in order, give
// the slot back on every exit, and never strand a slot on a waiter that gave up.

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('VerifySlots', () => {
  it('never runs more than its limit at once and finishes everything it was given', async () => {
    const slots = new VerifySlots(2, 60_000);
    const gates = Array.from({ length: 6 }, gate);
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    const runs = gates.map((g, index) => slots.run(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await g.promise;
      live -= 1;
      done.push(index);
    }));

    await tick();
    expect(slots.running).toBe(2);
    expect(slots.waiting).toBe(4);
    for (const g of gates) { g.open(); await tick(); }
    await Promise.all(runs);

    expect(peak).toBe(2);
    expect(done).toHaveLength(6);
    expect(slots.running).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  it('hands slots to waiters in the order they arrived', async () => {
    const slots = new VerifySlots(1, 60_000);
    const first = gate();
    const started: string[] = [];
    const runs = ['a', 'b', 'c'].map((name, index) => slots.run(async () => {
      started.push(name);
      if (index === 0) await first.promise;
    }));
    await tick();
    expect(started).toEqual(['a']);
    first.open();
    await Promise.all(runs);
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('gives the slot back when the work throws', async () => {
    const slots = new VerifySlots(1, 60_000);
    await expect(slots.run(async () => { throw new Error('sandbox failed'); })).rejects.toThrow('sandbox failed');
    expect(slots.running).toBe(0);
    await expect(slots.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a waiter that exceeds its wait, and the slot still comes back to the next one', async () => {
    vi.useFakeTimers();
    try {
      const slots = new VerifySlots(1, 5_000);
      const holder = gate();
      const holding = slots.run(() => holder.promise);

      const impatient = slots.run(async () => 'never runs');
      const outcome = expect(impatient).rejects.toThrow(/no verification slot within 5000ms \(1\/1 running/);
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      expect(slots.waiting).toBe(0);

      holder.open();
      await holding;
      expect(slots.running).toBe(0);
      // The waiter that gave up must not have been handed the freed slot.
      await expect(slots.run(async () => 'next')).resolves.toBe('next');
      expect(slots.running).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports who is ahead when a call has to wait', async () => {
    const slots = new VerifySlots(1, 60_000);
    const holder = gate();
    const holding = slots.run(() => holder.promise);
    const onWait = vi.fn();
    const waiting = slots.run(async () => undefined, onWait);
    await tick();
    expect(onWait).toHaveBeenCalledWith(0, 1);
    holder.open();
    await Promise.all([holding, waiting]);
  });
});

describe('runVerify', () => {
  it('goes through the process-wide verification slots', async () => {
    const spy = vi.spyOn(verifySlots, 'run');
    try {
      await expect(runVerify({ projectPath: '/nonexistent-project', baseRef: 'HEAD', commands: [] } as never)).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults to two concurrent verifications', () => {
    expect(verifySlots.limit).toBe(2);
  });
});
