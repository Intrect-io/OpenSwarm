import { describe, expect, it } from 'vitest';
import { liveAreaRows, renderedMessageRows, selectVisibleMessages } from './ChatLog.js';
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
