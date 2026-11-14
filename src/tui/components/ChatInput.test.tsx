import { describe, it, expect } from 'vitest';
import { deleteLastGrapheme, toSingleLineChatInput } from './ChatInput.js';

describe('ChatInput deleteLastGrapheme', () => {
  it('deletes an emoji as one grapheme', () => {
    expect(deleteLastGrapheme('ok😀')).toBe('ok');
  });

  it('deletes a base character plus combining mark as one grapheme', () => {
    expect(deleteLastGrapheme('Cafe\u0301')).toBe('Caf');
  });
});

describe('ChatInput single-line contract', () => {
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
