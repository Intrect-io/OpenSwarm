import { describe, it, expect } from 'vitest';
import { deleteLastGrapheme, clipChatInputDisplay, CHAT_INPUT_DISPLAY_OVERHEAD } from './ChatInput.js';

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
