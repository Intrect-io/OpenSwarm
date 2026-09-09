const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Strip terminal escape sequences and non-printing controls before layout/render. */
export function sanitizeTerminalText(value: string): string {
  let output = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const code = value.charCodeAt(i);
    if (char === ESC) {
      const next = value[i + 1];
      if (next === '[') {
        i += 2;
        while (i < value.length && !(value.charCodeAt(i) >= 0x40 && value.charCodeAt(i) <= 0x7e)) i += 1;
        continue;
      }
      if (next === ']') {
        i += 2;
        while (i < value.length) {
          if (value[i] === BEL) break;
          if (value[i] === ESC && value[i + 1] === '\\') {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }
    if ((code < 0x20 && char !== '\n' && char !== '\t') || (code >= 0x7f && code <= 0x9f)) continue;
    output += char;
  }
  return output;
}

export function safeIsoDate(value: string | number | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * Neutralize Discord mention syntax and strip control characters from
 * externally supplied text. Prevents @everyone, @here, <@id> mention
 * injection and non-printing control characters.
 */
export function sanitizeAndNeutralize(value: string): string {
  // Strip Discord mention markers: <@id>, <@!id>, <#id>, <@&role>, @everyone, @here
  let result = value
    .replace(/@everyone/g, '@\u200Beveryone')
    .replace(/@here/g, '@\u200Bhere')
    .replace(/<@!?(\d+)>/g, '<@\u200B$1>')
    .replace(/<#(\d+)>/g, '<#\u200B$1>')
    .replace(/<@&(\d+)>/g, '<@&\u200B$1>');
  // Strip control characters except newline and tab
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  return result;
}

/**
 * Clamp text to a maximum length with an ellipsis suffix, then sanitize.
 * Suitable for Discord embed fields derived from external input.
 */
export function clampAndSanitize(value: string, limit: number): string {
  const clamped = value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + '\u2026';
  return sanitizeAndNeutralize(clamped);
}