// ============================================
// OpenSwarm — rate-limit backoff that ramps and gets noticed
// ============================================
//
// A `rate_limited` result without a provider reset time used to come back
// after a fixed 60 seconds, both for the issue (`retryAtFor`) and for the
// daemon-wide pause (`rateLimitUntil`), and rate-limited attempts are excluded
// from every circuit. Measured on the live ledger (round-1 redteam B-F1,
// 2026-11-03): one issue made 804 attempts in three days, 792 of them
// rate_limited, at 576 a day, and nobody was told. A quota that is gone for
// hours was being asked every minute.
//
// Now the daemon-wide pause doubles from 60 s to a one-hour cap while the
// limiting continues, a rate-limited issue waits for that pause instead of a
// flat minute, a provider's reset time still wins, and a streak that lasts past
// DEGRADED_AFTER_MS turns health to `degraded` and sends ONE notification.

/** First delay when the provider gave no reset time. */
export const RATE_LIMIT_BASE_MS = 60_000;
/** Ceiling for the ramp. */
export const RATE_LIMIT_MAX_MS = 60 * 60_000;
/** A streak this long is a quota problem, not a burst: report it. */
export const DEGRADED_AFTER_MS = 30 * 60_000;
/**
 * Quiet time after a pause expires before the next hit counts as a NEW streak.
 * Long enough that the retry right after a pause is part of the same streak.
 */
const STREAK_GAP_MS = 10 * 60_000;

/** Delay before the `hit`-th consecutive rate-limited retry (1-based). */
export function rateLimitDelayMs(hit: number): number {
  const exponent = Math.max(0, Math.min(16, Math.floor(hit) - 1));
  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** exponent);
}

/**
 * When to retry a rate-limited issue.
 *
 * Not scaled by the issue's own attempt count: that count includes ordinary
 * failures, and an issue that failed twelve times would wait an hour on its
 * first rate limit (AGT-4673 pins this). The quota is the daemon's, so the
 * ramp lives in the daemon-wide streak and the issue waits for its pause.
 */
export function rateLimitRetryAt(resetsAt: number | undefined, now: number, streak: RateLimitStreak = globalRateLimit): number {
  return resetsAt ?? Math.max(now + RATE_LIMIT_BASE_MS, streak.pausedUntil(now));
}

export interface RateLimitDegradation {
  reason: 'rate_limited';
  /** ISO time the current streak began. */
  since: string;
  /** ISO time dispatch resumes. */
  until: string;
  /** Consecutive rate-limited results in this streak. */
  hits: number;
}

/**
 * Daemon-wide rate-limit streak. One per process (`globalRateLimit`); the
 * runner asks it for the pause on every rate-limited result.
 */
export class RateLimitStreak {
  private hits = 0;
  private startedAt = 0;
  private until = 0;
  private notified = false;

  constructor(
    private readonly notify: (message: string) => Promise<void> | void = defaultNotify,
  ) {}

  /** Record a rate-limited result; returns when dispatch may resume. */
  hit(resetsAt: number | undefined, now = Date.now()): number {
    if (this.hits > 0 && now > this.until + STREAK_GAP_MS) this.reset();
    if (this.hits === 0) this.startedAt = now;
    this.hits++;
    this.until = Math.max(this.until, resetsAt ?? now + rateLimitDelayMs(this.hits));
    const degraded = this.degradation(now);
    if (degraded && !this.notified) {
      this.notified = true;
      const minutes = Math.round((now - this.startedAt) / 60_000);
      void Promise.resolve(this.notify(
        `⏸ OpenSwarm has been rate limited for ${minutes} min (${this.hits} consecutive results). `
        + `Dispatch resumes at ${degraded.until}; retries back off up to ${RATE_LIMIT_MAX_MS / 60_000} min. `
        + 'Check the provider quota or credentials.',
      )).catch((error) => console.warn('[RateLimit] Could not send the degraded notice:', error));
    }
    return this.until;
  }

  /** When the current streak's pause ends, or 0 when no streak is running. */
  pausedUntil(now = Date.now()): number {
    return this.hits > 0 && now <= this.until + STREAK_GAP_MS ? this.until : 0;
  }

  /** The current degradation, or null when no streak has lasted long enough. */
  degradation(now = Date.now()): RateLimitDegradation | null {
    if (this.hits === 0 || now > this.until + STREAK_GAP_MS) return null;
    if (now - this.startedAt < DEGRADED_AFTER_MS) return null;
    return {
      reason: 'rate_limited',
      since: new Date(this.startedAt).toISOString(),
      until: new Date(this.until).toISOString(),
      hits: this.hits,
    };
  }

  /** The provider answered: the streak, and its one notification, start over. */
  reset(): void {
    this.hits = 0;
    this.startedAt = 0;
    this.until = 0;
    this.notified = false;
  }
}

async function defaultNotify(message: string): Promise<void> {
  // Lazy: runnerExecution pulls in the whole runner, and this module is also
  // read by the health endpoint.
  const { reportToDiscord } = await import('./runnerExecution.js');
  await reportToDiscord(message);
}

export const globalRateLimit = new RateLimitStreak();
