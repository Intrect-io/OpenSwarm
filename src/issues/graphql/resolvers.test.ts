import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_LINK_TIMEOUT_MS,
  MAX_BACKGROUND_AUTO_LINKS,
  getBackgroundAutoLinkActiveForTests,
  resetAutoLinkSchedulerForTests,
  scheduleBackgroundAutoLinkForTests,
} from './resolvers.js';
import type { Issue } from '../schema.js';
import type { SqliteIssueStore } from '../sqliteStore.js';

/** Let the scheduler's async IIFE reach its slot acquire and arm the deadline. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/**
 * A linker standing in for an embedding/memory search that ignores AbortSignal:
 * it can never settle, so only the deadline can end the job.
 */
function hungLinker(): () => Promise<string[]> {
  return () => new Promise<string[]>(() => { /* never settles */ });
}

describe('background auto-link slot release', () => {
  beforeEach(() => {
    resetAutoLinkSchedulerForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAutoLinkSchedulerForTests();
  });

  const issue = { id: 'issue-1', title: 'long enough title for search', description: '' } as Issue;
  const store = {} as SqliteIssueStore;

  it('frees the slot when the deadline wins, so a later job runs while the search is still pending', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const linker = hungLinker();

    // Saturate the small pool with searches that can never be aborted.
    const flights = ['hung-a', 'hung-b'].map((id) =>
      scheduleBackgroundAutoLinkForTests(store, { ...issue, id } as Issue, linker),
    );
    await flushMicrotasks();
    expect(getBackgroundAutoLinkActiveForTests()).toBe(MAX_BACKGROUND_AUTO_LINKS);

    // The deadline — not the underlying search — must end each job.
    await vi.advanceTimersByTimeAsync(AUTO_LINK_TIMEOUT_MS);
    await expect(Promise.all(flights)).resolves.toEqual([[], []]);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);

    // A subsequent job runs to completion even though both searches are pending.
    const later = Promise.withResolvers<string[]>();
    const laterLinker = vi.fn(() => later.promise);
    const laterFlight = scheduleBackgroundAutoLinkForTests(store, { ...issue, id: 'later' } as Issue, laterLinker);
    await flushMicrotasks();
    expect(laterLinker).toHaveBeenCalledTimes(1);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(1);

    later.resolve(['mem-later']);
    await expect(laterFlight).resolves.toEqual(['mem-later']);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);
    warnSpy.mockRestore();
  });

  it('clears the deadline timer and frees the slot when the link settles first', async () => {
    const baselineTimers = vi.getTimerCount();
    const link = Promise.withResolvers<string[]>();
    const linker = vi.fn(() => link.promise);

    const flight = scheduleBackgroundAutoLinkForTests(store, issue, linker);
    await flushMicrotasks();
    // Deadline armed while the link is in flight.
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(1);

    link.resolve(['mem-1']);
    await expect(flight).resolves.toEqual(['mem-1']);
    // Cleared on settle, not left armed until expiry.
    expect(vi.getTimerCount()).toBe(baselineTimers);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);
  });

  it('returns the linked ids on completion and leaves the issue linkable again', async () => {
    const linker = vi.fn(async () => ['mem-1', 'mem-2']);
    const flight = scheduleBackgroundAutoLinkForTests(store, issue, linker);
    await flushMicrotasks();
    await expect(flight).resolves.toEqual(['mem-1', 'mem-2']);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);

    // The settled flight must not pin the issue id forever.
    const again = vi.fn(async () => ['mem-3']);
    await expect(scheduleBackgroundAutoLinkForTests(store, issue, again)).resolves.toEqual(['mem-3']);
    expect(again).toHaveBeenCalledTimes(1);
  });
});

describe('background auto-link deadline timer', () => {
  beforeEach(() => {
    resetAutoLinkSchedulerForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAutoLinkSchedulerForTests();
  });

  const issue = { id: 'issue-timer', title: 'long enough title for search', description: '' } as Issue;
  const store = {} as SqliteIssueStore;

  it('unrefs the deadline timer so a hung search cannot pin the process open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = realSetTimeout(handler as (...timerArgs: unknown[]) => void, timeout, ...args);
      timer.unref = unref;
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);

    try {
      void scheduleBackgroundAutoLinkForTests(store, issue, hungLinker()).catch(() => {});
      await flushMicrotasks();

      // The only timer armed here is the deadline. Nobody awaits a fire-and-forget
      // auto-link, so it must be unref'd rather than hold the event loop for 30s.
      expect(unref).toHaveBeenCalledTimes(1);
      expect(getBackgroundAutoLinkActiveForTests()).toBe(1);
    } finally {
      vi.restoreAllMocks();
      for (const timer of timers) clearTimeout(timer);
      warnSpy.mockRestore();
    }
  });
});
