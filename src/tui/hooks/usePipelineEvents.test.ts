import { describe, expect, it, vi } from 'vitest';
import { normalizeFlushMs, MAX_FLUSH_MS } from './usePipelineEvents.js';
import { createCoalescer } from '../eventCoalescer.js';

describe('normalizeFlushMs', () => {
  it('keeps a valid interval, rounded', () => {
    expect(normalizeFlushMs(90)).toBe(90);
    expect(normalizeFlushMs(42.6)).toBe(43);
  });

  it('falls back to the default for invalid intervals instead of disabling coalescing', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '90', undefined, null]) {
      expect(normalizeFlushMs(bad)).toBe(90);
    }
  });

  it('caps very long windows', () => {
    expect(normalizeFlushMs(60_000)).toBe(MAX_FLUSH_MS);
  });

  it('still batches a burst into one flush when the configured interval was invalid', () => {
    vi.useFakeTimers();
    try {
      const flushes: number[][] = [];
      const coalescer = createCoalescer<number>({
        delayMs: normalizeFlushMs(-1),
        onFlush: (batch) => flushes.push(batch),
      });
      for (let i = 0; i < 25; i++) coalescer.push(i);
      expect(flushes).toHaveLength(0);
      vi.advanceTimersByTime(90);
      expect(flushes).toHaveLength(1);
      expect(flushes[0]).toHaveLength(25);
    } finally {
      vi.useRealTimers();
    }
  });
});
