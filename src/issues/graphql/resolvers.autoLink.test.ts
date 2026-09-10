import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../schema.js';
import type { SqliteIssueStore } from '../sqliteStore.js';

const autoLinkMemories = vi.fn();

vi.mock('../memoryBridge.js', () => ({
  autoLinkMemories: (...args: unknown[]) => autoLinkMemories(...args),
  enrichIssueContext: vi.fn(),
}));

const { __autoLinkTestHooks } = await import('./resolvers.js');

function fakeIssue(id: string): Issue {
  return {
    id,
    projectId: 'p',
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    source: 'local',
    labels: [],
    relevantFiles: [],
    acceptanceCriteria: [],
    dependencies: [],
    childIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Issue;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __autoLinkTestHooks.reset();
  autoLinkMemories.mockReset();
});

afterEach(() => {
  __autoLinkTestHooks.reset();
});

describe('scheduleAutoLinkMemories supervision', () => {
  it('caps concurrent auto-link jobs at AUTO_LINK_MAX_CONCURRENT', async () => {
    const blockers: Array<ReturnType<typeof deferred<void>>> = [];
    autoLinkMemories.mockImplementation(() => {
      const d = deferred<void>();
      blockers.push(d);
      return d.promise;
    });

    const store = {} as SqliteIssueStore;
    const max = __autoLinkTestHooks.maxConcurrent;
    for (let i = 0; i < max + 2; i++) {
      __autoLinkTestHooks.schedule(store, fakeIssue(`issue-${i}`));
    }

    await vi.waitFor(() => expect(autoLinkMemories).toHaveBeenCalledTimes(max));
    expect(__autoLinkTestHooks.inFlight).toBe(max);
    expect(__autoLinkTestHooks.waiterCount).toBe(2);

    blockers[0]!.resolve();
    await vi.waitFor(() => expect(autoLinkMemories).toHaveBeenCalledTimes(max + 1));

    for (const b of blockers) b.resolve();
    await vi.waitFor(() => expect(__autoLinkTestHooks.inFlight).toBe(0));
  });

  it('clears the timeout when auto-link finishes before the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      __autoLinkTestHooks.setTimeoutMs(80);
      autoLinkMemories.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10)),
      );
      __autoLinkTestHooks.schedule({} as SqliteIssueStore, fakeIssue('fast'));
      await vi.waitFor(() => expect(__autoLinkTestHooks.inFlight).toBe(0));
      // Give a late timer reject time to surface if clearTimeout were missing.
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('releases the slot after a timeout and absorbs a late work rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      __autoLinkTestHooks.setTimeoutMs(30);
      autoLinkMemories.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late work failure')), 100);
          }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      __autoLinkTestHooks.schedule({} as SqliteIssueStore, fakeIssue('slow'));
      await vi.waitFor(() => expect(__autoLinkTestHooks.inFlight).toBe(0));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('timed out'))).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(unhandled).toEqual([]);
      warn.mockRestore();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

});
