// ============================================
// OpenSwarm - Terminal display width helpers
// One measure for every TUI layout budget (chat log rows, input clipping).
// Built on string-width (already shipped as an Ink dependency) with two
// conservative adjustments: Misc Symbols / Dingbats (U+2600–U+27BF) count as
// two columns, since many terminals draw them wide, and a tab counts as one.
// Over-counting is the safe direction for both callers: a clipped row or one
// spare row, never an overflowing frame.
// ============================================

import stringWidth from 'string-width';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const PLAIN_ASCII_RE = /^[\x20-\x7e]*$/;

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** Split into user-perceived characters (falls back to code points). */
export function graphemes(text: string): string[] {
  if (!GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (s) => s.segment);
}

/** Remove terminal escape sequences (Markdown output carries SGR styling). */
export function stripAnsi(text: string): string {
  return text.includes('\x1b') ? text.replace(ANSI_RE, '') : text;
}

/** Columns one grapheme takes. */
export function graphemeWidth(g: string): number {
  if (g === '\t') return 1;
  const cp = g.codePointAt(0) ?? 0;
  const w = stringWidth(g);
  if (cp >= 0x2600 && cp <= 0x27bf) return Math.max(2, w);
  return w;
}

/** Columns `text` takes on one terminal row. ANSI sequences count as zero. */
export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  if (PLAIN_ASCII_RE.test(plain)) return plain.length;
  let width = 0;
  for (const g of graphemes(plain)) width += graphemeWidth(g);
  return width;
}

/**
 * Rows `text` takes when soft-wrapped at `columns`: each line is at least one
 * row (a blank line still takes a row). Ink wraps on word boundaries, which can
 * occasionally need one row more than this character-wrap count.
 */
export function wrappedRows(text: string, columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  let rows = 0;
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(displayWidth(line) / width));
  return rows;
}

/** The longest tail of `text` (ANSI stripped) that fits `maxColumns`. Never splits a grapheme. */
export function tailToWidth(text: string, maxColumns: number): string {
  const parts = graphemes(stripAnsi(text));
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = graphemeWidth(parts[i]);
    if (used + w > maxColumns) break;
    kept.push(parts[i]);
    used += w;
  }
  return kept.reverse().join('');
}
