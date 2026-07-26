// ============================================
// OpenSwarm - transient failures that used to become permanent
// ============================================
//
// Three places where a momentary problem was preserved for the life of the
// process: a request with no deadline of its own, a tool discovery cached with
// its failures, and a model lookup whose error was cached as an answer.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortSignalWithDeadline } from './requestDeadline.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('abortSignalWithDeadline', () => {
  it('aborts on its own deadline when the caller never does', async () => {
    const signal = abortSignalWithDeadline(undefined, 20)!;
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
  });

  it('aborts when the caller aborts, before the deadline', () => {
    const controller = new AbortController();
    const signal = abortSignalWithDeadline(controller.signal, 60_000)!;

    controller.abort();

    expect(signal.aborted).toBe(true);
  });

  // A long generation is normal; the deadline must be the caller's ceiling and
  // nothing shorter, or streaming answers get cut off mid-flight.
  it('does not abort early while the deadline has not passed', async () => {
    const signal = abortSignalWithDeadline(new AbortController().signal, 5_000)!;
    await new Promise((r) => setTimeout(r, 50));
    expect(signal.aborted).toBe(false);
  });

  it('passes the caller signal through when there is no deadline', () => {
    const controller = new AbortController();
    expect(abortSignalWithDeadline(controller.signal, undefined)).toBe(controller.signal);
    expect(abortSignalWithDeadline(controller.signal, 0)).toBe(controller.signal);
  });

  it('is undefined when there is neither', () => {
    expect(abortSignalWithDeadline(undefined, undefined)).toBeUndefined();
  });
});

describe('resolveAdapterDefaultModel', () => {
  // Caching the rejection meant one blip during startup left the adapter's
  // displayed model blank for the whole process, unrecoverable short of a
  // restart.
  it('retries after a failed lookup instead of caching the failure', async () => {
    const cache = new Map<string, Promise<string | undefined>>();
    const adapters = await import('../adapters/index.js');
    let calls = 0;
    vi.spyOn(adapters, 'getAdapter').mockImplementation((() => ({
      getDefaultModel: async () => {
        calls++;
        if (calls === 1) throw new Error('provider unreachable');
        return 'gpt-5.5';
      },
    })) as never);

    await expect(resolveAdapterDefaultModel('x', cache)).resolves.toBeUndefined();
    await expect(resolveAdapterDefaultModel('x', cache)).resolves.toBe('gpt-5.5');
    expect(calls).toBe(2);
  });

  // The cache still has to do its job: getDefaultModel is an OAuth + catalog
  // round trip, so a success must not be repeated.
  it('caches a successful lookup', async () => {
    const cache = new Map<string, Promise<string | undefined>>();
    const adapters = await import('../adapters/index.js');
    let calls = 0;
    vi.spyOn(adapters, 'getAdapter').mockImplementation((() => ({
      getDefaultModel: async () => { calls++; return 'gpt-5.5'; },
    })) as never);

    await resolveAdapterDefaultModel('x', cache);
    await resolveAdapterDefaultModel('x', cache);

    expect(calls).toBe(1);
  });

  it('keeps adapters separate', async () => {
    const cache = new Map<string, Promise<string | undefined>>();
    const adapters = await import('../adapters/index.js');
    vi.spyOn(adapters, 'getAdapter').mockImplementation(((name?: string) => ({
      getDefaultModel: async () => `model-for-${name ?? 'default'}`,
    })) as never);

    await expect(resolveAdapterDefaultModel('a', cache)).resolves.toBe('model-for-a');
    await expect(resolveAdapterDefaultModel('b', cache)).resolves.toBe('model-for-b');
  });
});
