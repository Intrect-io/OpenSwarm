// Cockpit display formatting (INT-3402).

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import {
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokens,
  shortenPath,
  truncate,
} from '../../web/static/js/format.mjs';

const NOW = 1_800_000_000_000;

describe('formatRelativeTime', () => {
  it('scales by magnitude and never renders a negative age', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d');
    // Clock skew (daemon slightly ahead) must not read as "-1m".
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('just now');
    expect(formatRelativeTime(undefined, NOW)).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes with padded seconds, and hours', () => {
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('formatCost', () => {
  it('keeps sub-cent magnitudes instead of rounding them to $0.00', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(-1)).toBe('');
  });
});

describe('formatTokens', () => {
  it('compacts thousands and millions', () => {
    expect(formatTokens(847)).toBe('847');
    expect(formatTokens(1_240)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatTokens(undefined)).toBe('');
  });
});

describe('shortenPath', () => {
  it('marks home and keeps the identifying tail', () => {
    expect(shortenPath('/Users/me/dev/repo', { home: '/Users/me' })).toBe('~/dev/repo');
    expect(shortenPath('/Users/me/dev/repo/worktree/abc', { home: '/Users/me' })).toBe('~/…/repo/worktree/abc');
    expect(shortenPath('/a/b', { home: '/Users/me' })).toBe('/a/b');
    expect(shortenPath('/very/deep/nested/path/here')).toBe('…/nested/path/here');
    expect(shortenPath('')).toBe('');
  });
});

describe('truncate', () => {
  it('cuts with an ellipsis only when over the cap', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a much longer title', 8)).toBe('a much …');
    expect(truncate('x', 0)).toBe('x');
  });
});
