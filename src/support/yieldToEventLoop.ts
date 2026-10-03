// ============================================
// OpenSwarm — yield to the event loop
// ============================================

/**
 * Give pending I/O callbacks, timers and HTTP requests a turn.
 *
 * Call it between slices of a long synchronous loop. A loop that never awaits
 * holds the whole daemon, including `/api/health`, for as long as it runs —
 * a registry scan did that for up to 154 s on 2026-10-03 (AGT-4665).
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
