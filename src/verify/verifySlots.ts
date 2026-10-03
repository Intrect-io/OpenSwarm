// Created: 2026-10-03
// Purpose: bound how many deterministic verifications run the target repository's test suite at once (AGT-4676)
// Dependencies: none
// Test Status: verifySlots.test.ts

/**
 * Every attempt that reaches verification runs the repository's full suite in its own
 * sandbox. Eight of them at once, on a machine other sessions also load, took 300 s to
 * reach 3% of a suite that finishes in 272 s when the machine is calm, so every verdict
 * was lost to the pytest cap and the attempt fell back to the LLM tester (about 16 min).
 */

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_WAIT_MS = 20 * 60_000;

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** FIFO counting semaphore whose waiters give up after `maxWaitMs`. */
export class VerifySlots {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly maxWaitMs: number,
  ) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Run `work` once a slot is free. The slot is held for the whole of `work`, so a
   * timeout inside it (the pytest cap) starts counting only after the wait is over.
   * When no slot frees up within `maxWaitMs` the call rejects instead of queueing
   * forever; the tester treats that as "deterministic verify unavailable" and falls
   * back to the LLM tester, which is the behaviour before this limit existed.
   */
  async run<T>(work: () => Promise<T>, onWait?: (ahead: number, running: number) => void): Promise<T> {
    if (this.active >= this.limit) {
      onWait?.(this.queue.length, this.active);
      await this.acquire();
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          // A waiter that gave up must leave the queue, or release() would hand it a
          // slot nobody is waiting on and the slot would never come back.
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error(
            `verify-runner: no verification slot within ${this.maxWaitMs}ms `
            + `(${this.active}/${this.limit} running, ${this.queue.length} still waiting)`,
          ));
        }, this.maxWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    // The slot passes straight to the next waiter, so `active` stays where it is.
    if (next) next.grant();
    else this.active -= 1;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Sized once, when the process starts; a bound on a shared resource is not a per-call argument. */
export const verifySlots = new VerifySlots(
  positiveInt(process.env.OPENSWARM_VERIFY_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
  positiveInt(process.env.OPENSWARM_VERIFY_SLOT_WAIT_MS, DEFAULT_MAX_WAIT_MS),
);
