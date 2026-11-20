import { describe, expect, it } from 'vitest';
import { clipBodyToRows, liveAreaRows, renderedMessageRows, selectVisibleMessages } from './ChatLog.js';
import { displayWidth, wrappedRows } from '../displayWidth.js';
import type { ChatLine } from '../chatModel.js';

// AGT-3494: the on-screen window is bounded by rendered rows, not source lines.
describe('selectVisibleMessages', () => {
  const user = (content: string): ChatLine => ({ role: 'user', content });

  it('keeps the message-count bound when no row budget is given', () => {
    const history = Array.from({ length: 10 }, (_, i) => user(`m${i}`));
    expect(selectVisibleMessages(history, 3).map((m) => m.line.content)).toEqual(['m7', 'm8', 'm9']);
  });

  it('stops before a message whose rendered rows would overflow the budget', () => {
    const tall = user(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')); // 12 rows
    const history = [tall, user('a'), user('b')]; // 3 rows each
    const picked = selectVisibleMessages(history, 40, 10);
    expect(picked.map((m) => m.line.content)).toEqual(['a', 'b']);
    expect(picked.map((m) => m.index)).toEqual([1, 2]);
  });

  it('counts rows after Markdown expansion, not source lines', () => {
    const md: ChatLine = { role: 'assistant', content: '- one\n- two\n\n```\ncode\n```' };
    const [only] = selectVisibleMessages([md], 1);
    expect(renderedMessageRows(only.body)).toBe(only.body.split('\n').length + 2);
  });

  it('always shows the newest message even when it alone exceeds the budget', () => {
    const tall = user(Array.from({ length: 50 }, () => 'x').join('\n'));
    expect(selectVisibleMessages([user('old'), tall], 40, 5)).toHaveLength(1);
  });
});

describe('liveAreaRows', () => {
  it('reserves only what the live area shows', () => {
    expect(liveAreaRows(null, 0, true)).toBe(2); // label + spinner
    expect(liveAreaRows('one line', 2, true)).toBe(1 + 2 + 1 + 1);
    expect(liveAreaRows(Array.from({ length: 30 }, () => 'x').join('\n'), 9, false)).toBe(1 + 5 + 15);
  });
});

describe('soft-wrapped row counting (80-column terminal)', () => {
  const user = (content: string): ChatLine => ({ role: 'user', content });

  it('counts a long line as the rows it wraps to at the indented width', () => {
    // 100 columns of text in a 78-column body wraps to 2 rows
    expect(renderedMessageRows('a'.repeat(100), 80)).toBe(1 + 2 + 1);
    // wide characters take two columns each: 50 Hangul = 100 columns = 2 rows
    expect(renderedMessageRows('가'.repeat(50), 80)).toBe(1 + 2 + 1);
    // a blank line still takes a row
    expect(renderedMessageRows('x\n\ny', 80)).toBe(1 + 3 + 1);
    // ANSI styling does not count
    expect(displayWidth('\x1b[1mbold\x1b[22m')).toBe(4);
    expect(displayWidth('☀✂')).toBe(4);
  });

  it('stops before long-line messages that would overflow once wrapped', () => {
    const long = user('w'.repeat(118)); // body 2 rows at 80 columns -> 4 rows
    const history = [long, long, long];
    // without columns each counts 3 rows (all fit 10); with wrap only 2 fit
    expect(selectVisibleMessages(history, 40, 10)).toHaveLength(3);
    expect(selectVisibleMessages(history, 40, 10, 80)).toHaveLength(2);
  });

  it('tail-clips an oversized newest message to the row budget with a marker', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const [only] = selectVisibleMessages([user('old'), user(lines.join('\n'))], 40, 8, 80);
    expect(renderedMessageRows(only.body, 80)).toBeLessThanOrEqual(8);
    expect(only.body.startsWith('…\n')).toBe(true);
    expect(only.body.endsWith('line 49')).toBe(true);
  });

  it('clips a single over-wide newest line by width, keeping its tail', () => {
    const [only] = selectVisibleMessages([user(`${'a'.repeat(115)}END`)], 40, 4, 40);
    expect(renderedMessageRows(only.body, 40)).toBeLessThanOrEqual(4);
    expect(only.body.endsWith('END')).toBe(true);
    expect(clipBodyToRows('x', 1)).toBe('…\nx');
  });

  it('counts the live area with soft wrap when given the activity lines and columns', () => {
    // lines are truncated to 120 chars + '...': 120 Hangul = 243 columns -> 4 rows at 78
    const streaming = '가'.repeat(150);
    expect(liveAreaRows(streaming, ['short'], true, 80)).toBe(1 + 1 + 4 + 1);
    expect(wrappedRows('z'.repeat(200), 78)).toBe(3);
  });
});

