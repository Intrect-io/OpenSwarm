import { describe, it, expect } from 'vitest';
import {
  chatReducer,
  initialChatState,
  parseInput,
  matchSlash,
  movePaletteSelection,
  dedupeDoubledGrapheme,
  normalizeConfirm,
  isActivityNoise,
  historyToMessages,
  messagesToHistory,
  boundChatHistory,
  buildConversationPrompt,
  MAX_CHAT_HISTORY,
  type ChatLine,
} from './chatModel.js';

describe('chatReducer (EPIC INT-1813 S4)', () => {
  it('appends user and system lines', () => {
    let s = chatReducer(initialChatState, { type: 'user', content: 'hi' });
    s = chatReducer(s, { type: 'system', content: 'note' });
    expect(s.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'note' },
    ]);
  });

  it('accumulates streaming chunks then commits to an assistant line', () => {
    let s = chatReducer(initialChatState, { type: 'stream', chunk: 'he' });
    s = chatReducer(s, { type: 'stream', chunk: 'llo' });
    expect(s.streaming).toBe('hello');
    s = chatReducer(s, { type: 'commit' });
    expect(s.streaming).toBeNull();
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('commit with nothing streaming is a no-op', () => {
    const s = chatReducer(initialChatState, { type: 'commit' });
    expect(s).toBe(initialChatState);
  });

  it('clear resets to the initial state', () => {
    const s = chatReducer({ history: [{ role: 'user', content: 'x' }], streaming: 'y' }, { type: 'clear' });
    expect(s).toEqual(initialChatState);
  });

  it(`bounds retained history to ${MAX_CHAT_HISTORY} lines`, () => {
    let s = initialChatState;
    for (let i = 0; i < MAX_CHAT_HISTORY + 40; i++) {
      s = chatReducer(s, { type: 'user', content: `msg-${i}` });
    }
    expect(s.history).toHaveLength(MAX_CHAT_HISTORY);
    expect(s.history[0]?.content).toBe('msg-40');
    expect(s.history.at(-1)?.content).toBe(`msg-${MAX_CHAT_HISTORY + 39}`);
  });
});

describe('chat history budgets (long sessions)', () => {
  it('boundChatHistory keeps the newest window', () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({ role: 'user' as const, content: `u${i}` }));
    const bounded = boundChatHistory(lines);
    expect(bounded).toHaveLength(MAX_CHAT_HISTORY);
    expect(bounded[0]?.content).toBe('u50');
    expect(bounded.at(-1)?.content).toBe('u249');
  });

  it('prompt construction and persisted messages obey the same budget', () => {
    const history: ChatLine[] = Array.from({ length: 260 }, (_, i) =>
      i % 2 === 0
        ? { role: 'user', content: `user-${i}` }
        : { role: 'assistant', content: `asst-${i}` },
    );
    const retained = boundChatHistory(history);
    expect(retained).toHaveLength(MAX_CHAT_HISTORY);

    const persisted = boundChatHistory(historyToMessages(retained), MAX_CHAT_HISTORY);
    expect(persisted.length).toBeLessThanOrEqual(MAX_CHAT_HISTORY);
    expect(persisted.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);

    const prompt = buildConversationPrompt(persisted);
    expect(prompt).not.toContain('user-0');
    expect(prompt).toContain(persisted.at(-1)!.content);
    expect(prompt.split('\n\n').length).toBeLessThanOrEqual(MAX_CHAT_HISTORY + 2);
  });
});

describe('parseInput', () => {
  it('classifies free chat', () => {
    expect(parseInput('  hello world ')).toEqual({ kind: 'chat', text: 'hello world' });
  });
  it('classifies a bare command', () => {
    expect(parseInput('/clear')).toEqual({ kind: 'command', name: '/clear', args: '' });
  });
  it('classifies a command with args', () => {
    expect(parseInput('/model gpt-5.2')).toEqual({ kind: 'command', name: '/model', args: 'gpt-5.2' });
  });
  it('returns null for empty input', () => {
    expect(parseInput('   ')).toBeNull();
  });
});

describe('normalizeConfirm', () => {
  it('maps y/yes → yes, e/edit → edit, everything else → no', () => {
    expect(normalizeConfirm('y')).toBe('yes');
    expect(normalizeConfirm('YES')).toBe('yes');
    expect(normalizeConfirm(' e ')).toBe('edit');
    expect(normalizeConfirm('edit')).toBe('edit');
    expect(normalizeConfirm('n')).toBe('no');
    expect(normalizeConfirm('whatever')).toBe('no');
  });
});

