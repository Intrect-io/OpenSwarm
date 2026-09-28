import { describe, it, expect } from 'vitest';
import { MAX_LOG_LINE_CHARS, prepareLogLine } from './LogLine.js';

describe('prepareLogLine (AGT-3429)', () => {
  it('flattens newlines and tabs before render', () => {
    expect(prepareLogLine('a\nb\tc\r\nd')).toBe('a b c d');
  });

  it('bounds oversized lines to the documented hard cap', () => {
    const prepared = prepareLogLine('x'.repeat(MAX_LOG_LINE_CHARS + 500));
    expect(prepared.length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS);
    expect(prepared.endsWith('…')).toBe(true);
  });

  it('strips terminal escape sequences while preserving readable text', () => {
    const esc = String.fromCharCode(27);
    expect(prepareLogLine(`${esc}[31mred${esc}[0m plain`)).toBe('red plain');
  });
});
