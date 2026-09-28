// ============================================
// OpenSwarm - Markdown → ANSI renderer (INT-1943)
// Renders assistant messages as terminal-styled markdown (bold/lists/code with
// syntax highlight) via marked + marked-terminal. Pure string → string, so it
// is unit-testable and framework-agnostic (used inside an Ink <Text>).
// ============================================

import { marked } from 'marked';
// marked-terminal has no bundled type declarations; see src/types/marked-terminal.d.ts.
import { markedTerminal } from 'marked-terminal';

let configuredWidth: number | null = null;

// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function sanitizeMarkdownInput(md: string): string {
  return md.replace(TERMINAL_ESCAPE_RE, '').replace(CONTROL_RE, '');
}

/**
 * Configure marked-terminal for `width`. reflowText re-joins a paragraph's soft
 * line breaks and wraps it — at `width` COLUMNS. Leaving the default 80 made
 * every reflowed line wider than a narrower terminal, so Ink wrapped each one
 * again (one source line → two or more physical rows) and the chat frame grew
 * past the screen. Reconfiguring only on change keeps it off the render path. (AGT-3458)
 */
function ensureConfigured(width: number): void {
  if (configuredWidth === width) return;
  // marked-terminal styles headings/lists/code; with cli-highlight present it
  // syntax-highlights fenced code blocks. reflowText wraps prose to `width`.
  marked.use(markedTerminal({ reflowText: true, tab: 2, width }));
  configuredWidth = width;
}

/**
 * Render markdown to an ANSI-styled string, reflowed to `width` columns.
 * Falls back to the raw text on error.
 */
export function renderMarkdown(md: string, width = process.stdout.columns ?? 80): string {
  if (!md) return '';
  const safeMd = sanitizeMarkdownInput(md);
  try {
    ensureConfigured(width);
    const out = marked.parse(safeMd);
    const text = typeof out === 'string' ? out : safeMd;
    return text.replace(/\s+$/, '');
  } catch {
    return safeMd;
  }
}
