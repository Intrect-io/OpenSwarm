// ============================================
// OpenSwarm - Throttle vs quota handling for HTTP adapters (INT-2907)
// ============================================
//
// A 429 (or a 402, or a body that mentions a limit) is not automatically "this
// account is out of quota". Providers use the same statuses for short-window
// throttling — concurrent requests, requests/min — which clears in seconds.
// Treating both alike made `review --max`, which runs 4-16 subagents at once,
// report `usage limit hit` and abort on accounts with quota to spare.
//
// So: a SPENT QUOTA still fails fast as a typed RateLimitError (the scheduler
// pauses, `--max` falls back), and a THROTTLE is waited out and retried. Only if
// the wait budget runs out does the call fail — as an infra error for that one
// call, never as a limit for the whole run.

import {
  RateLimitError,
  classifyLimitResponse,
  matchesRateLimitMessage,
  rateLimitFromHttpResponse,
} from './rateLimitError.js';
import { recordQuotaObservation } from './quotaSnapshot.js';

/** Escalating waits for a throttled retry. */
export const THROTTLE_BACKOFF_MS = [5_000, 15_000, 40_000] as const;
/** Cap on an honored Retry-After: past this, retrying the task later is cheaper than waiting. */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Per-API-call retry budget. A fresh one each call: a wait that cleared one
 *  turn's throttle must not count against the next turn. */
export interface ThrottleState {
  attempts: number;
}

/** Wait for this attempt: the server's Retry-After when it gave one, else our
 *  backoff plus jitter — throttles come from many subagents in flight, and an
 *  unjittered backoff has them all retry on the same tick and re-trigger the
 *  very throttle they are waiting out. */
export function throttleWaitMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const backoff = THROTTLE_BACKOFF_MS[Math.min(attempt, THROTTLE_BACKOFF_MS.length - 1)];
  return backoff + Math.floor(Math.random() * 1000);
}

/** Sleep that a user abort (Esc/Ctrl+C) cuts short instead of blocking on. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ResolveLimitOptions {
  signal?: AbortSignal;
  /** Progress line for the live log ("waiting 15s, retry 2/3"). */
  onLog?: (line: string) => void;
  /** Provider-specific typed quota error (codex builds a richer one from its headers). */
  quotaError?: (headers: Headers | undefined, body: string) => RateLimitError;
}

/**
 * Interpret a failed HTTP response for limit semantics.
 *
 * - `'other'` — not a limit at all; the caller throws its own error.
 * - `'retry'` — it was a throttle and the wait has already happened; re-issue
 *   the request.
 * - throws `RateLimitError` — the quota itself is spent.
 * - throws `throttle-retry: …` — still throttled after the whole budget.
 *   Classified as infra (see errorClassification), and worded so
 *   detectRateLimit cannot re-promote it to a rate limit downstream.
 */
export async function resolveLimitResponse(
  provider: string,
  status: number,
  headers: Headers | undefined,
  body: string,
  state: ThrottleState,
  opts: ResolveLimitOptions = {},
): Promise<'retry' | 'other'> {
  // Mirror rateLimitFromHttpResponse's contract: 429 is unambiguous, every other
  // status (402 included) must carry a usage/credit signature in the body — a
  // bare "Payment Required" is the caller's own error, not a limit. (INT-2520)
  const isLimit = status === 429 || matchesRateLimitMessage(body);
  if (!isLimit) return 'other';

  const cls = classifyLimitResponse(headers, body);
  if (cls.quota) {
    const error =
      opts.quotaError?.(headers, body) ??
      rateLimitFromHttpResponse(status, headers, body) ??
      new RateLimitError(undefined, `${provider}: usage limit reached`);
    // Every in-process adapter funnels its 429s through here — record the
    // signals the error carries before they leave with the throw, so the
    // cockpit quota gauge sees them. (INT-3402)
    recordQuotaObservation({
      provider,
      usedPercent: error instanceof RateLimitError ? error.usedPercent ?? cls.usedPercent : cls.usedPercent,
      windowMinutes: error instanceof RateLimitError ? error.windowMinutes : undefined,
      resetsAt: error instanceof RateLimitError ? error.resetsAt : undefined,
      retryAfterSeconds: cls.retryAfterSeconds,
      source: 'quota-exhausted',
    });
    throw error;
  }
  recordQuotaObservation({
    provider,
    usedPercent: cls.usedPercent,
    retryAfterSeconds: cls.retryAfterSeconds,
    source: 'throttle',
  });

  const window = cls.usedPercent != null ? `, window ${cls.usedPercent}% used` : '';
  if (state.attempts < THROTTLE_BACKOFF_MS.length) {
    const waitMs = throttleWaitMs(state.attempts, cls.retryAfterSeconds);
    state.attempts++;
    opts.onLog?.(
      `${provider} throttled (HTTP ${status}${window}) — waiting ${Math.round(waitMs / 1000)}s, ` +
        `retry ${state.attempts}/${THROTTLE_BACKOFF_MS.length}`,
    );
    await sleepAbortable(waitMs, opts.signal);
    return 'retry';
  }

  throw new Error(`throttle-retry: ${provider} still limited (HTTP ${status}${window}) after ${state.attempts} retries`);
}
