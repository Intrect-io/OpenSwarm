// Utilities for safely constructing Discord embeds with proper sanitization and size limits
import { EmbedBuilder } from 'discord.js';
import { sanitizeTerminalText } from '../tui/sanitize.js';
import {
  DISCORD_EMBED_AGGREGATE_VALUE_LIMIT,
  DISCORD_EMBED_AUTHOR_NAME_LIMIT,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  DISCORD_EMBED_FIELD_NAME_LIMIT,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
  DISCORD_EMBED_FIELDS_PER_EMBED,
  DISCORD_EMBED_FOOTER_LIMIT,
  DISCORD_EMBED_TITLE_LIMIT,
} from '../support/outputBudget.js';

/**
 * Per-field limits
 * (https://discord.com/developers/docs/resources/channel#embed-object-embed-limits)
 * Values come from support/outputBudget.ts so the embed layer and the
 * destination-agnostic budget helpers cannot drift apart.
 */
export const EMBED_LIMITS = {
  TITLE: DISCORD_EMBED_TITLE_LIMIT,
  DESCRIPTION: DISCORD_EMBED_DESCRIPTION_LIMIT,
  FIELD_NAME: DISCORD_EMBED_FIELD_NAME_LIMIT,
  FIELD_VALUE: DISCORD_EMBED_FIELD_VALUE_LIMIT,
  FOOTER: DISCORD_EMBED_FOOTER_LIMIT,
  AUTHOR_NAME: DISCORD_EMBED_AUTHOR_NAME_LIMIT,
  TOTAL_EMBED: DISCORD_EMBED_AGGREGATE_VALUE_LIMIT,
  MAX_FIELDS: DISCORD_EMBED_FIELDS_PER_EMBED,
} as const;

/**
 * Sanitize and truncate a string to the given limit, preserving line breaks in descriptions.
 * For non-description fields, collapses newlines to spaces.
 */
export function truncateField(value: string, limit: number, isDescription = false): string {
  if (!value) return '';
  if (limit <= 0) return '';

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
 *
 * Field values keep their line breaks: every multi-line value in this codebase
 * (issue cards, repo lists, task lists) is built with '\n' on purpose, and
 * collapsing them to spaces destroyed the layout. Names stay single-line.
 */
export function safeAddField(embed: EmbedBuilder, name: string, value: string, inline = false): EmbedBuilder {
  const truncatedName = truncateField(name, EMBED_LIMITS.FIELD_NAME);
  const truncatedValue = truncateField(value, EMBED_LIMITS.FIELD_VALUE, true);

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

/** Sum every character Discord counts against an embed's 6000-char budget. */
function embedCharCount(embed: EmbedBuilder): number {
  const data = embed.data;
  let totalChars = 0;

  if (data.title) totalChars += data.title.length;
  if (data.description) totalChars += data.description.length;
  if (data.footer?.text) totalChars += data.footer.text.length;
  if (data.author?.name) totalChars += data.author.name.length;

  for (const field of data.fields ?? []) {
    totalChars += field.name.length + field.value.length;
  }

  return totalChars;
}

/**
 * Validate that an embed does not exceed the total character budget.
 * Returns true if within limits, false otherwise.
 */
export function isEmbedWithinBudget(embed: EmbedBuilder): boolean {
  return embedCharCount(embed) <= EMBED_LIMITS.TOTAL_EMBED;
}

/**
 * Trim description until the embed fits the aggregate budget.
 */
export function enforceAggregateBudget(embed: EmbedBuilder): EmbedBuilder {
  const total = embedCharCount(embed);
  if (total <= EMBED_LIMITS.TOTAL_EMBED) return embed;

  const data = embed.data;
  if (data.description) {
    const excess = total - EMBED_LIMITS.TOTAL_EMBED;
    const keep = Math.max(0, data.description.length - excess);
    embed.setDescription(truncateField(data.description.slice(0, keep), keep, true));
  }
  return embed;
}
