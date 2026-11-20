import { describe, it, expect } from 'vitest';
import { deleteLastGrapheme, clipChatInputDisplay, CHAT_INPUT_DISPLAY_OVERHEAD, toSingleLineChatInput } from './ChatInput.js';

describe('ChatInput deleteLastGrapheme', () => {
  it('deletes an emoji as one grapheme', () => {
    expect(deleteLastGrapheme('ok😀')).toBe('ok');
  });

  it('deletes a base character plus combining mark as one grapheme', () => {
    expect(deleteLastGrapheme('Cafe\u0301')).toBe('Caf');
  });
});

describe('clipChatInputDisplay', () => {
  it('keeps the tail that fits the terminal and leaves the source value whole', () => {
    const columns = 40;
    const budget = columns - CHAT_INPUT_DISPLAY_OVERHEAD;
    const full = `${'a'.repeat(50)}END`;
    const clipped = clipChatInputDisplay(full, columns);
    expect(Array.from(clipped)).toHaveLength(budget);
    expect(clipped.startsWith('…')).toBe(true);
    expect(clipped.endsWith('END')).toBe(true);
    expect(full).toBe(`${'a'.repeat(50)}END`);
  });

  it('counts Hangul as two columns', () => {
    const columns = 20; // budget 13
    const clipped = clipChatInputDisplay('가나다라마바사아자차', columns);
    // ellipsis (1) + 6 wide chars (12) = 13
    expect(clipped).toBe('…마바사아자차');
  });

  it('returns the full value when it fits', () => {
    expect(clipChatInputDisplay('short', 80)).toBe('short');
    expect(clipChatInputDisplay('', 5)).toBe('');
  });
});

describe('clipChatInputDisplay measures what it renders', () => {
  it('sanitises before clipping, so escape sequences neither count nor survive', () => {
    const esc = '\x1b[31m'.repeat(20);
    // 12 visible chars fit a 40-column budget; the escapes must not force a clip
    expect(clipChatInputDisplay(`${esc}hello world!`, 40)).toBe('hello world!');
  });

  it('counts U+2600–U+27BF symbols and emoji as two columns', () => {
    const columns = 20; // budget 13: ellipsis + 6 two-column symbols
    expect(clipChatInputDisplay('☀☀☀☀☀☀☀☀☀☀', columns)).toBe('…☀☀☀☀☀☀');
    expect(clipChatInputDisplay('😀😀😀😀😀😀😀😀😀😀', columns)).toBe('…😀😀😀😀😀😀');
  });

  it('never cuts a ZWJ emoji sequence', () => {
    const family = '👨‍👩‍👧';
    const clipped = clipChatInputDisplay(`${'a'.repeat(30)}${family}${'b'.repeat(10)}`, 20);
    // budget 13 = ellipsis + family (2) + 10 b
    expect(clipped).toBe(`…${family}${'b'.repeat(10)}`);
    const tight = clipChatInputDisplay(`${'a'.repeat(30)}${family}${'b'.repeat(11)}`, 20);
    expect(tight).toBe(`…${'b'.repeat(11)}`);
    expect(tight).not.toContain('\u200d');
  });
});

describe('ChatInput single-line contract', () => {
  it('turns tabs into spaces', () => {
    expect(toSingleLineChatInput('a\tb\t\tc')).toBe('a b  c');
  });

  it('turns pasted line breaks into single spaces', () => {
    expect(toSingleLineChatInput('first line\nsecond\r\n\r\nthird')).toBe('first line second third');
  });

  it('leaves a single-line value untouched', () => {
    expect(toSingleLineChatInput('한글 ok 😀')).toBe('한글 ok 😀');
  });
});

describe('ChatInput keystrokes', () => {
  it('keeps a pasted multi-line chunk on one line and submits it as one line', async () => {
    const { render } = await import('ink-testing-library');
    const React = await import('react');
    const { ChatInput } = await import('./ChatInput.js');
    const changes: string[] = [];
    const submits: string[] = [];
    let current = '';
    const view = render(React.createElement(ChatInput, {
      value: current,
      active: true,
      busy: false,
      onChange: (v: string) => { changes.push(v); current = v; },
      onSubmit: (v: string) => { submits.push(v); },
    }));
    view.stdin.write('alpha\nbeta');
    await new Promise((r) => setTimeout(r, 20));
    expect(changes.at(-1)).toBe('alpha beta');
    view.rerender(React.createElement(ChatInput, {
      value: 'one\ntwo',
      active: true,
      busy: false,
      onChange: (v: string) => { changes.push(v); },
      onSubmit: (v: string) => { submits.push(v); },
    }));
    view.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(submits).toEqual(['one two']);
    view.unmount();
  });
});
