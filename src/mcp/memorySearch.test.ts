// AGT-4875 — the memory MCP server's search handler caps concurrent searches and
// returns the slot even when a search hits its deadline.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemorySearchHandler } from './memorySearch.js';

interface Pending {
  resolve: (text: string) => void;
}

function controllableSearch() {
  const pending: Pending[] = [];
  let inFlight = 0;
  let peak = 0;
  const search = vi.fn((_cwd: string, query: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<string>((resolve) => {
      pending.push({
        resolve: (text) => {
          inFlight -= 1;
          resolve(text || query);
        },
      });
    });
  });
  return { search, pending, peak: () => peak };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createMemorySearchHandler concurrency', () => {
  it('never runs more searches than the limit and rejects the excess as busy', async () => {
    const { search, pending, peak } = controllableSearch();
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 2, timeoutMs: 10_000 });

    const calls = Array.from({ length: 5 }, (_, i) => handler({ query: `q${i}` }));
    await Promise.resolve();

    expect(search).toHaveBeenCalledTimes(2);
    expect(handler.running).toBe(2);
    expect(peak()).toBe(2);

    for (const p of pending) p.resolve('');
    const results = await Promise.all(calls);

    expect(results.filter((r) => !r.isError).map((r) => r.content[0].text)).toEqual(['q0', 'q1']);
    const busy = results.filter((r) => r.isError);
    expect(busy).toHaveLength(3);
    expect(busy.every((r) => r.content[0].text.includes('busy'))).toBe(true);
    expect(handler.running).toBe(0);

    // Slots are free again: a new call runs.
    const again = handler({ query: 'later' });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(3);
    pending[2].resolve('');
    expect((await again).isError).toBeUndefined();
  });

  it('returns the slot when a search hits its deadline', async () => {
    vi.useFakeTimers();
    const { search } = controllableSearch(); // never resolved: a hung embedding
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 1, timeoutMs: 1_000 });

    const hung = handler({ query: 'hung' });
    await Promise.resolve();
    expect(handler.running).toBe(1);
    expect((await handler({ query: 'blocked' })).content[0].text).toContain('busy');

    await vi.advanceTimersByTimeAsync(1_000);
    const timedOut = await hung;
    expect(timedOut.isError).toBe(true);
    expect(timedOut.content[0].text).toContain('timed out after 1000ms');
    expect(handler.running).toBe(0);

    const next = handler({ query: 'next' });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(2);
    expect(handler.running).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await next;
    expect(handler.running).toBe(0);
  });

  it('releases the slot when the search throws, and rejects bad arguments without taking one', async () => {
    const search = vi.fn(async () => {
      throw new Error('index missing');
    });
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 1 });

    const bad = await handler({ query: '' });
    expect(bad.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();

    const failed = await handler({ query: 'x' });
    expect(failed.content[0].text).toContain('index missing');
    expect(handler.running).toBe(0);
    expect((await handler({ query: 'y' })).content[0].text).toContain('index missing');
  });
});
