import { afterEach, describe, expect, it } from 'vitest';
import { getQuotaSnapshot, recordQuotaObservation, __resetQuotaForTests } from './quotaSnapshot.js';

afterEach(() => __resetQuotaForTests());

describe('quotaSnapshot', () => {
  it('keeps the latest observation per provider', () => {
    recordQuotaObservation({ provider: 'codex', usedPercent: 30, source: 'success-headers', observedAt: 1 });
    recordQuotaObservation({ provider: 'codex', usedPercent: 55, source: 'success-headers', observedAt: 2 });
    recordQuotaObservation({ provider: 'openrouter', retryAfterSeconds: 12, source: 'throttle', observedAt: 3 });

    const { providers } = getQuotaSnapshot();
    expect(providers).toHaveLength(2);
    expect(providers.find((p) => p.provider === 'codex')?.usedPercent).toBe(55);
    expect(providers.find((p) => p.provider === 'openrouter')?.retryAfterSeconds).toBe(12);
  });

  it('ignores observations carrying no signal at all', () => {
    recordQuotaObservation({ provider: 'codex', usedPercent: 40, source: 'success-headers' });
    recordQuotaObservation({ provider: 'codex', source: 'throttle' });
    expect(getQuotaSnapshot().providers[0].usedPercent).toBe(40);
  });

  it('stamps observedAt when the caller omits it', () => {
    const before = Date.now();
    recordQuotaObservation({ provider: 'codex', usedPercent: 10, source: 'throttle' });
    expect(getQuotaSnapshot().providers[0].observedAt).toBeGreaterThanOrEqual(before);
  });
});
