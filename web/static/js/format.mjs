// Display formatting helpers for the cockpit. (INT-3402)
//
// Pure and DOM-free so they are unit-testable in Node. Every function takes
// `now` explicitly rather than reading the clock, so tests never race.

/** "just now" / "5m" / "2h" / "3d" — compact relative age for tree rows. */
export function formatRelativeTime(timestampMs, nowMs = Date.now()) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return '';
  const seconds = Math.round((nowMs - timestampMs) / 1000);
  if (seconds < 0) return 'just now'; // clock skew reads as fresh, never "-3m"
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** "8s" / "2m 05s" / "1h 12m" — elapsed/duration, distinct from age above. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  const h = Math.floor(seconds / 3600);
  return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Cost with enough precision to stay honest at both ends: sub-cent runs keep
 * their magnitude instead of rounding to "$0.00".
 */
export function formatCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** "1.2k" / "847" — token counts, compact but never misleadingly rounded to 0. */
export function formatTokens(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Shorten a filesystem path for a one-line status bar, keeping the tail (the
 * part that identifies the worktree) and marking home as `~`.
 */
export function shortenPath(path, { home = '', maxSegments = 3 } = {}) {
  if (typeof path !== 'string' || !path) return '';
  let text = path;
  if (home && (text === home || text.startsWith(`${home}/`))) {
    text = `~${text.slice(home.length)}`;
  }
  const segments = text.split('/').filter(Boolean);
  const leadingTilde = text.startsWith('~');
  if (segments.length <= maxSegments) return text;
  const tail = segments.slice(-maxSegments).join('/');
  return leadingTilde ? `~/…/${tail}` : `…/${tail}`;
}

/** Truncate to a hard cap with an ellipsis, for titles in fixed-width rows. */
export function truncate(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
