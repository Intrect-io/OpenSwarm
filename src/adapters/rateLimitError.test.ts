import { describe, it, expect } from 'vitest';
import { classifyLimitResponse, detectRateLimit, parseRetryAfterSeconds, rateLimitFromCodexHeaders, rateLimitFromHttpResponse, matchesRateLimitMessage, RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, throttleWaitMs } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { runAgenticLoop } from './agenticLoop.js';

// Every provider's REAL usage/rate-limit wire string must be recognised (audit
// INT-2520). Grounded in actual observed output, not invented. A missed limit
// becomes a false STUCK (in-process) or loses the scheduler pause (CLI).
describe('per-provider usage-limit recognition (INT-2520 audit)', () => {
  const REAL_LIMIT_OUTPUTS: Array<[string, string]> = [
    ['codex CLI', `{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:20 PM."}`],
    ['claude CLI (human phrase)', 'claude CLI failed with code 1: Limit reached · resets 8pm (Asia/Seoul) · add funds to continue with extra usage'],
    ['claude rate_limit_event', '{"type":"rate_limit_event","rate_limit_info":{"overageStatus":"rejected","overageDisabledReason":"out_of_credits"}}'],
    ['codex-responses header phrase', 'API error: Codex 100% used of 300min window — resets at 2026-06-30T12:00:00Z'],
    ['OpenAI 429 rate_limit_exceeded', '{"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded for key"}}'],
    ['OpenAI 429 insufficient_quota', '{"error":{"code":"insufficient_quota","message":"You have exceeded your quota"}}'],
    ['OpenRouter 429', 'Rate limit exceeded: 1000 requests per 1 day'],
    ['OpenRouter 402', '{"error":{"code":402,"message":"Insufficient credits"}}'],
    ['local 429', '{"error":"Too Many Requests: server is overloaded"}'],
    ['local overloaded', '{"error":"server is overloaded"}'],
  ];

  it.each(REAL_LIMIT_OUTPUTS)('recognises %s', (_, body) => {
    expect(matchesRateLimitMessage(body)).toBe(true);
    expect(detectRateLimit('', body)).toBeInstanceOf(RateLimitError);
  });

  // False-positive guard: common non-limit strings must NOT match.
  const SAFE_OUTPUTS: Array<[string, string]> = [
    ['normal codex response', '{"type":"success","result":"ok"}'],
    ['normal claude response', '{"type":"content_block_delta","delta":{"text":"hello"}}'],
    ['normal OpenAI response', '{"choices":[{"message":{"content":"ok"}}]}'],
    ['normal OpenRouter response', '{"choices":[{"message":{"content":"ok"}}]}'],
    ['normal local response', '{"response":"ok"}'],
    ['error unrelated to limits', '{"error":"Internal server error"}'],
    ['throttle budget exhausted (infra, not limit)', 'throttle-retry: codex still limited (HTTP 429, window 42% used) after 3 retries'],
  ];

  it.each(SAFE_OUTPUTS)('does NOT recognise %s', (_, body) => {
    expect(matchesRateLimitMessage(body)).toBe(false);
    expect(detectRateLimit('', body)).toBeNull();
  });
});

describe('classifyLimitResponse (INT-2520)', () => {
  it('classifies a 429 with quota-exhausted body as quota=true', () => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '100' });
    const body = '{"error":{"code":"insufficient_quota"}}';
    const result = classifyLimitResponse(headers, body);
    expect(result.quota).toBe(true);
    expect(result.usedPercent).toBe(100);
  });

  it('classifies a 429 without quota-exhausted body as quota=false', () => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '55' });
    const body = '{"error":"Too Many Requests"}';
    const result = classifyLimitResponse(headers, body);
    expect(result.quota).toBe(false);
    expect(result.usedPercent).toBe(55);
  });

  it('extracts retryAfterSeconds from Retry-After delta-seconds header', () => {
    const headers = new Headers({ 'retry-after': '120' });
    const result = classifyLimitResponse(headers, '{}');
    expect(result.retryAfterSeconds).toBe(120);
  });

  it('extracts retryAfterSeconds from x-codex-primary-reset-at', () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = new Headers({ 'x-codex-primary-reset-at': String(now + 300) });
    const result = classifyLimitResponse(headers, '{}');
    expect(result.retryAfterSeconds).toBe(300);
  });

  it('returns retryAfterSeconds=0 when no timing header is present', () => {
    const result = classifyLimitResponse(new Headers(), '{}');
    expect(result.retryAfterSeconds).toBe(0);
  });
});

