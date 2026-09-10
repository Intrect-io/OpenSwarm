// Long-session coverage: prompt + persisted-history budgets (ChatPanel paths).
import { describe, it, expect } from 'vitest';
import {
  boundChatHistory,
  buildConversationPrompt,
  historyToMessages,
  MAX_CHAT_HISTORY,
  chatReducer,
  initialChatState,
  type ChatLine,
} from '../chatModel.js';

describe('ChatPanel long-session history budgets', () => {
  it(`caps retained reducer history at ${MAX_CHAT_HISTORY}`, () => {
    let state = initialChatState;
    for (let i = 0; i < MAX_CHAT_HISTORY + 15; i++) {
      state = chatReducer(state, { type: 'user', content: `turn-${i}` });
      state = chatReducer(state, { type: 'stream', chunk: `reply-${i}` });
      state = chatReducer(state, { type: 'commit' });
    }
    expect(state.history).toHaveLength(MAX_CHAT_HISTORY);
    expect(state.history.some((l) => l.content === 'turn-0')).toBe(false);
    expect(state.history.at(-1)).toEqual({ role: 'assistant', content: `reply-${MAX_CHAT_HISTORY + 14}` });
  });

  it('prompt and persisted message lists stay within the budget for long chats', () => {
    const history: ChatLine[] = Array.from({ length: 320 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `line-${i}`,
    }));
    const retained = boundChatHistory(history);
    const persisted = boundChatHistory(historyToMessages(retained), MAX_CHAT_HISTORY);
    const promptMessages = boundChatHistory(
      [...persisted, { role: 'user' as const, content: 'newest-user' }],
      MAX_CHAT_HISTORY,
    );
    const prompt = buildConversationPrompt(promptMessages);

    expect(retained).toHaveLength(MAX_CHAT_HISTORY);
    expect(persisted.length).toBeLessThanOrEqual(MAX_CHAT_HISTORY);
    expect(promptMessages.length).toBeLessThanOrEqual(MAX_CHAT_HISTORY);
    expect(prompt).toContain('newest-user');
    expect(prompt).not.toContain('line-0');
  });
});
