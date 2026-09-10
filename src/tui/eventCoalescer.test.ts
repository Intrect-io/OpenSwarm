// Purpose: coalescer batches bursts into one flush per window (INT-2407).
import { describe, it, expect, vi } from 'vitest';
import { createCoalescer } from './eventCoalescer.js';

describe('createCoalescer (INT-2407)', () => {
  it('coalesces a burst of pushes into a single flush, preserving order', () => {
    vi.useFakeTimers();
    try {
      const batches: number[][] = [];
      const c = createCoalescer<number>({ delayMs: 90, onFlush: (items) => batches.push(items) });
      c.push(1);
      c.push(2);
      c.push(3);
      // Nothing flushes until the window elapses.
      expect(batches).toEqual([]);
      expect(c.pending()).toBe(3);
      vi.advanceTimersByTime(90);
      expect(batches).toEqual([[1, 2, 3]]);
      expect(c.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a fresh window after a flush (one flush per window)', () => {
    vi.useFakeTimers();
    try {
      const batches: number[][] = [];
      const c = createCoalescer<number>({ delayMs: 50, onFlush: (items) => batches.push(items) });
      c.push(1);
      vi.advanceTimersByTime(50);
      c.push(2);
      c.push(3);
      vi.advanceTimersByTime(50);
      expect(batches).toEqual([[1], [2, 3]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes synchronously when delayMs <= 0', () => {
    const batches: number[][] = [];
    const c = createCoalescer<number>({ delayMs: 0, onFlush: (items) => batches.push(items) });
    c.push(1);
    c.push(2);
    expect(batches).toEqual([[1], [2]]);
  });

  it('flush() drains buffered items immediately and clears the pending timer', () => {
    const cleared: unknown[] = [];
    const batches: number[][] = [];
    const c = createCoalescer<number>({
      delayMs: 90,
      onFlush: (items) => batches.push(items),
      setTimer: () => 42 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: (h) => cleared.push(h),
    });
    c.push(1);
    c.push(2);
    c.flush();
    expect(batches).toEqual([[1, 2]]);
    expect(cleared).toEqual([42]);
    // No-op when nothing is buffered.
    c.flush();
    expect(batches).toEqual([[1, 2]]);
  });

  it('cancel() drops buffered items without flushing', () => {
    vi.useFakeTimers();
    try {
      const batches: number[][] = [];
      const c = createCoalescer<number>({ delayMs: 90, onFlush: (items) => batches.push(items) });
      c.push(1);
      c.cancel();
      expect(c.pending()).toBe(0);
      vi.advanceTimersByTime(200);
      expect(batches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops oldest items once maxBatch is exceeded (AGT-3455)', () => {
    vi.useFakeTimers();
    try {
      const batches: number[][] = [];
      const c = createCoalescer<number>({
        delayMs: 50,
        maxBatch: 3,
        onFlush: (items) => batches.push(items),
      });
      for (let i = 1; i <= 10; i++) c.push(i);
      expect(c.pending()).toBe(3);
      vi.advanceTimersByTime(50);
      expect(batches).toEqual([[8, 9, 10]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
