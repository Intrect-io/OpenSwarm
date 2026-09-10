import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'graphql';
import {
  AUTO_LINK_MEMORIES_COST,
  BULK_REGISTER_ENTITIES_COST,
  DEFAULT_QUERY_COST_LIMIT,
  calculateOperationCost,
} from './costAnalysis.js';
import {
  getBackgroundAutoLinkActiveForTests,
  resetAutoLinkSchedulerForTests,
  runAutoLinkWithDeadline,
  scheduleBackgroundAutoLinkForTests,
} from './resolvers.js';
import type { Issue } from '../schema.js';
import type { SqliteIssueStore } from '../sqliteStore.js';

describe('calculateOperationCost — autoLinkMemories', () => {
  it('charges the expensive base cost for a single autoLinkMemories mutation', () => {
    const doc = parse(`mutation { autoLinkMemories(issueId: "i1") }`);
    expect(calculateOperationCost(doc)).toBe(AUTO_LINK_MEMORIES_COST);
  });

  it('multiplies cost for aliased autoLinkMemories mutations', () => {
    const doc = parse(`
      mutation {
        a: autoLinkMemories(issueId: "i1")
        b: autoLinkMemories(issueId: "i2")
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(AUTO_LINK_MEMORIES_COST * 2);
    expect(cost).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);
  });

  it('still prices bulkRegisterEntities at its documented cost', () => {
    const doc = parse(`
      mutation {
        bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
      }
    `);
    expect(calculateOperationCost(doc)).toBe(BULK_REGISTER_ENTITIES_COST);
  });
});

describe('runAutoLinkWithDeadline', () => {
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

  it('clears the deadline timer when the link settles successfully', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const linkFn = vi.fn(async () => ['mem-1']);
    const resultPromise = runAutoLinkWithDeadline(store, issue, 5_000, linkFn);
    await expect(resultPromise).resolves.toEqual(['mem-1']);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('rejects on timeout and clears the deadline timer', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const linkFn = vi.fn(() => new Promise<string[]>(() => { /* never settles */ }));
    const resultPromise = runAutoLinkWithDeadline(store, issue, 50, linkFn);
    const expectation = expect(resultPromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('releases the background job slot when a timed-out auto-link settles', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const linkFn = vi.fn(() => new Promise<string[]>(() => { /* never settles */ }));
    const flight = scheduleBackgroundAutoLinkForTests(store, issue, linkFn);

    // Flush the async IIFE so it acquires a slot and arms the deadline timer.
    await Promise.resolve();
    await Promise.resolve();
    expect(getBackgroundAutoLinkActiveForTests()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(flight).resolves.toEqual([]);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);
    warnSpy.mockRestore();
  });

  it('never lets concurrent waiters push active slots past the cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blockers: Array<() => void> = [];
    const linkFn = vi.fn(
      () => new Promise<string[]>((resolve) => {
        blockers.push(() => resolve(['ok']));
      }),
    );

    const issueA = { ...issue, id: 'issue-a' } as Issue;
    const issueB = { ...issue, id: 'issue-b' } as Issue;
    const issueC = { ...issue, id: 'issue-c' } as Issue;

    const flightA = scheduleBackgroundAutoLinkForTests(store, issueA, linkFn);
    const flightB = scheduleBackgroundAutoLinkForTests(store, issueB, linkFn);
    const flightC = scheduleBackgroundAutoLinkForTests(store, issueC, linkFn);

    // Cap is 2: A+B hold slots; C waits. Flush microtasks so acquires settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(getBackgroundAutoLinkActiveForTests()).toBe(2);
    expect(blockers).toHaveLength(2);

    // Free one slot; waiter must re-check so active never exceeds the cap.
    blockers[0]!();
    await flightA;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(getBackgroundAutoLinkActiveForTests()).toBeLessThanOrEqual(2);

    blockers[1]!();
    // Third job may now be in blockers[2]
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (blockers[2]) blockers[2]();
    await Promise.all([flightB, flightC]);
    expect(getBackgroundAutoLinkActiveForTests()).toBe(0);
    warnSpy.mockRestore();
  });
});
