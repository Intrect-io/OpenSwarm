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

describe('createMemorySearchHandler orphaned searches', () => {
  it('rejects new calls as busy once running + orphaned hung searches reach the hard cap', async () => {
    vi.useFakeTimers();
    const { search } = controllableSearch(); // never resolved: hung embeddings
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 1, timeoutMs: 1_000 });

    // First hung search times out and becomes an orphan.
    const first = handler({ query: 'h1' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).content[0].text).toContain('timed out');
    expect(handler.running).toBe(0);
    expect(handler.orphaned).toBe(1);

    // Second one runs (1 orphan + 1 running = hard cap 2) and also times out.
    const second = handler({ query: 'h2' });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(handler.orphaned).toBe(2);

    // Every slot is free but two orphans still run: the hard cap rejects the call.
    const rejected = await handler({ query: 'h3' });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('busy');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('frees capacity when an orphaned search finally settles', async () => {
    vi.useFakeTimers();
    const { search, pending } = controllableSearch();
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 1, hardCap: 1, timeoutMs: 1_000 });

    const hung = handler({ query: 'h1' });
    await vi.advanceTimersByTimeAsync(1_000);
    await hung;
    expect(handler.orphaned).toBe(1);
    expect((await handler({ query: 'blocked' })).content[0].text).toContain('busy');

    pending[0].resolve('late');
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.orphaned).toBe(0);

    const next = handler({ query: 'next' });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(2);
    pending[1].resolve('');
    expect((await next).content[0].text).toBe('next');
  });

  it('aborts the signal passed to the search when the deadline hits', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const search = vi.fn((_cwd: string, _q: string, _l: number, signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => {});
    });
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', timeoutMs: 1_000 });
    const call = handler({ query: 'x' });
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await call;
    expect(seen?.aborted).toBe(true);
  });

  it('releases the slot when the MCP request is cancelled', async () => {
    const { search } = controllableSearch();
    const handler = createMemorySearchHandler({ search, cwd: () => '/repo', maxConcurrent: 1, timeoutMs: 60_000 });
    const request = new AbortController();

    const call = handler({ query: 'cancel me' }, request.signal);
    await Promise.resolve();
    expect(handler.running).toBe(1);

    request.abort();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cancelled');
    expect(handler.running).toBe(0);
    expect(handler.orphaned).toBe(1);

    // An already-aborted request does not take a slot at all.
    const early = await handler({ query: 'late' }, request.signal);
    expect(early.content[0].text).toContain('cancelled');
    expect(search).toHaveBeenCalledTimes(1);
  });
});
