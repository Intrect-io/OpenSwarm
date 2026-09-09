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
export const DISCORD_EMBED_FIELDS_PER_EMBED = 25;
/** Total characters across all field values in one embed (discord.js enforces ~6000). */
export const DISCORD_EMBED_AGGREGATE_VALUE_LIMIT = 6000;
/** Safe message content limit (below Discord's 2000 hard cap, leaving room for framing). */
export const DISCORD_MESSAGE_CONTENT_LIMIT = 1900;

// ── Linear API limits ──
export const LINEAR_TITLE_LIMIT = 512;
export const LINEAR_DESCRIPTION_LIMIT = 3000;
export const LINEAR_COMMENT_LIMIT = 3000;

// ── Prompt / feedback budgets ──
export const PROMPT_FEEDBACK_LIMIT = 4000;
export const PROMPT_FAILED_TESTS_LIMIT = 10;
export const PROMPT_SUGGESTIONS_LIMIT = 5;

// ── Worker audit log budgets ──
export const AUDIT_FILES_MAX = 20;
export const AUDIT_COMMANDS_MAX = 12;
export const AUDIT_SUMMARY_CAP = 600;
export const AUDIT_GOAL_CAP = 400;

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
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/** Truncate a string to `limit` chars, appending a suffix when clipped. */
export function truncateWithSuffix(value: string, limit: number, suffix = '\n… (truncated)'): string {
  if (value.length <= limit) return value;
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
  return truncateWithSuffix(value, limit);
}

/** Bound a string for Linear title. */
export function boundedLinearTitle(value: string): string {
  return truncateWithSuffix(value, LINEAR_TITLE_LIMIT);
}

/** Sanitize and bound exception text for user-facing output. */
export function sanitizeException(error: unknown): string {
  if (error == null) return 'An unknown error occurred.';
  const msg = error instanceof Error ? error.message : String(error);
  // Strip any content that looks like a stack trace or internal path
  const cleaned = msg.split('\n')[0].trim();
  return truncate(cleaned || 'An error occurred.', 200);
}