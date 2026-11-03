// Round-1 redteam B-F1 (2026-11-03): a rate_limited result without a reset time
// came back every 60 s forever — 804 attempts on one issue in three days — and
// nothing told the operator. The delay now ramps to an hour and a sustained
// streak shows up in health and in one notification.

import { afterEach, describe, expect, it, vi } from 'vitest';

const reportToDiscord = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./runnerExecution.js', () => ({ reportToDiscord }));

import { retryAtFor } from './durableRunCoordinator.js';
import {
  DEGRADED_AFTER_MS, globalRateLimit, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS, RateLimitStreak, rateLimitDelayMs,
} from './rateLimitBackoff.js';
import { buildHealthPayload } from '../support/healthEndpoint.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const rateLimited = (rateLimitResetsAt?: number) => ({ finalStatus: 'rate_limited', rateLimitResetsAt }) as unknown as PipelineResult;
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
  globalRateLimit.reset();
  reportToDiscord.mockClear();
});

describe('rate-limit backoff', () => {
  it('ramps rate_limited retries without a reset time up to one hour', () => {
    const now = 1_000_000;
    expect(rateLimitDelayMs(1)).toBe(RATE_LIMIT_BASE_MS);
    expect(rateLimitDelayMs(1000)).toBe(RATE_LIMIT_MAX_MS);

    // Daemon-wide: consecutive hits inside one streak ramp the global pause.
    const streak = new RateLimitStreak(() => {});
    let t = now;
    const pauses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const until = streak.hit(undefined, t);
      pauses.push(until - t);
      t = until; // the next attempt runs when the pause ends, and is limited again
    }
    expect(pauses).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((m) => m * MIN));

    // Per issue: a rate-limited issue waits for the daemon-wide pause, not a flat
    // minute — and its own attempt count (ordinary failures included) plays no part.
    let at = now;
    for (let i = 0; i < 5; i++) at = globalRateLimit.hit(undefined, at); // pauses of 1, 2, 4, 8, 16 min
    const during = at - MIN;
    expect(globalRateLimit.pausedUntil(during)).toBe(at);
    expect(at - now).toBe(31 * MIN);
    expect(retryAtFor(rateLimited(), during, 1)).toBe(at);
    expect(retryAtFor(rateLimited(), during, 40)).toBe(at);

    // A quiet stretch after the pause expires starts a new streak at 60 s.
    expect(streak.hit(undefined, t + 30 * MIN) - (t + 30 * MIN)).toBe(RATE_LIMIT_BASE_MS);
  });

  it('counts same-instant hits from parallel workers as one step', () => {
    // Round-2 redteam B-F1: eight workers on one quota all get the same 429.
    const now = 2_000_000;
    const streak = new RateLimitStreak(() => {});
    let until = 0;
    for (let i = 0; i < 8; i++) until = streak.hit(undefined, now + i);
    expect(until - now).toBe(RATE_LIMIT_BASE_MS);
    // The retry after the pause is the next step, not the ninth.
    expect(streak.hit(undefined, until) - until).toBe(2 * MIN);
  });

  it('uses the provider reset time when given', () => {
    const now = 5_000_000;
    expect(retryAtFor(rateLimited(now + 7 * MIN), now, 9)).toBe(now + 7 * MIN);
    const streak = new RateLimitStreak(() => {});
    expect(streak.hit(now + 3 * MIN, now)).toBe(now + 3 * MIN);
    // An earlier reset time never shortens a pause already in force.
    expect(streak.hit(now + MIN, now + 10_000)).toBe(now + 3 * MIN);
  });

  it('reports degraded health after sustained rate limiting', async () => {
    const start = Date.UTC(2026, 10, 3, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(start);

    // Hits at 0, 1, 3, 7 and 15 min: a streak, but not yet a sustained one.
    let t = start;
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(t);
      t = globalRateLimit.hit(undefined, t);
      expect(buildHealthPayload({ credentials: {} }).degraded).toBeUndefined();
    }
    expect(reportToDiscord).not.toHaveBeenCalled();
    // The retry at 31 min is limited again: health says why and until when, and one notice goes out.
    vi.setSystemTime(t);
    const until = globalRateLimit.hit(undefined, t);
    const health = buildHealthPayload({ credentials: {} });
    expect(health.status).toBe('ok');
    expect(health.degraded).toMatchObject({ reason: 'rate_limited', since: new Date(start).toISOString(), until: new Date(until).toISOString(), hits: 6 });
    await vi.waitFor(() => expect(reportToDiscord).toHaveBeenCalledTimes(1));
    expect(String(reportToDiscord.mock.calls[0]?.[0])).toContain('rate limited for 31 min');
    t = until;

    // Further hits in the same streak do not notify again.
    globalRateLimit.hit(undefined, t);
    globalRateLimit.hit(undefined, t + MIN);
    await Promise.resolve();
    expect(reportToDiscord).toHaveBeenCalledTimes(1);

    // Long after the last pause, the streak is over and health is clean again.
    vi.setSystemTime(t + 3 * 60 * MIN);
    expect(buildHealthPayload({ credentials: {} }).degraded).toBeUndefined();
  });
});
