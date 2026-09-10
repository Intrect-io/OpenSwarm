import { describe, expect, it } from 'vitest';
import { clampAndSanitize, safeIsoDate, sanitizeTerminalText } from './sanitize.js';

describe('terminal sanitization', () => {
  it('removes CSI, OSC, and control bytes while preserving layout whitespace', () => {
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u0000\nnext'))
      .toBe('redlink\nnext');
  });

  it('does not render invalid timestamps', () => {
    expect(safeIsoDate('not-a-date')).toBeUndefined();
    expect(safeIsoDate('2026-07-23T00:00:00Z')).toBe('2026-07-23T00:00:00.000Z');
  });

  it('clamps length and neutralizes Discord mentions after stripping escapes', () => {
    const raw = `\u001b[31m${'@everyone'} <@123> ${'x'.repeat(50)}`;
    const out = clampAndSanitize(raw, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toContain('@everyone');
    expect(out.startsWith('@\u200Beveryone')).toBe(true);
    expect(out).not.toMatch(/\u001b/);
  });
});
