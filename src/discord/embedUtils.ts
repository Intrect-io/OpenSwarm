// Utilities for safely constructing Discord embeds with proper sanitization and size limits
import { EmbedBuilder } from 'discord.js';
import { sanitizeTerminalText } from '../tui/sanitize.js';

// Per-field limits (https://discord.com/developers/docs/resources/channel#embed-object-embed-limits)
export const EMBED_LIMITS = {
  TITLE: 256,
  DESCRIPTION: 4096,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  FOOTER: 2048,
  AUTHOR_NAME: 256,
  TOTAL_EMBED: 6000, // Combined text across all fields per embed
  MAX_FIELDS: 25,
} as const;

/**
 * Sanitize and truncate a string to the given limit, preserving line breaks in descriptions.
 * For non-description fields, collapses newlines to spaces.
 */
export function truncateField(value: string, limit: number, isDescription = false): string {
  if (!value) return '';

  // First sanitize control characters
  const sanitized = sanitizeTerminalText(value);

  // Normalize line endings
  const normalized = isDescription ? sanitized : sanitized.replace(/\r\n|\n|\r/g, ' ');

  // Truncate (reserve room for marker)
  if (normalized.length <= limit) return normalized.trim();
  const marker = '\n[truncated]';
  const cut = Math.max(0, limit - marker.length);
  return normalized.slice(0, cut).trimEnd() + marker;
}

export function truncateFieldValue(value: string, max = EMBED_LIMITS.FIELD_VALUE): string {
  return truncateField(value, max);
}

export function truncateFieldName(name: string): string {
  return truncateField(name, EMBED_LIMITS.FIELD_NAME);
}

/**
 * Safely add a field to an embed with name and value limits.
 */
export function safeAddField(embed: EmbedBuilder, name: string, value: string, inline = false): EmbedBuilder {
  const truncatedName = truncateField(name, EMBED_LIMITS.FIELD_NAME);
  const truncatedValue = truncateField(value, EMBED_LIMITS.FIELD_VALUE);

  // Only add field if name is not empty after truncation
  if (truncatedName) {
    const fields = embed.data.fields?.length ?? 0;
    if (fields >= EMBED_LIMITS.MAX_FIELDS) return embed;
    embed.addFields({ name: truncatedName, value: truncatedValue || '\u200b', inline });
  }

  return embed;
}

/**
 * Set the description with proper truncation.
 */
export function safeSetDescription(embed: EmbedBuilder, description: string): EmbedBuilder {
  if (description) {
    const truncated = truncateField(description, EMBED_LIMITS.DESCRIPTION, true);
    embed.setDescription(truncated);
  }
  return embed;
}

/**
 * Set the footer text with truncation.
 */
export function safeSetFooter(embed: EmbedBuilder, footer: string): EmbedBuilder {
  if (footer) {
    const truncated = truncateField(footer, EMBED_LIMITS.FOOTER);
    embed.setFooter({ text: truncated });
  }
  return embed;
}

/**
 * Set the title with truncation.
 */
export function safeSetTitle(embed: EmbedBuilder, title: string): EmbedBuilder {
  if (title) {
    const truncated = truncateField(title, EMBED_LIMITS.TITLE);
    embed.setTitle(truncated);
  }
  return embed;
}

/**
 * Validate that an embed does not exceed the total character budget.
 * Returns true if within limits, false otherwise.
 */
export function isEmbedWithinBudget(embed: EmbedBuilder): boolean {
  const data = embed.data;
  let totalChars = 0;

  if (data.title) totalChars += data.title.length;
  if (data.description) totalChars += data.description.length;
  if (data.footer?.text) totalChars += data.footer.text.length;
  if (data.author?.name) totalChars += data.author.name.length;

  if (data.fields) {
    for (const field of data.fields) {
      totalChars += field.name.length + field.value.length;
    }
  }

  return totalChars <= EMBED_LIMITS.TOTAL_EMBED;
}

/**
 * Trim description until the embed fits the aggregate budget.
 */
export function enforceAggregateBudget(embed: EmbedBuilder): EmbedBuilder {
  if (isEmbedWithinBudget(embed)) return embed;
  const data = embed.data;
  let total =
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text?.length ?? 0) +
    (data.author?.name?.length ?? 0) +
    (data.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

  if (data.description && total > EMBED_LIMITS.TOTAL_EMBED) {
    const excess = total - EMBED_LIMITS.TOTAL_EMBED;
    const keep = Math.max(0, data.description.length - excess);
    embed.setDescription(truncateField(data.description.slice(0, keep), keep, true));
  }
  return embed;
}
