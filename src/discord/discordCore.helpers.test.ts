import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clampDiscordText, getChatHistory, questionCorrelationIdFrom, saveChatHistory, startTypingIndicator } from './discordCore.js';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';

afterEach(() => {
  resetHumanSurfaceReadOnlyForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OPENSWARM_CHAT_HISTORY_FILE;
});

describe('Discord persisted chat history', () => {
  it('serializes concurrent updates in an owner-only snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-discord-history-'));
    const path = join(dir, 'history.json');
    process.env.OPENSWARM_CHAT_HISTORY_FILE = path;
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => saveChatHistory({
        timestamp: new Date(index).toISOString(),
        user: `user-${index}`,
        userId: String(index),
        message: `message-${index}`,
        response: `response-${index}`,
      })));
      expect(await getChatHistory()).toHaveLength(20);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(20);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Discord outbound bounds', () => {
  it('clamps embed descriptions to the exact Discord limit', () => {
    const value = clampDiscordText('x'.repeat(5000), 4096);
    expect(value).toHaveLength(4096);
    expect(value.endsWith('…')).toBe(true);
  });

  it('observes initial and repeated typing failures without unhandled rejection', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendTyping = vi.fn(async () => { throw new Error('no permission'); });
    const timer = startTypingIndicator({ sendTyping }, 100);
    await vi.runOnlyPendingTimersAsync();
    clearInterval(timer);
    expect(sendTyping.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
  });

  it('does not emit typing activity in strict mode', async () => {
    const sendTyping = vi.fn(async () => {});
    enableHumanSurfaceReadOnly();
    const timer = startTypingIndicator({ sendTyping }, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearTimeout(timer);
    expect(sendTyping).not.toHaveBeenCalled();
  });
});

// AGT-4070: replying to an agent's question is how an operator naturally
// answers it. Until this existed the reply fell through to the chat handler and
// the asking agent never saw it — 28 runs sat parked on questions that had been
// replied to. The link lives in the message Discord already stores, so a parked
// question that outlives the daemon still resolves after a restart.
describe('questionCorrelationIdFrom (AGT-4070)', () => {
  const BOT = 'bot-user-1';
  const posted = (content: string, authorId = BOT) => ({ author: { id: authorId }, content });

  it('reads the correlation id out of a question we posted', () => {
    const id = questionCorrelationIdFrom(
      posted('OpenSwarm needs a decision for AX-1.\nShip v2?\n\nReply to this message with your answer, or: !answer hq-abc123 <your answer>'),
      BOT,
    );
    expect(id).toBe('hq-abc123');
  });

  it('ignores a message somebody else wrote, however it is worded', () => {
    // Otherwise an operator could reply to their OWN message containing
    // `!answer <id>` and answer through a path that never checked who asked.
    expect(questionCorrelationIdFrom(posted('!answer hq-abc123 yes', 'someone-else'), BOT)).toBeUndefined();
  });

  it('ignores one of our messages that is not a question', () => {
    expect(questionCorrelationIdFrom(posted('Build finished in 41s'), BOT)).toBeUndefined();
  });

  it('claims nothing when the reference could not be fetched, or we do not know who we are', () => {
    expect(questionCorrelationIdFrom(null, BOT)).toBeUndefined();
    expect(questionCorrelationIdFrom(posted('!answer hq-abc123 <your answer>'), undefined)).toBeUndefined();
    // Both sides unknown must NOT compare equal: `undefined !== undefined` is
    // false, so without the explicit guard an author-less message would be
    // read as ours and answer a question on nobody's authority.
    expect(questionCorrelationIdFrom({ author: null, content: '!answer hq-abc123 yes' }, undefined)).toBeUndefined();
  });
});
