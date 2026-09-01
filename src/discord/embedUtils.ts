/**
 * Utility functions for safely creating Discord embeds with proper size limits.
 * Discord embed limits: 6000 chars total, 1024 chars per field value, 256 per field name, 25 fields max.
 */

const EMBED_TOTAL_LIMIT = 6000;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_MAX_FIELDS = 25;

function truncate(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  return s.slice(0, max - suffix.length) + suffix;
}

/**
 * Enforce all Discord embed limits on a builder-style embed object.
 * Mutates the embed in place and returns it for chaining.
 */
export function enforceEmbedLimits(embed: { setTitle?: (t: string) => any; setDescription?: (d: string) => any; addFields?: (...fields: any[]) => any; data?: { title?: string; description?: string; fields?: { name: string; value: string }[] } }, title: string, description: string, fields: { name: string; value: string }[]): void {
  const safeTitle = truncate(title, 256);
  const safeDescription = truncate(description, 4096);
  const safeFields = fields.slice(0, EMBED_MAX_FIELDS).map(f => ({
    name: truncate(f.name, EMBED_FIELD_NAME_LIMIT),
    value: truncate(f.value, EMBED_FIELD_VALUE_LIMIT),
  }));

  // Calculate total and trim description if needed
  const fieldTotal = safeFields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  const total = safeTitle.length + safeDescription.length + fieldTotal;
  if (total > EMBED_TOTAL_LIMIT) {
    const excess = total - EMBED_TOTAL_LIMIT;
    const trimmedDesc = safeDescription.length > excess
      ? truncate(safeDescription, safeDescription.length - excess)
      : '';
    embed.setTitle(safeTitle);
    embed.setDescription(trimmedDesc);
  } else {
    embed.setTitle(safeTitle);
    embed.setDescription(safeDescription);
  }
  embed.addFields(...safeFields);
}

/**
 * Truncate a single field value to Discord's per-field limit (1024 chars).
 */
export function truncateFieldValue(value: string, max = EMBED_FIELD_VALUE_LIMIT): string {
  return truncate(value, max);
}

/**
 * Truncate a single field name to Discord's per-field name limit (256 chars).
 */
export function truncateFieldName(name: string): string {
  return truncate(name, EMBED_FIELD_NAME_LIMIT);
}