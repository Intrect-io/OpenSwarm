// ============================================
// OpenSwarm - Rate Limit / Usage Limit detection — SINGLE SOURCE OF TRUTH
// ============================================
//
// Every provider signals "you hit a usage/rate/quota limit" differently:
//   - codex-responses (HTTP): 429 + x-codex-* headers → "Codex N% used of Mmin window"
//   - codex CLI: stdout event {"type":"error","message":"You've hit your usage limit … purchase more credits …"}
//   - claude CLI: stream-json result "Limit reached · resets 8pm (Asia/Seoul) · add funds …"
//                 + a rate_limit_event carrying "out_of_credits"
//   - gpt (OpenAI HTTP): 429 body {"code":"rate_limit_exceeded"} OR {"code":"insufficient_quota"}
//   - openrouter (HTTP): 429 "Rate limit exceeded" OR **402** "Insufficient credits"
//   - local/lmstudio (HTTP): 429 "Too Many Requests" / server "overloaded"
//
// Historically each adapter grew its own ad-hoc handling, so new phrasings kept
// slipping through and getting mis-classified (INT-2519: codex 300min-window
// laundered into a 55% HALT → false STUCK; the audit for INT-2520 found the same
// class in gpt/openrouter/local/codex-CLI/claude-CLI). This module is the ONE
// place that knows every provider's limit signature. Two entry points:
//   - detectRateLimit(stdout, stderr)      — string scan (CLI stdout/stderr, error messages)
//   - rateLimitFromHttpResponse(status, …) — HTTP boundary (in-process adapters), preferred: typed at source
//
// A missed limit is never harmless: for in-process adapters it becomes a fake
// empty "success" → reviewer reject → STUCK; for CLI adapters it loses the global
// scheduler pause and keeps hammering the exhausted quota. (INT-2519, INT-2520)

export class RateLimitError extends Error {
  constructor(
    /** Unix timestamp (seconds) when the quota resets, if provided by the API */
    public readonly resetsAt?: number,
    message?: string,
    /** Percent of the primary window consumed (0-100), from x-codex-* headers. */
    public readonly usedPercent?: number,
    /** Primary window length in minutes, from x-codex-* headers. */
    public readonly windowMinutes?: number,
  ) {
    super(message ?? 'Rate limit reached');
    this.name = 'RateLimitError';
  }
}

// ---- The single registry of usage/rate-limit message signatures ----
//
// These are SPECIFIC enough to scan raw CLI stdout (which contains model-generated
// text) without false-positiving on a task that merely *mentions* rate limits /
// usage / credits in code or prose. That is why we do NOT use the broad
// "usage" + "limit" co-occurrence heuristic here (isProviderQuotaError uses that,
// but only to gate a fallback, not on raw output). Each entry cites its provider.
const RATE_LIMIT_SUBSTRINGS: readonly string[] = [
  'usage_limit_reached',        // codex / OpenAI structured code
  'rate_limit_exceeded',        // OpenAI / openrouter structured code
  '"rate_limit_error"',         // Anthropic structured type
  'insufficient_quota',         // OpenAI 429 quota-exhausted code
  'insufficient credits',       // openrouter 402 body
  'requires more credits',      // openrouter 402 (max_tokens vs balance) body
  'out of credits',             // generic
  'out_of_credits',             // claude rate_limit_event overageDisabledReason
  'usage limit reached',        // codex-responses header fallback phrasing
  "you've hit your usage limit",// codex CLI stdout error event
  'hit your usage limit',       // codex CLI (contraction-agnostic)
  'purchase more credits',      // codex CLI stdout error event
  'exceeded your current quota',// OpenAI insufficient_quota human message
  'too many requests',          // HTTP 429 standard reason (local/lmstudio/others)
];

// Regex signatures that need structure (co-occurrence / numeric context) to stay
// specific. Each cites its provider.
const RATE_LIMIT_REGEXES: readonly RegExp[] = [
  /\d+%\s*used\s+of\s+\d+min\s+window/, // codex-responses header phrasing
  // claude CLI human phrase: "Limit reached · resets 8pm … · add funds … extra usage".
  // Require "limit reached" to co-occur with a reset/billing cue so ordinary prose
  // ("the rate limit reached its cap in the test") doesn't trip it.
  /limit reached[\s\S]{0,80}(resets|add funds|extra usage)/,
  // bare "429" only counts alongside a rate-limit / too-many-requests / quota cue,
  // or as an "(429)" status echo from an adapter's error wrapper.
  /\b429\b[\s\S]{0,30}(rate.?limit|too many|quota)/,
  /error \(429\)/,
  // An upstream BYOK provider proxied THROUGH OpenRouter reports ITS exhausted
  // balance in its own words — OpenRouter answers 402 with
  // metadata.raw = {"code":402,"msg":"insufficient balance"}. A bare
  // "insufficient balance" substring cannot go in the list above: it is the stock
  // error string of wallet/payment/banking code, and these signatures are scanned
  // against raw model output, so a worker merely editing such a repo would trip it
  // and pause the scheduler. Anchoring on the JSON key keeps it provider-shaped.
  // The backslashes are not optional: the phrase arrives nested inside a JSON
  // STRING, so the real bytes are \"msg\":\"insufficient balance\" — a pattern
  // written without them matches the shape people expect and never the one that
  // actually arrives. (AGT-4215)
  /"msg\\?"\s*:\s*\\?"insufficient balance/,
];