describe('isActivityNoise', () => {
  it('hides API-call loop chatter', () => {
    expect(isActivityNoise('▸ API call #1')).toBe(true);
    expect(isActivityNoise('▸ API call #2 (tool turn 1)')).toBe(true);
    expect(isActivityNoise('[GPT] 3 API calls, 2 tool uses, 1200 tokens')).toBe(true);
  });
  it('keeps real tool activity and results', () => {
    expect(isActivityNoise('🔧 read_file: src/auth.ts')).toBe(false);
    expect(isActivityNoise('📝 SEARCH/REPLACE: applied 1/1 block(s)')).toBe(false);
    expect(isActivityNoise('edit_file auth.ts')).toBe(false);
  });
});

describe('historyToMessages / messagesToHistory (INT-2014)', () => {
  it('keeps user/assistant turns and drops system lines', () => {
    const h: ChatLine[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '/clear done' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('restores messages to history lines', () => {
    expect(messagesToHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });
});

describe('matchSlash', () => {
  it('prefix-matches command names', () => {
    expect(matchSlash('/m').map((c) => c.name)).toEqual(['/model']);
    expect(matchSlash('/').length).toBeGreaterThan(1);
  });
  it('does not match plain chat or once an argument is being typed', () => {
    expect(matchSlash('hello')).toEqual([]);
    expect(matchSlash('/model gpt')).toEqual([]);
  });
});

describe('dedupeDoubledGrapheme (INT-1964)', () => {
  it('collapses a doubled multibyte keystroke event', () => {
    expect(dedupeDoubledGrapheme('이이')).toBe('이');
    expect(dedupeDoubledGrapheme('렇렇')).toBe('렇');
    expect(dedupeDoubledGrapheme('😀😀')).toBe('😀'); // astral grapheme, one code point each
  });

  it('leaves single graphemes, ASCII, and differing pairs untouched', () => {
    expect(dedupeDoubledGrapheme('이')).toBe('이');
    expect(dedupeDoubledGrapheme('aa')).toBe('aa'); // ASCII — not our bug
    expect(dedupeDoubledGrapheme('이렇')).toBe('이렇'); // different graphemes
    expect(dedupeDoubledGrapheme(' ')).toBe(' ');
  });

  // INT-2012: shapes INT-1964 missed — N-repeat and multi-grapheme doubling.
  it('collapses a single grapheme repeated N times (shape A)', () => {
    expect(dedupeDoubledGrapheme('이이이')).toBe('이');
    expect(dedupeDoubledGrapheme('렇렇렇렇')).toBe('렇');
  });

  it('collapses a multi-grapheme event where each grapheme is doubled (shape B)', () => {
    expect(dedupeDoubledGrapheme('이이렇렇게게')).toBe('이렇게'); // '이렇게' doubled in place
    expect(dedupeDoubledGrapheme('가가나나')).toBe('가나');
  });

  it('leaves a normal multi-grapheme word untouched (no doubling)', () => {
    expect(dedupeDoubledGrapheme('이렇게')).toBe('이렇게'); // odd length, not paired
    expect(dedupeDoubledGrapheme('안녕하세요')).toBe('안녕하세요');
    expect(dedupeDoubledGrapheme('가나')).toBe('가나'); // even length but pairs differ
    expect(dedupeDoubledGrapheme('hello')).toBe('hello');
  });

  it('leaves longer input (real pastes) untouched', () => {
    expect(dedupeDoubledGrapheme('이이렇')).toBe('이이렇');
    expect(dedupeDoubledGrapheme('가나다')).toBe('가나다');
  });
});

describe('movePaletteSelection (INT-1959)', () => {
  it('wraps around both ends', () => {
    expect(movePaletteSelection(0, 1, 3)).toBe(1);
    expect(movePaletteSelection(2, 1, 3)).toBe(0); // wrap forward
    expect(movePaletteSelection(0, -1, 3)).toBe(2); // wrap backward
  });
  it('returns 0 for an empty list', () => {
    expect(movePaletteSelection(0, 1, 0)).toBe(0);
  });
});
