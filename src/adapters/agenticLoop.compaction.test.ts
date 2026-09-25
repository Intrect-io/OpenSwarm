// ============================================
// OpenSwarm - Window-sized compaction + tool-output trimming (AGT-4386)
// Created: 2026-09-17
// Purpose: Pin the threshold policy and the trim stage that runs before the
//   whole-history summary, plus the loop's one-line report of what it chose.
// Dependencies: vitest
// Test Status: npm test -- src/adapters/agenticLoop.compaction.test.ts
// ============================================

import { describe, expect, it } from 'vitest';
import {
  COMPACT_AT_FRACTION,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  MAX_COMPACT_AT,
  MIN_COMPACT_AT,
  resolveCompactionThreshold,
  runAgenticLoop,
  trimOversizedToolOutputs,
  type ChatMessage,
} from './agenticLoop.js';

describe('resolveCompactionThreshold', () => {
  it('keeps the fixed fallback when the window is unknown', () => {
    expect(resolveCompactionThreshold(undefined, { fallback: 60000 })).toEqual({ compactAt: 60000, source: 'fallback' });
    expect(resolveCompactionThreshold(0, { fallback: 60000 })).toEqual({ compactAt: 60000, source: 'fallback' });
    expect(resolveCompactionThreshold(Number.NaN, { fallback: 60000 }).source).toBe('fallback');
  });

  it('derives 0.75 × (window − reserved output) for a known window', () => {
    const r = resolveCompactionThreshold(262144, { fallback: 60000 });
    expect(r.source).toBe('window');
    expect(r.compactAt).toBe(Math.floor((262144 - DEFAULT_RESERVED_OUTPUT_TOKENS) * COMPACT_AT_FRACTION));
    expect(r.compactAt).toBe(184320);
  });

  it('protects a small window instead of waiting for the 60k fallback', () => {
    const r = resolveCompactionThreshold(32768, { fallback: 60000 });
    expect(r.compactAt).toBe(12288); // 0.75 × (32768 − 16384)
    expect(r.compactAt).toBeLessThan(60000);
  });

  it('never goes below the floor even for a pathological window', () => {
    expect(resolveCompactionThreshold(8192, { fallback: 60000 }).compactAt).toBe(MIN_COMPACT_AT);
    expect(resolveCompactionThreshold(1000, { fallback: 60000 }).compactAt).toBe(MIN_COMPACT_AT);
  });

  it('caps a 1M window at the cost/attention ceiling', () => {
    expect(resolveCompactionThreshold(1_048_576, { fallback: 60000 }).compactAt).toBe(MAX_COMPACT_AT);
  });

  it('honours a caller-supplied output reserve', () => {
    expect(resolveCompactionThreshold(131072, { fallback: 60000, reservedOutputTokens: 8192 }).compactAt).toBe(
      Math.floor((131072 - 8192) * COMPACT_AT_FRACTION),
    );
  });
});

function conversation(turns: number, bigEvery = 2): ChatMessage[] {
  const big = 'x'.repeat(20_000); // ≈ 5.4k tokens at the English rate
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: i % 2 === 0 ? 'read_file' : 'bash', arguments: '{}' } }],
    });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: i % bigEvery === 0 ? big : 'small' });
  }
  return msgs;
}

describe('trimOversizedToolOutputs', () => {
  it('replaces only large tool bodies older than the recent window, naming the tool', () => {
    const msgs = conversation(10); // 22 messages; big outputs at i = 0,2,4,6,8
    const before = msgs.map((m) => ({ ...m }));
    const trimmed = trimOversizedToolOutputs(msgs, { maxTokens: 2000, keepRecent: 4 });
    // Recent window = last 4 messages (turns 8 and 9): turn 8's big output survives.
    expect(trimmed).toBe(4);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const was = before[i];
      if (m.role !== 'tool') {
        expect(m).toEqual(was); // assistant turns, system, user: byte-identical
        continue;
      }
      if (was.content === 'small' || i >= msgs.length - 4) {
        expect(m.content).toBe(was.content);
      } else {
        expect(m.content).toMatch(/^\[tool output trimmed: ~\d+ tokens from "read_file"\. Read it again if you still need it\.\]$/);
      }
    }
  });

  it('is idempotent and leaves the shape intact for the API (every tool message keeps its id)', () => {
    const msgs = conversation(10);
    const first = trimOversizedToolOutputs(msgs, { maxTokens: 2000, keepRecent: 4 });
    const second = trimOversizedToolOutputs(msgs, { maxTokens: 2000, keepRecent: 4 });
    expect(first).toBe(4);
    expect(second).toBe(0);
    const toolMsgs = msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
    expect(toolMsgs.every((m) => typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0)).toBe(true);
    expect(msgs.length).toBe(22);
  });

  it('does nothing when the whole conversation is inside the recent window', () => {
    const msgs = conversation(3);
    expect(trimOversizedToolOutputs(msgs, { maxTokens: 2000, keepRecent: 10 })).toBe(0);
  });
});

describe('runAgenticLoop reports the threshold it chose', () => {
  const finalResp = (content: string) => ({
    choices: [{ message: { role: 'assistant' as const, content }, finish_reason: 'stop' }],
  });

  it('logs the window-derived threshold when the adapter passes a window', async () => {
    const logs: string[] = [];
    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi: async () => finalResp('done'),
      maxTurns: 2, webTools: false, contextWindowTokens: 262144, onLog: (l) => logs.push(l),
    });
    expect(logs.find((l) => l.startsWith('📐'))).toBe('📐 Context window 262144 tokens → compact at 184320 (0.75 × usable)');
  });

  it('logs the fallback when no window is known', async () => {
    const logs: string[] = [];
    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi: async () => finalResp('done'),
      maxTurns: 2, webTools: false, onLog: (l) => logs.push(l),
    });
    expect(logs.find((l) => l.startsWith('📐'))).toBe('📐 Context window unknown → compact at 60000 (fallback)');
  });
});