/** True when `text` carries any provider's usage/rate/quota-limit signature. */
export function matchesRateLimitMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    RATE_LIMIT_SUBSTRINGS.some((s) => lower.includes(s)) ||
    RATE_LIMIT_REGEXES.some((r) => r.test(lower))
  );
}

// ---- Reset-time extraction (shared) ----

/**
 * Pull a unix reset timestamp (seconds) out of a JSON body. Accepts BOTH
 * snake_case "resets_at" (codex / OpenAI) and camelCase "resetsAt" (claude's
 * rate_limit_event) — matching only snake_case left claude's pause defaulting to
 * 60s so it immediately re-hit the limit. (INT-2521)
 */
export function parseResetsAtFromBody(text: string): number | undefined {
  const m = text.match(/"resets?_?at"\s*:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Pull a unix reset timestamp (seconds) out of headers or a JSON body, if present. */
function extractResetsAt(headers: Headers | undefined, body: string): number | undefined {
  const fromHeader = (k: string): number | undefined => {
    const v = headers?.get(k);
    const n = v == null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  // Only headers/fields that are genuinely UNIX-epoch seconds or seconds-from-now:
  //  - x-codex-primary-reset-at: epoch seconds
  //  - Retry-After: seconds-from-now (→ convert to epoch)
  //  - body "resets_at": epoch seconds
  // Deliberately NOT x-ratelimit-reset-requests/-tokens: OpenAI returns those as
  // DURATION strings ("1s", "6ms", "2m59s"), not epoch — parseInt would yield a
  // 1970 timestamp and defeat the pause. Omitting them falls back to the safe
  // 60s default, which is correct rather than wrong. (INT-2520 review)
  const codexReset = fromHeader('x-codex-primary-reset-at');
  if (codexReset != null) return codexReset;
  const retryAfter = fromHeader('retry-after');
  if (retryAfter != null) return Math.floor(Date.now() / 1000) + retryAfter;
  return parseResetsAtFromBody(body);
}

// ---- 429: spent quota vs short-window throttle (INT-2907) ----
//
// A 429 is NOT automatically "your plan's quota is gone". The Codex/OpenAI
// backends also 429 for short-window throttling (concurrent requests,
// requests/min), which clears in seconds. Treating both the same made a
// `review --max` run — 4 to 16 reviewer subagents hitting the API at once —
// report `Codex usage limit hit` and fall back to claude on an account with
// plenty of quota left, because reviewAudit skips every remaining area once one
// area reports a limit. Only a response that PROVES the window is spent may
// pause the scheduler / abort a run; everything else is waited out and retried.

/** Body signatures that mean the quota itself is exhausted (not throttling). */
const QUOTA_EXHAUSTED_SUBSTRINGS: readonly string[] = [
  'usage_limit_reached',
  'usage limit reached',
  "you've hit your usage limit",
  'hit your usage limit',
  'insufficient_quota',
  'exceeded your current quota',
  'insufficient credits',
  // Spent money, not a short window: an upstream BYOK provider relaying its own
  // empty balance through OpenRouter. Waiting cannot clear it, so it belongs here
  // (pause) rather than in the throttle path, which would burn the retry budget
  // on three escalating sleeps and then fail anyway. (AGT-4215)
  'insufficient balance',
  'requires more credits',
  'purchase more credits',
  'out of credits',
  'out_of_credits',
];

export interface LimitClassification {
  /** True only when the response proves the quota/window is spent. */
  quota: boolean;
  /** Retry-After in seconds, when the server specified one. */
  retryAfterSeconds?: number;
  /** Primary window usage from x-codex-primary-used-percent, when present. */
  usedPercent?: number;
}

/**
 * Classify a limit-shaped HTTP response as a spent quota or a transient
 * throttle. Deliberately does NOT reuse matchesRateLimitMessage: that registry
 * includes throttle phrasings ('rate_limit_exceeded', 'too many requests')
 * which are exactly what we need to tell apart here.
 *
 * Quota when the body says so (openrouter's out-of-credits 402 always says
 * "Insufficient credits" — money, not pacing, so waiting never helps) or the
 * codex window reads 100% used. The status alone is deliberately NOT enough:
 * 402 is also plain "Payment Required" for auth/billing conditions that are not
 * quota exhaustion, and pausing the scheduler on those is the mis-classification
 * rateLimitFromHttpResponse already guards against. (INT-2520)
 *
 * Header provenance: `x-codex-primary-used-percent` / `-reset-at` /
 * `-window-minutes` are the same headers rateLimitFromCodexHeaders has read
 * since INT-2192, taken from real exhausted-quota 429s (they are what produced
 * the observed "Codex 100% used of 300min window" message) — not invented here.
 * A spent window therefore reports 100; anything below it, with no quota
 * wording in the body, is throttling. Should a real exhaustion ever arrive
 * under 100 with a silent body, the caller degrades to an infra error for that
 * one call (retried later) rather than pausing on a limit that isn't there.
 */
export function classifyLimitResponse(headers: Headers | undefined, body: string): LimitClassification {
  const num = (k: string): number | undefined => {
    const v = headers?.get(k);
    const n = v == null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const usedPercent = num('x-codex-primary-used-percent');
  const retryAfterSeconds = num('retry-after');
  const lower = body.toLowerCase();
  const quota =
    QUOTA_EXHAUSTED_SUBSTRINGS.some((s) => lower.includes(s)) ||
    (usedPercent != null && usedPercent >= 100);
  return { quota, retryAfterSeconds, usedPercent };
}

/**
 * Build a RateLimitError from a codex-responses 429. The x-codex-* headers carry
 * far more than the body: primary window usage %, reset time, window length. (INT-2192)
 */
export function rateLimitFromCodexHeaders(headers: Headers, body: string): RateLimitError {
  const num = (k: string): number | undefined => {
    const v = headers.get(k);
    const n = v == null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const resetsAt = extractResetsAt(headers, body);
  const usedPercent = num('x-codex-primary-used-percent');
  const windowMinutes = num('x-codex-primary-window-minutes');

  const when = resetsAt ? new Date(resetsAt * 1000).toISOString() : 'an unknown time';
  const pct = usedPercent != null ? `${usedPercent}% used` : 'usage limit reached';
  const win = windowMinutes != null ? ` of ${windowMinutes}min window` : '';
  return new RateLimitError(resetsAt, `Codex ${pct}${win} — resets at ${when}`, usedPercent, windowMinutes);
}

/**
 * The unified HTTP-boundary detector for in-process adapters (gpt, openrouter,
 * codex-responses, local, …). Prefer this over string-scanning the error later:
 * throwing a TYPED RateLimitError at `if (!res.ok)` is the INT-2519 lesson.
 *
 * Recognises:
 *   - 429 (any provider) → rate limit
 *   - 402 (openrouter out-of-credits) → rate limit, no reset
 *   - any other status whose body carries a usage/quota signature (e.g. a 400 that
 *     wraps "insufficient_quota")
 * Returns null when the response is not a usage/rate limit. (INT-2520)
 */
export function rateLimitFromHttpResponse(
  status: number,
  headers: Headers | undefined,
  body: string,
): RateLimitError | null {
  // 429 is unambiguously a rate limit. For every OTHER status (including 402
  // "Payment Required", which some providers reuse for non-quota auth/payment
  // conditions) require the body to actually carry a usage/credit signature, so
  // we don't mis-pause on a payment/auth 402. OpenRouter's out-of-credits 402
  // always says "Insufficient credits", which matches. (INT-2520 review)
  const isRateLimit = status === 429 || matchesRateLimitMessage(body);
  if (!isRateLimit) return null;

  const resetsAt = extractResetsAt(headers, body);
  const reason =
    status === 402
      ? 'out of credits'
      : status === 429
        ? 'rate limit reached'
        : 'usage limit reached';
  const when = resetsAt ? ` — resets at ${new Date(resetsAt * 1000).toISOString()}` : '';
  return new RateLimitError(resetsAt, `HTTP ${status} ${reason}${when}`);
}

/**
 * Scan combined stdout+stderr (CLI adapters) or an error message for a usage/rate
 * limit. Returns a RateLimitError if any provider's signature is present. (INT-1906, INT-2520)
 */
export function detectRateLimit(stdout: string, stderr: string): RateLimitError | null {
  const combined = stdout + '\n' + stderr;
  if (!matchesRateLimitMessage(combined)) return null;

  const resetsAt = parseResetsAtFromBody(combined);

  const label = resetsAt
    ? `Rate limit reached (resets at ${new Date(resetsAt * 1000).toISOString()})`
    : 'Rate limit reached';

  return new RateLimitError(resetsAt, label);
}
