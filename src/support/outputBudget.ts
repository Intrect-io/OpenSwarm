// ============================================
// OpenSwarm — Output Budget Helpers
//
// Shared destination-specific field, message, and aggregate limits.
// Every consumer enforces these before sending or rendering untrusted content.
// ============================================

// ── Discord embed limits (discord.js EmbedBuilder enforces these at build time) ──
export const DISCORD_EMBED_TITLE_LIMIT = 256;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
export const DISCORD_EMBED_FIELD_NAME_LIMIT = 256;
export const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024;
export const DISCORD_EMBED_FOOTER_LIMIT = 2048;
export const DISCORD_EMBED_AUTHOR_NAME_LIMIT = 256;
export const DISCORD_EMBED_FIELDS_PER_EMBED = 25;
/** Total characters across all text in one embed (Discord's hard 6000 cap). */
export const DISCORD_EMBED_AGGREGATE_VALUE_LIMIT = 6000;
/** Safe message content limit (below Discord's 2000 hard cap, leaving room for framing). */
export const DISCORD_MESSAGE_CONTENT_LIMIT = 1900;

// ── Linear API limits ──
export const LINEAR_TITLE_LIMIT = 512;
export const LINEAR_DESCRIPTION_LIMIT = 3000;
export const LINEAR_COMMENT_LIMIT = 3000;
/** Marker Linear bodies carry when clipped; ASCII so Linear renders it verbatim. */
export const LINEAR_TRUNCATION_SUFFIX = '\n... (truncated)';

// ── Prompt / feedback budgets ──
export const PROMPT_FEEDBACK_LIMIT = 4000;
export const PROMPT_FAILED_TESTS_LIMIT = 10;
export const PROMPT_SUGGESTIONS_LIMIT = 5;

// ── Worker audit log budgets ──
export const AUDIT_FILES_MAX = 20;
export const AUDIT_COMMANDS_MAX = 12;
export const AUDIT_SUMMARY_CAP = 600;
export const AUDIT_GOAL_CAP = 400;
/** Cap length of a single file path or command entry before rendering. */
export const AUDIT_ENTRY_CAP = 200;

// ── TUI display budgets ──
export const TUI_LOG_LINE_LIMIT = 200;
export const TUI_CELL_DEFAULT_WIDTH = 28;

// ── CLI runner budgets ──
export const CLI_FEEDBACK_LINES = 5;
export const CLI_STDERR_LINE_LIMIT = 100;

// ── Pipeline embed budgets ──
export const PIPELINE_EMBED_FIELD_VALUE_LIMIT = 900; // below 1024 to leave room for markdown framing
export const PIPELINE_FAILED_TESTS_PREVIEW = 2;

// ── Helpers ──

/** Truncate a string to `limit` chars, appending "…" when clipped. */
export function truncate(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/** Truncate a string to `limit` chars, appending a suffix when clipped. */
export function truncateWithSuffix(value: string, limit: number, suffix = '\n… (truncated)'): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  if (suffix.length >= limit) return truncate(value, limit);
  return `${value.slice(0, limit - suffix.length)}${suffix}`;
}

/** Cap an array to `max` items, returning the slice and a count of omitted items. */
export function capArray<T>(items: T[], max: number): { shown: T[]; omitted: number } {
  if (items.length <= max) return { shown: items, omitted: 0 };
  return { shown: items.slice(0, max), omitted: items.length - max };
}

/** Render a list as inline code, capped, with an "+N more" suffix when truncated. */
export function codeList(items: string[] | undefined, max: number): string {
  if (!items || items.length === 0) return '_(none)_';
  const { shown, omitted } = capArray(items, max);
  const rendered = shown.map((s) => `\`${s.replaceAll('`', '\\`')}\``).join(', ');
  return omitted > 0 ? `${rendered} _+${omitted} more_` : rendered;
}

/** Ensure a Discord embed field value stays within the per-field limit. */
export function boundedFieldValue(value: string, limit = DISCORD_EMBED_FIELD_VALUE_LIMIT): string {
  return truncateWithSuffix(value, limit);
}

/** Ensure a Discord embed description stays within the limit. */
export function boundedDescription(value: string): string {
  return truncateWithSuffix(value, DISCORD_EMBED_DESCRIPTION_LIMIT);
}

/** Ensure a Discord message content stays within the safe limit. */
export function boundedMessageContent(value: string): string {
  return truncateWithSuffix(value, DISCORD_MESSAGE_CONTENT_LIMIT);
}

/** Flatten multiline text to a single line (replace newlines with spaces). */
export function flattenToSingleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bound a string for Linear description/comment fields. */
export function boundedLinearText(value: string, limit = LINEAR_DESCRIPTION_LIMIT): string {
  return truncateWithSuffix(value, limit, LINEAR_TRUNCATION_SUFFIX);
}

/** Bound a string for Linear title. */
export function boundedLinearTitle(value: string): string {
  return truncateWithSuffix(value, LINEAR_TITLE_LIMIT);
}

/** Sanitize and bound exception text for operator-facing stderr/logs (not end-user Discord). */
export function sanitizeException(error: unknown): string {
  if (error == null) return 'An unknown error occurred.';
  const msg = error instanceof Error ? error.message : String(error);
  // Strip stack traces / multiline dumps; keep a single bounded line.
  const cleaned = msg.split('\n')[0].trim();
  return truncate(cleaned || 'An error occurred.', 200);
}

/** Generic, bounded user-visible failure — never includes raw exception content. */
export function genericUserError(_error?: unknown): string {
  return 'Something went wrong. Please try again.';
}

/**
 * Pack Discord embed fields while respecting per-field and aggregate value budgets.
 * Returns pages of fields suitable for one embed each.
 */
export function paginateEmbedFields(
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  options?: {
    fieldValueLimit?: number;
    aggregateLimit?: number;
    maxFields?: number;
  },
): Array<Array<{ name: string; value: string; inline?: boolean }>> {
  const fieldValueLimit = options?.fieldValueLimit ?? DISCORD_EMBED_FIELD_VALUE_LIMIT;
  const aggregateLimit = options?.aggregateLimit ?? DISCORD_EMBED_AGGREGATE_VALUE_LIMIT;
  const maxFields = options?.maxFields ?? DISCORD_EMBED_FIELDS_PER_EMBED;

  const pages: Array<Array<{ name: string; value: string; inline?: boolean }>> = [];
  let current: Array<{ name: string; value: string; inline?: boolean }> = [];
  let aggregate = 0;

  for (const field of fields) {
    const value = boundedFieldValue(field.value, fieldValueLimit);
    const next = { name: truncate(field.name, DISCORD_EMBED_FIELD_NAME_LIMIT), value, inline: field.inline };
    const fits =
      current.length < maxFields &&
      aggregate + value.length <= aggregateLimit;
    if (!fits && current.length > 0) {
      pages.push(current);
      current = [];
      aggregate = 0;
    }
    // A single field larger than the remaining budget still goes on its own page (already bounded).
    current.push(next);
    aggregate += value.length;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}
