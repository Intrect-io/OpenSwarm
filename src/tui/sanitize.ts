const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Maximum rendered line length for terminal/TUI output. */
export const MAX_RENDERED_LINE_LENGTH = 500;

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

/**
 * Sanitize and bound each rendered line to MAX_RENDERED_LINE_LENGTH.
 * Strips control sequences first, then truncates each line.
 */
export function sanitizeAndBoundTerminalText(value: string): string {
  const clean = sanitizeTerminalText(value);
  return clean
    .split('\n')
    .map(line => line.length > MAX_RENDERED_LINE_LENGTH ? line.substring(0, MAX_RENDERED_LINE_LENGTH - 3) + '...' : line)
    .join('\n');
}

/** HTML-escape a string for safe interpolation into HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeIsoDate(value: string | number | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}