describe('rateLimitFromCodexHeaders', () => {
  it('builds a RateLimitError from codex response headers', () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': String(now + 600),
    });
    const err = rateLimitFromCodexHeaders(headers, 'API error: Codex 100% used of 300min window');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetsAt).toBe(now + 600);
  });
});

describe('rateLimitFromHttpResponse', () => {
  it('builds a RateLimitError from an HTTP response', () => {
    const headers = new Headers({ 'retry-after': '60' });
    const err = rateLimitFromHttpResponse(429, headers, '{"error":"rate limit"}');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns null for non-429 status', () => {
    expect(rateLimitFromHttpResponse(200, new Headers(), 'ok')).toBeNull();
  });
});

describe('detectRateLimit', () => {
  it('returns null for clean output', () => {
    expect(detectRateLimit('stdout ok', 'stderr ok')).toBeNull();
  });

  it('detects a limit in stderr', () => {
    const err = detectRateLimit('', 'Rate limit exceeded');
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('detects a limit in stdout', () => {
    const err = detectRateLimit('Rate limit exceeded', '');
    expect(err).toBeInstanceOf(RateLimitError);
  });
});

describe('resolveLimitResponse integration (INT-2520)', () => {
  // Each provider's real HTTP response shape must be classified correctly.
  // A false quota=true on a transient 429 would abort the run; a false quota=false
  // on a real exhausted account would burn retries and then fail anyway.
  const state = () => ({ attempt: 0, maxAttempts: 3 });

  it('resolves a codex 429 with 100% usage as a RateLimitError', async () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': String(now + 300),
    });
    await expect(
      resolveLimitResponse('codex-responses', 429, headers, 'API error: Codex 100% used of 300min window', state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('resolves a codex 429 with partial usage as a retryable pause', async () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      'x-codex-primary-used-percent': '55',
      'x-codex-primary-reset-at': String(now + 120),
    });
    const result = await resolveLimitResponse('codex-responses', 429, headers, 'API error: Codex 55% used of 300min window', state());
    expect(result).toBe('retry');
  });

  it('resolves an OpenAI 429 with insufficient_quota as a RateLimitError', async () => {
    await expect(
      resolveLimitResponse('gpt', 429, new Headers(), '{"error":{"code":"insufficient_quota"}}', state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('resolves an OpenAI 429 with rate_limit_exceeded as a retryable pause', async () => {
    const result = await resolveLimitResponse('gpt', 429, new Headers(), '{"error":{"code":"rate_limit_exceeded"}}', state());
    expect(result).toBe('retry');
  });

  it('resolves an OpenRouter 402 as a RateLimitError', async () => {
    await expect(
      resolveLimitResponse('openrouter', 402, new Headers(), '{"error":{"code":402,"message":"Insufficient credits"}}', state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('resolves a local 429 as a retryable pause', async () => {
    const result = await resolveLimitResponse('local', 429, new Headers(), '{"error":"Too Many Requests"}', state());
    expect(result).toBe('retry');
  });

  // AGT-4215: OpenRouter relays upstream BYOK provider balance errors as 402
  // with "insufficient balance" in the raw metadata. Before AGT-4215 the agentic
  // loop swallowed it into a normal result — the operator was told the
  // reviewer produced "no parseable verdict" when the account simply needed topping up.
  it('pauses on a 402 relaying an upstream provider\'s "insufficient balance"', async () => {
    const body = '{"error":{"message":"Provider returned error","code":402,"metadata":'
      + '{"raw":"{\\"code\\":402,\\"msg\\":\\"insufficient balance\\"}","provider_name":"AtlasCloud","is_byok":true}}}';
    await expect(
      resolveLimitResponse('openrouter', 402, new Headers(), body, state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('Retry-After HTTP-date parsing (AGT-3442)', () => {
  it('parses delta-seconds and HTTP-date Retry-After values', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds(' 45 ')).toBe(45);
    // Prefix digits must not silently win over a malformed token.
    expect(parseRetryAfterSeconds('60xyz')).toBeUndefined();
    expect(parseRetryAfterSeconds('not-a-date')).toBeUndefined();

    const future = new Date(Date.now() + 180_000);
    const before = Math.floor(Date.now() / 1000);
    const seconds = parseRetryAfterSeconds(future.toUTCString());
    const after = Math.floor(Date.now() / 1000);
    expect(seconds).toBeDefined();
    const expected = Math.floor(future.getTime() / 1000);
    expect(seconds!).toBeGreaterThanOrEqual(expected - after);
    expect(seconds!).toBeLessThanOrEqual(expected - before);
  });

  it('exposes HTTP-date Retry-After as seconds-from-now via classifyLimitResponse', () => {
    // Use a relative future date so the assertion does not rot when wall-clock moves.
    const future = new Date(Date.now() + 120_000);
    const headers = new Headers({ 'retry-after': future.toUTCString() });
    const before = Math.floor(Date.now() / 1000);
    const result = classifyLimitResponse(headers, '{}');
    const after = Math.floor(Date.now() / 1000);
    expect(result.quota).toBe(false); // no quota-exhausted body signature
    const expected = Math.floor(future.getTime() / 1000);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    // Allow ±1s for the wall-clock tick between before/after and the parse.
    expect(result.retryAfterSeconds!).toBeGreaterThanOrEqual(expected - after);
    expect(result.retryAfterSeconds!).toBeLessThanOrEqual(expected - before);
  });

  it('sets RateLimitError.resetsAt from an HTTP-date Retry-After on a 429', () => {
    const future = new Date(Date.now() + 300_000);
    const headers = new Headers({ 'retry-after': future.toUTCString() });
    const err = rateLimitFromHttpResponse(429, headers, '{"error":"rate limit"}');
    expect(err).toBeInstanceOf(RateLimitError);
    const expected = Math.floor(future.getTime() / 1000);
    // ±1s: parseRetryAfterSeconds and extractResetsAt each sample Date.now().
    expect(err!.resetsAt).toBeGreaterThanOrEqual(expected - 1);
    expect(err!.resetsAt).toBeLessThanOrEqual(expected + 1);
  });
});

describe('throttle backoff + downstream classification (INT-2907)', () => {
  it('honors Retry-After, caps it, and otherwise escalates the backoff', () => {
    // Backoff carries up to 1s of jitter so concurrent subagents don't retry in lockstep.
    for (const [attempt, base] of [[0, 5_000], [1, 15_000], [2, 40_000]] as const) {
      const wait = throttleWaitMs(attempt);
      expect(wait).toBeGreaterThanOrEqual(base);
      expect(wait).toBeLessThan(base + 1_000);
    }
    expect(throttleWaitMs(0, 7)).toBe(7_000); // Retry-After honored verbatim (no jitter)
    expect(throttleWaitMs(0, 9_999)).toBe(120_000); // capped
    expect(throttleWaitMs(0, 0)).toBeGreaterThanOrEqual(5_000); // bogus Retry-After → backoff
  });

  it('classifies an exhausted throttle budget as infra, never as a rate limit', () => {
    // Wording matters: if this message tripped detectRateLimit it would be
    // re-promoted downstream and abort the whole review --max run again.
    const msg = 'throttle-retry: codex still limited (HTTP 429, window 42% used) after 3 retries';
    expect(matchesRateLimitMessage(msg)).toBe(false);
    expect(detectRateLimit('', msg)).toBeNull();
    expect(isInfraError(new Error(msg))).toBe(true);
  });
});