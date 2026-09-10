import { describe, expect, it } from 'vitest';
import {
  safeIsoDate,
  sanitizeTerminalText,
  sanitizeAndBoundTerminalText,
  escapeHtml,
  formatMonitorError,
  MAX_RENDERED_LINE_LENGTH,
  MAX_TOTAL_RENDERED_CONTENT,
} from './sanitize.js';

describe('terminal sanitization', () => {
  it('removes CSI, OSC, and control bytes while preserving layout whitespace', () => {
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u0000\nnext'))
      .toBe('redlink\nnext');
  });

  it('strips C0 control characters except newline and tab', () => {
    expect(sanitizeTerminalText('a\x00b\x01c\x07d\ne\tf')).toBe('ab\nd\ne\tf');
  });

  it('strips C1 control characters (0x80-0x9f)', () => {
    expect(sanitizeTerminalText('a\x80b\x9fc')).toBe('abc');
  });

  it('does not render invalid timestamps', () => {
    expect(safeIsoDate('not-a-date')).toBeUndefined();
    expect(safeIsoDate('2026-07-23T00:00:00Z')).toBe('2026-07-23T00:00:00.000Z');
  });
});

describe('sanitizeAndBoundTerminalText', () => {
  it('strips control sequences and truncates long lines', () => {
    const longLine = 'x'.repeat(MAX_RENDERED_LINE_LENGTH + 50);
    const result = sanitizeAndBoundTerminalText(longLine);
    expect(result.length).toBeLessThanOrEqual(MAX_RENDERED_LINE_LENGTH);
    expect(result.endsWith('...')).toBe(true);
  });

  it('preserves short lines unchanged', () => {
    expect(sanitizeAndBoundTerminalText('hello world')).toBe('hello world');
  });

  it('strips control sequences before truncating', () => {
    const input = '\u001b[31m' + 'x'.repeat(MAX_RENDERED_LINE_LENGTH + 10) + '\u001b[0m';
    const result = sanitizeAndBoundTerminalText(input);
    expect(result.length).toBeLessThanOrEqual(MAX_RENDERED_LINE_LENGTH);
    expect(result).not.toContain('\u001b');
  });

  it('handles multi-line with mixed lengths', () => {
    const input = 'short\n' + 'a'.repeat(MAX_RENDERED_LINE_LENGTH + 20) + '\nshort again';
    const result = sanitizeAndBoundTerminalText(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe('short');
    expect(lines[1].length).toBeLessThanOrEqual(MAX_RENDERED_LINE_LENGTH);
    expect(lines[2]).toBe('short again');
  });

  it('enforces total content budget across many lines', () => {
    const lines = Array.from({ length: 80 }, () => 'y'.repeat(MAX_RENDERED_LINE_LENGTH));
    const result = sanitizeAndBoundTerminalText(lines.join('\n'));
    expect(result.length).toBeLessThanOrEqual(MAX_TOTAL_RENDERED_CONTENT);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes < > & " \'', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('escapes </div> and other closing tags', () => {
    expect(escapeHtml('</div>')).toBe('&lt;/div&gt;');
  });

  it('preserves safe text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('handles ampersands first to avoid double-encoding', () => {
    expect(escapeHtml('a&b<c')).toBe('a&amp;b&lt;c');
  });
});

describe('formatMonitorError', () => {
  it('strips control characters from fetch errors', () => {
    expect(formatMonitorError('\u001b[31mboom\u001b[0m\u0000')).toBe('boom');
  });

  it('truncates oversized monitor errors', () => {
    const oversized = 'e'.repeat(500);
    const result = formatMonitorError(oversized, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('...')).toBe(true);
  });

  it('preserves short safe errors', () => {
    expect(formatMonitorError('connection refused')).toBe('connection refused');
  });
});