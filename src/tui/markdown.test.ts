import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown (INT-1943)', () => {
  it('returns empty for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders prose and preserves the words', () => {
    const out = renderMarkdown('Hello **world** and `code`.');
    expect(out).toContain('Hello');
    expect(out).toContain('world');
    expect(out).toContain('code');
  });

  it('renders a list and a fenced code block without throwing', () => {
    const out = renderMarkdown('- a\n- b\n\n```ts\nconst x = 1;\n```');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('const x = 1;');
  });

  it('trims trailing whitespace', () => {
    expect(renderMarkdown('hi\n\n\n')).not.toMatch(/\s$/);
  });

  it('strips terminal control sequences from assistant-controlled markdown', () => {
    const out = renderMarkdown('\x1b]52;c;AAAA\x07Hello \x1b[31mred\x1b[0m');

    expect(out).toContain('Hello');
    expect(out).toContain('red');
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('\x1b]52');
    expect(out).not.toContain('\x1b[31m');
  });

  // reflowText re-joins a paragraph's soft breaks and wraps it, but at a
  // hard-coded 80 columns. On a narrower terminal every reflowed line was too
  // wide, so Ink wrapped it again — one source line became two or more physical
  // rows and the chat frame grew past the screen. (AGT-3458)
  it('reflows prose to the requested width, not a fixed 80 columns', () => {
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const out = strip(renderMarkdown('word '.repeat(100), 40));
    const widest = Math.max(...out.split('\n').map((l) => l.length));
    expect(widest).toBeLessThanOrEqual(40);

    const wide = strip(renderMarkdown('word '.repeat(100), 120));
    expect(Math.max(...wide.split('\n').map((l) => l.length))).toBeGreaterThan(40);
  });
});
