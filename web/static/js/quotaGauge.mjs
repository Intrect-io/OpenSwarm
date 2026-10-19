// Provider rate-limit gauge for the status bar. (INT-3402)
//
// Renders what the daemon actually observed from provider usage headers — no
// estimate, no placeholder. Nothing observed yet (fresh daemon, or a provider
// that sends no usage headers) renders nothing at all rather than a fake 0%.
//
// DOM-free formatting so it is unit-testable; the caller owns the element.


/** "3h" / "45m" / "30s" until an epoch-SECONDS reset, or '' when unknown/past. */
export function formatResetIn(resetsAtSeconds, nowMs) {
  if (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds)) return '';
  const seconds = Math.round(resetsAtSeconds - nowMs / 1000);
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * One provider observation → display text, or null when there is nothing
 * honest to show (no usage percentage was ever observed for it).
 */
export function formatObservation(observation, nowMs = Date.now()) {
  if (typeof observation?.usedPercent !== 'number' || !Number.isFinite(observation.usedPercent)) {
    return null;
  }
  const resetIn = formatResetIn(observation.resetsAt, nowMs);
  const percent = `${Math.round(observation.usedPercent)}%`;
  // The percentage alone: the old ▓░ block bar drew in the OS fallback font
  // and said nothing the number did not (step 10).
  return `${observation.provider} ${percent}${resetIn ? ` · ${resetIn}` : ''}`;
}

export function formatQuota(snapshot, nowMs = Date.now()) {
  const parts = (snapshot?.providers ?? [])
    .map((observation) => formatObservation(observation, nowMs))
    .filter(Boolean);
  const held = typeof snapshot?.schedulerHoldUntil === 'number' && snapshot.schedulerHoldUntil > nowMs;
  if (held) parts.push('paused');
  return parts.join(' · ');
}

export class QuotaGauge {
  #el;
  #fetchQuota;

  constructor(el, { fetchQuota }) {
    this.#el = el;
    this.#fetchQuota = fetchQuota;
  }

  async refresh() {
    let text = '';
    try {
      text = formatQuota(await this.#fetchQuota());
    } catch {
      // A daemon without the endpoint (older build) simply shows no gauge.
      text = '';
    }
    this.#el.textContent = text;
    this.#el.hidden = !text;
  }

  /** Poll; usage windows move in hours, so a slow cadence is plenty. */
  start(intervalMs = 60_000) {
    void this.refresh();
    return setInterval(() => void this.refresh(), intervalMs);
  }
}
