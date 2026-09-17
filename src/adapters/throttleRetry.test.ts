import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSIENT_BACKOFF_MS, isTransientRequestError, resolveLimitResponse, resolveTransientFailure } from './throttleRetry.js';
import { RateLimitError, rateLimitFromCodexHeaders } from './rateLimitError.js';
import { getQuotaSnapshot, __resetQuotaForTests } from './quotaSnapshot.js';

afterEach(() => __resetQuotaForTests());

const headers = (map: Record<string, string>) => new Headers(map);

describe('resolveLimitResponse quota observations (INT-3402)', () => {
  it('records the throttle signal before waiting out a short-window 429', async () => {
    // retry-after: 1 keeps the real (unmocked) wait at 1s instead of the 5s
    // backoff floor a zero value would fall through to.
    const result = await resolveLimitResponse(
      'openrouter',
      429,
      headers({ 'retry-after': '1' }),
      'slow down',
      { attempts: 0 },
      {},
    );
    expect(result).toBe('retry');
    const obs = getQuotaSnapshot().providers.find((p) => p.provider === 'openrouter');
    expect(obs?.source).toBe('throttle');
    expect(obs?.retryAfterSeconds).toBe(1);
  });

  it('records the exhausted quota (used%/reset) before the generic RateLimitError leaves', async () => {
    const codexHeaders = headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': '1900000000',
    });
    await expect(
      resolveLimitResponse('codex', 429, codexHeaders, 'usage limit reached', { attempts: 0 }, {}),
    ).rejects.toBeInstanceOf(RateLimitError);

    const obs = getQuotaSnapshot().providers.find((p) => p.provider === 'codex');
    expect(obs?.source).toBe('quota-exhausted');
    expect(obs?.usedPercent).toBe(100);
    expect(obs?.resetsAt).toBe(1900000000);
  });

  it('carries windowMinutes when the adapter supplies the codex quotaError', async () => {
    const codexHeaders = headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': '1900000000',
      'x-codex-primary-window-minutes': '300',
    });
    await expect(
      resolveLimitResponse('codex', 429, codexHeaders, 'usage limit reached', { attempts: 0 }, {
        quotaError: (h, b) => rateLimitFromCodexHeaders(h ?? new Headers(), b),
      }),
    ).rejects.toBeInstanceOf(RateLimitError);

    const obs = getQuotaSnapshot().providers.find((p) => p.provider === 'codex');
    expect(obs?.windowMinutes).toBe(300);
    expect(obs?.usedPercent).toBe(100);
  });

  it('records nothing for a non-limit response', async () => {
    const result = await resolveLimitResponse('gpt', 500, undefined, 'boom', { attempts: 0 }, {});
    expect(result).toBe('other');
    expect(getQuotaSnapshot().providers).toHaveLength(0);
  });
});

describe('resolveTransientFailure (AGT-4385)', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a 503 after a backoff and counts the attempt', async () => {
    quiet();
    vi.useFakeTimers();
    const state = { attempts: 0 };
    const lines: string[] = [];
    const pending = resolveTransientFailure('openrouter', { status: 503 }, state, { onLog: (l) => lines.push(l) });
    await vi.runAllTimersAsync();
    expect(await pending).toBe('retry');
    expect(state.transientAttempts).toBe(1);
    expect(lines[0]).toMatch(/openrouter transient failure \(HTTP 503\) — waiting \ds, retry 1\/5/);
  });

  it('treats every 5xx and 529 as transient, and no 4xx', async () => {
    quiet();
    vi.useFakeTimers();
    for (const status of [500, 502, 503, 504, 529]) {
      const pending = resolveTransientFailure('p', { status }, { attempts: 0 });
      await vi.runAllTimersAsync();
      expect(await pending, `status ${status}`).toBe('retry');
    }
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(await resolveTransientFailure('p', { status }, { attempts: 0 }), `status ${status}`).toBe('other');
    }
  });

  it('retries undici transport errors by cause code, not by message', async () => {
    quiet();
    vi.useFakeTimers();
    const errors = [
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ];
    for (const error of errors) {
      const pending = resolveTransientFailure('p', { error }, { attempts: 0 });
      await vi.runAllTimersAsync();
      expect(await pending).toBe('retry');
    }
    expect(isTransientRequestError(new Error('fetch failed'))).toBe(false); // no cause → unknown, not retried
    expect(isTransientRequestError(new Error('Model "x" not found'))).toBe(false);
  });

  it('never retries a caller abort or a deadline timeout', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(await resolveTransientFailure('p', { error: abort }, { attempts: 0 })).toBe('other');
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(await resolveTransientFailure('p', { error: timeout }, { attempts: 0 })).toBe('other');
    const controller = new AbortController();
    controller.abort();
    expect(await resolveTransientFailure('p', { status: 503 }, { attempts: 0 }, { signal: controller.signal })).toBe('other');
  });

  it('gives up after the fifth retry so the original error path reports it', async () => {
    quiet();
    vi.useFakeTimers();
    const state = { attempts: 0 };
    for (let i = 0; i < TRANSIENT_BACKOFF_MS.length; i++) {
      const pending = resolveTransientFailure('p', { status: 502 }, state);
      await vi.runAllTimersAsync();
      expect(await pending).toBe('retry');
    }
    expect(state.transientAttempts).toBe(5);
    expect(await resolveTransientFailure('p', { status: 502 }, state)).toBe('other');
  });

  it('keeps the transient budget separate from the throttle budget', async () => {
    quiet();
    vi.useFakeTimers();
    const state = { attempts: 2 }; // two throttle waits already spent
    const pending = resolveTransientFailure('p', { status: 503 }, state);
    await vi.runAllTimersAsync();
    expect(await pending).toBe('retry');
    expect(state.attempts).toBe(2);
    expect(state.transientAttempts).toBe(1);
  });
});
