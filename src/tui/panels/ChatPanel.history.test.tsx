// Long-session coverage: prompt + persisted-history budgets (ChatPanel paths).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { Message, Session } from '../../support/chatSession.js';

const persistence = vi.hoisted(() => ({
  saves: [] as Session[],
  archives: [] as Message[][],
  order: [] as string[],
}));
vi.mock('../../support/chatSession.js', async () => {
  const actual = await vi.importActual<typeof import('../../support/chatSession.js')>('../../support/chatSession.js');
  return {
    ...actual,
    saveSession: vi.fn(async (session: Session) => {
      persistence.saves.push(JSON.parse(JSON.stringify(session)) as Session);
      persistence.order.push('save');
    }),
    appendSessionArchive: vi.fn((_id: string, messages: Message[]) => {
      persistence.archives.push(messages);
      persistence.order.push('archive');
    }),
    callChatModel: vi.fn(async (_p: string, _prov: string, _m: string, onStream: (t: string, k: boolean) => void) => {
      onStream('fresh reply', false);
      return { response: 'fresh reply', sessionId: '', cost: 0, tokens: 0 };
    }),
  };
});

import {
  boundChatHistory,
  buildConversationPrompt,
  historyToMessages,
  MAX_CHAT_HISTORY,
  chatReducer,
  initialChatState,
  type ChatLine,
} from '../chatModel.js';
import { ChatPanel, chatLogRowBudget, chatMenuRows, CHAT_CHROME_ROWS } from './ChatPanel.js';

const tick = () => new Promise((r) => setTimeout(r, 60));

describe('ChatPanel long-session history budgets', () => {
  it(`caps retained reducer history at ${MAX_CHAT_HISTORY}`, () => {
    let state = initialChatState;
    for (let i = 0; i < MAX_CHAT_HISTORY + 15; i++) {
      state = chatReducer(state, { type: 'user', content: `turn-${i}` });
      state = chatReducer(state, { type: 'stream', chunk: `reply-${i}` });
      state = chatReducer(state, { type: 'commit' });
    }
    // Cut on a turn boundary: never more than the budget, and never an orphan reply first.
    expect(state.history.length).toBeLessThanOrEqual(MAX_CHAT_HISTORY);
    expect(state.history.length).toBeGreaterThanOrEqual(MAX_CHAT_HISTORY - 1);
    expect(state.history[0]?.role).toBe('user');
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

describe('ChatPanel resume over the history budget', () => {
  const resumed: ChatLine[] = Array.from({ length: MAX_CHAT_HISTORY + 50 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `old-${i}`,
  }));

  beforeEach(() => {
    persistence.saves.length = 0;
    persistence.archives.length = 0;
    persistence.order.length = 0;
  });

  it('shows one trim notice and does not rewrite the session file on resume alone', async () => {
    const view = render(<ChatPanel active sessionId="resume-a" initialHistory={resumed} />);
    await tick();
    const frame = view.lastFrame()!;
    expect(frame).toContain('50 older messages trimmed from this view');
    expect(frame.split('older messages trimmed').length - 1).toBe(1);
    // slash-command output is not a conversation message: still no save
    view.stdin.write('/help');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(persistence.saves).toHaveLength(0);
    expect(persistence.archives).toHaveLength(0);
    view.unmount();
  });

  it('archives the trimmed prefix before the first save so no resumed turn is lost', async () => {
    const view = render(<ChatPanel active sessionId="resume-b" initialHistory={resumed} />);
    await tick();
    view.stdin.write('hello there');
    await tick();
    view.stdin.write('\r');
    await tick();
    await tick();
    expect(persistence.saves.length).toBeGreaterThan(0);
    expect(persistence.order[0]).toBe('archive');
    const archived = persistence.archives.flat().map((m) => m.content);
    const saved = persistence.saves.at(-1)!.messages.map((m) => m.content);
    // archive + newest file together hold every resumed message, in order, once
    const original = resumed.map((l) => l.content);
    const firstKept = saved.findIndex((c) => c.startsWith('old-'));
    expect([...archived, ...saved.slice(firstKept).filter((c) => c.startsWith('old-'))]).toEqual(original);
    expect(saved.at(-1)).toBe('fresh reply');
    expect(saved).toContain('hello there');
    view.unmount();
  });
});

describe('ChatPanel chat log row budget', () => {
  it('subtracts the rendered slash palette or selector rows from the log budget', () => {
    expect(chatMenuRows(null, 0)).toBe(0);
    expect(chatMenuRows(null, 3)).toBe(4); // margin + 3 matches
    expect(chatMenuRows(5, 2)).toBe(8); // selector wins: margin + title + 5 items + hint
    expect(chatLogRowBudget(40, chatMenuRows(null, 3))).toBe(40 - CHAT_CHROME_ROWS - 4);
    expect(chatLogRowBudget(40, chatMenuRows(10, 0))).toBe(40 - CHAT_CHROME_ROWS - 13);
    expect(chatLogRowBudget(12, chatMenuRows(10, 0))).toBe(8); // floor
  });
});

