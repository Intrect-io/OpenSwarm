// ============================================
// OpenSwarm - Discord delivery correctness tests
// ============================================
//
// Two defects that only surface with real traffic: long output that Discord
// rejects outright, and two messages in one channel finishing out of order.

import { afterEach, describe, expect, it } from 'vitest';
import { appendHistoryEntry, channelHistoryMap, splitForDiscordForTest, updateHistoryResponse } from './discordCore.js';

/** Discord's hard limit on message content. Embeds are 4096; messages are not. */
const DISCORD_CONTENT_LIMIT = 2000;

afterEach(() => {
  channelHistoryMap.clear();
});

describe('splitForDiscord', () => {
  // The bug this replaces: sendToChannel split at 3900 because a comment
  // confused the embed-description limit (4096) with the message limit (2000).
  // Every chunk it produced was rejected by the API, so a long report did not
  // arrive in pieces — it did not arrive at all.
  it.each([2_001, 3_899, 3_901, 12_000])('keeps every chunk under the API limit for %i chars', (length) => {
    const chunks = splitForDiscordForTest('x'.repeat(length));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    }
  });

  it('leaves room for the code fences callers wrap around chunks', () => {
    for (const chunk of splitForDiscordForTest('x'.repeat(9_000))) {
      expect(`\`\`\`\n${chunk}\n\`\`\``.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    }
  });

  it('loses no content across the split', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    expect(splitForDiscordForTest(text).join('\n')).toBe(text);
  });

  it('prefers a line boundary over a hard cut', () => {
    const text = `${'a'.repeat(1_800)}\n${'b'.repeat(1_800)}`;
    const [first] = splitForDiscordForTest(text);
    expect(first).toBe('a'.repeat(1_800));
  });
});

describe('updateHistoryResponse', () => {
  const entry = (messageId: string, body: string) => ({
    sender: 'user',
    senderId: 'u1',
    body,
    timestamp: Date.now(),
    messageId,
  });

  // The regression: two messages handled concurrently do not finish in arrival
  // order. Writing to the last entry meant the first to finish overwrote the
  // newer message's slot — the newer message then had no answer of its own, and
  // the older one displayed a reply to a question nobody asked.
  it('attaches each response to the message it answers, whatever the order', () => {
    appendHistoryEntry('c1', entry('m1', 'first question'));
    appendHistoryEntry('c1', entry('m2', 'second question'));

    // m2 arrived later but finishes first.
    updateHistoryResponse('c1', 'm2', 'answer to second');
    updateHistoryResponse('c1', 'm1', 'answer to first');

    const history = channelHistoryMap.get('c1')!;
    expect(history.find((h) => h.messageId === 'm1')?.response).toBe('answer to first');
    expect(history.find((h) => h.messageId === 'm2')?.response).toBe('answer to second');
  });

  // Attaching it to whatever is last would put the answer on an unrelated
  // message, which is worse than dropping it.
  it('drops a response whose entry has aged out rather than misfiling it', () => {
    appendHistoryEntry('c1', entry('m1', 'still here'));

    updateHistoryResponse('c1', 'gone-from-the-ring-buffer', 'orphan answer');

    expect(channelHistoryMap.get('c1')![0].response).toBeUndefined();
  });

  it('falls back to the last entry when the caller has no message id', () => {
    appendHistoryEntry('c1', { sender: 'user', senderId: 'u1', body: 'q', timestamp: Date.now() });
    updateHistoryResponse('c1', undefined, 'answer');
    expect(channelHistoryMap.get('c1')![0].response).toBe('answer');
  });

  it('is a no-op for an unknown channel', () => {
    expect(() => updateHistoryResponse('nope', 'm1', 'answer')).not.toThrow();
  });
});
