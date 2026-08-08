// ============================================
// OpenSwarm - Provider quota observations (INT-3402)
// ============================================
//
// The adapters have always PARSED provider usage signals (x-codex-* headers,
// retry-after) but threw them away with the RateLimitError that carried them —
// nothing could render a "58% of the 5h window" gauge. This singleton keeps
// the latest observation per provider; GET /api/quota serves it.
//
// Import-free on purpose: throttleRetry, codexResponses, and route modules all
// import this — it must never import back.

export interface QuotaObservation {
  provider: string;
  /** Percent of the primary window consumed (0-100). */
  usedPercent?: number;
  /** Primary window length in minutes. */
  windowMinutes?: number;
  /** Unix timestamp (SECONDS) when the window resets — RateLimitError's unit. */
  resetsAt?: number;
  retryAfterSeconds?: number;
  source: 'success-headers' | 'throttle' | 'quota-exhausted';
  /** Epoch ms. */
  observedAt: number;
}

const latestByProvider = new Map<string, QuotaObservation>();

export function recordQuotaObservation(
  obs: Omit<QuotaObservation, 'observedAt'> & { observedAt?: number },
): void {
  // An observation with no signal at all would only overwrite a useful one.
  if (obs.usedPercent == null && obs.resetsAt == null && obs.retryAfterSeconds == null) return;
  latestByProvider.set(obs.provider, { ...obs, observedAt: obs.observedAt ?? Date.now() });
}

export function getQuotaSnapshot(): { providers: QuotaObservation[] } {
  return { providers: [...latestByProvider.values()] };
}

export function __resetQuotaForTests(): void {
  latestByProvider.clear();
}
