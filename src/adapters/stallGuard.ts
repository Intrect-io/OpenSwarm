// ============================================
// OpenSwarm - silent-request guard
// ============================================
//
// A provider request is bounded by the stage's whole budget (requestDeadline).
// That catches a request that never ends, but not soon: measured on a real
// Ollama Cloud run (AGT-4534, run base2), one request accepted the call and
// then produced nothing, and the reviewer sat on it for the full 600 s before
// the stage deadline ended it. A guard that aborts after a window with no bytes
// lets the adapter retry the request instead of losing the stage.

/** Code the transient-failure classifier recognises (throttleRetry.ts). */
export const STREAM_STALL_CODE = 'ESTREAMSTALL';

export class StreamStallError extends Error {
  readonly code = STREAM_STALL_CODE;

  constructor(readonly idleMs: number) {
    super(`provider request produced no bytes for ${Math.round(idleMs / 1000)}s — abandoned`);
    this.name = 'StreamStallError';
  }
}

export interface StallGuard {
  /** Aborts, with a StreamStallError reason, after `idleMs` without `touch()`. */
  signal: AbortSignal;
  /** Record progress (a response or a body chunk arrived). */
  touch(): void;
  /** Stop the timer; the signal will not fire afterwards. */
  clear(): void;
  /** Whether the guard is what aborted the request. */
  stalled(): boolean;
}

export function createStallGuard(idleMs: number): StallGuard {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new StreamStallError(idleMs)), idleMs);
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    touch: () => {
      if (!cleared && !controller.signal.aborted) arm();
    },
    clear: () => {
      cleared = true;
      if (timer) clearTimeout(timer);
    },
    stalled: () => controller.signal.reason instanceof StreamStallError,
  };
}
