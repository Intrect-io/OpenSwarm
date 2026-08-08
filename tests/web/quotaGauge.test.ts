// Formatting half of the status-bar quota gauge (INT-3402). Lives under
// tests/ because it imports a browser ESM asset; `tsc -p .` only covers src/.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { formatBar, formatObservation, formatQuota, formatResetIn } from '../../web/static/js/quotaGauge.mjs';

const NOW = 1_800_000_000_000; // epoch ms
const nowSeconds = NOW / 1000;

describe('quota gauge formatting', () => {
  it('renders a four-segment bar proportional to usage', () => {
    expect(formatBar(0)).toBe('░░░░');
    expect(formatBar(58)).toBe('▓▓░░');
    expect(formatBar(100)).toBe('▓▓▓▓');
    // Out-of-range input clamps instead of producing a ragged bar.
    expect(formatBar(140)).toBe('▓▓▓▓');
    expect(formatBar(-5)).toBe('░░░░');
  });

  it('formats the reset countdown by magnitude, and drops it once past', () => {
    expect(formatResetIn(nowSeconds + 30, NOW)).toBe('30s');
    expect(formatResetIn(nowSeconds + 45 * 60, NOW)).toBe('45m');
    expect(formatResetIn(nowSeconds + 3 * 3600, NOW)).toBe('3h');
    expect(formatResetIn(nowSeconds - 10, NOW)).toBe('');
    expect(formatResetIn(undefined, NOW)).toBe('');
  });

  it('shows nothing for a provider with no observed percentage — never a fake 0%', () => {
    expect(formatObservation({ provider: 'codex', retryAfterSeconds: 5 }, NOW)).toBeNull();
    expect(formatObservation({ provider: 'codex', usedPercent: 37 }, NOW)).toBe('codex ▓░░░ 37%');
  });

  it('joins providers and appends the scheduler pause when held', () => {
    const snapshot = {
      providers: [
        { provider: 'codex', usedPercent: 58, resetsAt: nowSeconds + 5 * 3600 },
        { provider: 'openrouter', retryAfterSeconds: 3 }, // no percentage → omitted
      ],
      schedulerHoldUntil: NOW + 60_000,
    };
    expect(formatQuota(snapshot, NOW)).toBe('codex ▓▓░░ 58% · 5h · ⏸ paused');
  });

  it('renders an empty string when nothing was ever observed', () => {
    expect(formatQuota({ providers: [], schedulerHoldUntil: null }, NOW)).toBe('');
    expect(formatQuota(undefined, NOW)).toBe('');
  });

  it('omits the pause marker once the hold has expired', () => {
    const snapshot = { providers: [{ provider: 'codex', usedPercent: 10 }], schedulerHoldUntil: NOW - 1 };
    expect(formatQuota(snapshot, NOW)).toBe('codex ░░░░ 10%');
  });
});
