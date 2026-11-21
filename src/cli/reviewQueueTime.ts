// ============================================
// OpenSwarm - request queue time for `review --max` (AGT-4313)
// ============================================
//
// Reports how long in-process adapter requests waited inside undici between
// `undici:request:create` and `undici:client:sendHeaders` during the first
// reviewer fan-out. The figure is process-wide: every in-process undici
// request in that window is counted, whoever made it. Only HTTP/1.1 requests
// publish sendHeaders in undici 6.x, so h2 requests (and subprocess adapters
// such as the codex/claude CLIs) contribute no samples.
import {
  getQueueTimeSnapshot,
  isQueueTimeCollectorRunning,
  startQueueTimeCollector,
  stopQueueTimeCollector,
  type QueueTimeSnapshot,
} from '../adapters/httpDispatcher.js';

export type { QueueTimeSnapshot };

export interface ReviewQueueTimeCapture {
  /** Live snapshot while capturing; after end(), the snapshot frozen at end(). */
  snapshot(): QueueTimeSnapshot;
  /** Freeze the snapshot and stop the collector, only if this capture started it. Idempotent. */
  end(): void;
}

/**
 * Start the collector unless something else already runs it.
 *
 * When the collector is already running (another owner), this capture takes no
 * baseline: snapshot() reports the owner's whole held window, including samples
 * recorded before begin and any traffic the owner adds, and end() leaves the
 * collector running. Nothing in src starts the collector besides this capture
 * today, so in practice the figure covers exactly the captured fan-out.
 */
export function beginReviewQueueTimeCapture(): ReviewQueueTimeCapture {
  const owned = !isQueueTimeCollectorRunning();
  if (owned) startQueueTimeCollector();
  let frozen: QueueTimeSnapshot | undefined;
  return {
    snapshot: () => frozen ?? getQueueTimeSnapshot(),
    end: () => {
      if (frozen) return;
      frozen = getQueueTimeSnapshot();
      if (owned) stopQueueTimeCollector();
    },
  };
}

/** Run `fn` under a capture; the collector is stopped even when `fn` throws. */
export async function captureQueueTime<T>(fn: () => Promise<T>): Promise<{ result: T; queueTime: QueueTimeSnapshot }> {
  const capture = beginReviewQueueTimeCapture();
  try {
    const result = await fn();
    capture.end();
    return { result, queueTime: capture.snapshot() };
  } finally {
    capture.end();
  }
}

/** One line for the terminal and the report. A missing measurement is "n/a", never "0 ms". */
export function formatQueueTimeLine(snap: QueueTimeSnapshot): string {
  if (snap.count === 0) return 'Request queue time: n/a (no in-process HTTP/1.1 adapter requests observed)';
  const ms = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return `Request queue time (undici create->sendHeaders): p50 ${ms(snap.p50Ms)} ms, p90 ${ms(snap.p90Ms)} ms over ${snap.count} request(s)`;
}
