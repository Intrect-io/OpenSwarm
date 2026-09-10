// ============================================
// OpenSwarm - Event coalescer (INT-2407)
// Buffers a burst of items and flushes them as one batch at most once per
// `delayMs`, so rapid SSE events cause a single re-render instead of N. In the
// alternate-screen buffer every React commit repaints the whole frame, so N
// per-event commits = N visible erase/redraws = flicker. Pure (timer injectable)
// — unit-tested without React/ink.
// ============================================

type TimerHandle = ReturnType<typeof setTimeout>;

export interface Coalescer<T> {
  /** Buffer an item; schedules a trailing flush if none is pending. */
  push(item: T): void;
  /** Immediately flush any buffered items (no-op when empty). */
  flush(): void;
  /** Drop buffered items and cancel a pending flush. */
  cancel(): void;
  /** Buffered-but-not-yet-flushed count (introspection/tests). */
  pending(): number;
}

export interface CoalescerOptions<T> {
  /** Receives the batch (in push order) on each flush. Never called with []. */
  onFlush: (items: T[]) => void;
  /** Max time an item waits before flushing. `<= 0` flushes synchronously on push. */
  delayMs: number;
  /**
   * Hard cap on buffered items. Under an event flood, older items are dropped
   * once this limit is reached so memory and a single React commit stay bounded.
   * Default: unbounded (legacy behaviour).
   */
  maxBatch?: number;
  /** Injectable timer (defaults to global setTimeout) — swapped in tests. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** Injectable clear (defaults to global clearTimeout). */
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * Create a trailing-edge coalescer: the first `push` schedules a flush in
 * `delayMs`; further pushes within that window accumulate without rescheduling,
 * so throughput is bounded to one flush per `delayMs` and latency to `delayMs`.
 */
export function createCoalescer<T>(options: CoalescerOptions<T>): Coalescer<T> {
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const maxBatch = options.maxBatch != null && options.maxBatch > 0 ? options.maxBatch : undefined;
  let buffer: T[] = [];
  let timer: TimerHandle | null = null;

  const emit = () => {
    timer = null;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    options.onFlush(batch);
  };

  return {
    push(item) {
      buffer.push(item);
      if (maxBatch != null && buffer.length > maxBatch) {
        // Keep the newest events — older flood noise is less useful to render.
        buffer = buffer.slice(-maxBatch);
      }
      if (options.delayMs <= 0) {
        emit();
        return;
      }
      if (timer === null) timer = setTimer(emit, options.delayMs);
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      emit();
    },
    cancel() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      buffer = [];
    },
    pending() {
      return buffer.length;
    },
  };
}
