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
  it('clips to the terminal-column budget with an ellipsis without mutating the source', () => {
    const columns = 40;
    const max = Math.max(10, columns - CHAT_INPUT_DISPLAY_OVERHEAD);
    const full = 'x'.repeat(max + 20);
    const clipped = clipChatInputDisplay(full, columns);
    expect(clipped.length).toBe(max);
    expect(clipped.endsWith('…')).toBe(true);
    expect(full.endsWith('…')).toBe(false);
    expect(full.length).toBe(max + 20);
  });

  it('returns the full value when it fits', () => {
    expect(clipChatInputDisplay('short', 80)).toBe('short');
  });
});
