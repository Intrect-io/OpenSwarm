import { afterEach, describe, expect, it } from 'vitest';
import { resolveLimitResponse } from './throttleRetry.js';
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
