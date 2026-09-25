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
  /** Transient-failure retries used by this call (see resolveTransientFailure). */
  transientAttempts?: number;
}

// ---------------------------------------------------------------------------
// Transient failures: a 5xx or a dropped connection is not a verdict on the
// request, and it is not a limit either. Before AGT-4385 every in-process
// adapter threw on the first one; agenticLoop classifies that as an infra
// error and re-throws, so one flaky socket discarded a whole worker
// conversation and the pipeline restarted the attempt later from scratch.
// This Mac's daemon logs held 211 `fetch failed`, 19 UND_ERR_CONNECT_TIMEOUT
// and 4 ECONNRESET at the time. A model step is retried a bounded number of
// times instead — the request has no side effects, so a retry is free.
// ---------------------------------------------------------------------------

/** Escalating waits for a transient retry: short, because the fault is a
 *  socket or an upstream blip, not a quota. Five retries, six attempts. */
export const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** HTTP statuses that mean "try again", never "you were wrong". 529 is the
 *  Anthropic/OpenRouter overloaded status. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 529]);

/** undici / Node error codes for a connection that never delivered a response. */
// ESTREAMSTALL: a request that went silent and was abandoned (stallGuard.ts).
const TRANSIENT_CAUSE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ESTREAMSTALL'];

export interface TransientFailure {
  /** Set when the server answered with a non-OK status. */
  status?: number;
  /** Set when the request itself threw (fetch failed, socket dropped). */
  error?: unknown;
}

/** True for a thrown request error that a retry can plausibly fix. A caller
 *  abort (Esc, or the per-call deadline) is deliberately NOT transient: the
 *  caller ended the request, so retrying would run past the deadline it set. */
export function isTransientRequestError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return false;
  if (error instanceof DOMException) return false; // TimeoutError from AbortSignal.timeout()
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (code.startsWith('UND_ERR')) return true;
  if (TRANSIENT_CAUSE_CODES.includes(code)) return true;
  // Node puts the code on the error itself for non-fetch sockets.
  const ownCode = (error as { code?: unknown }).code;
  return typeof ownCode === 'string' && (ownCode.startsWith('UND_ERR') || TRANSIENT_CAUSE_CODES.includes(ownCode));
}

function describeTransient(failure: TransientFailure): string {
  if (failure.status != null) return `HTTP ${failure.status}`;
  const err = failure.error as { cause?: { code?: unknown }; code?: unknown; message?: unknown } | undefined;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === 'string' && code) return code;
  return typeof err?.message === 'string' ? err.message.slice(0, 80) : 'request failed';
}

/**
 * Decide whether a failed model call should be retried in place.
 *
 * Returns 'retry' after waiting out the backoff (abortable via opts.signal),
 * 'other' when the failure is not transient — the caller then throws as it did
 * before. When the budget is spent the last failure is 'other' too, so the
 * existing error path reports it; this never throws its own error.
 *
 * Sits beside resolveLimitResponse on purpose: a 429 is a limit (handled
 * there, longer waits, quota bookkeeping); a 503 is a blip (handled here).
 */
export async function resolveTransientFailure(
  provider: string,
  failure: TransientFailure,
  state: ThrottleState,
  opts: ResolveLimitOptions = {},
): Promise<'retry' | 'other'> {
  if (opts.signal?.aborted) return 'other';
  const transient =
    failure.status != null ? TRANSIENT_HTTP_STATUSES.has(failure.status) : isTransientRequestError(failure.error);
  if (!transient) return 'other';

  const used = state.transientAttempts ?? 0;
  if (used >= TRANSIENT_BACKOFF_MS.length) return 'other';
  const waitMs = TRANSIENT_BACKOFF_MS[used] + Math.floor(Math.random() * 500);
  state.transientAttempts = used + 1;
  const log = opts.onLog ?? ((message: string) => console.warn(`[${provider}] ${message}`));
  log(
    `${provider} transient failure (${describeTransient(failure)}) — waiting ${Math.round(waitMs / 1000)}s, ` +
      `retry ${state.transientAttempts}/${TRANSIENT_BACKOFF_MS.length}`,
  );
  try {
    await sleepAbortable(waitMs, opts.signal);
  } catch {
    return 'other'; // aborted while waiting — let the caller surface the original failure
  }
  return 'retry';
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
