import { describe, it, expect, vi } from 'vitest';
import {
  MAX_CHAT_CHUNKS,
  MAX_PARTIAL_FRAME_CHARS,
  MAX_RETAINED_CONTENT_CHARS,
  reduceChatChunks,
} from './chatStream.js';

describe('chat stream bounds (AGT-3429)', () => {
  it('documents hard caps for partial frames, chunks, and retained content', () => {
    expect(MAX_PARTIAL_FRAME_CHARS).toBe(64 * 1024);
    expect(MAX_CHAT_CHUNKS).toBe(1024);
    expect(MAX_RETAINED_CONTENT_CHARS).toBe(1024 * 1024);
  });
});

describe('reduceChatChunks', () => {
  it('accumulates content deltas and emits each via onToken in order', () => {
    const onToken = vi.fn();
    const res = reduceChatChunks(
      [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      onToken,
    );
    expect(res.choices[0].message.content).toBe('Hello');
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo']);
  });

  it('assembles streamed tool calls by index (id/name once, arguments concatenated)', () => {
    const res = reduceChatChunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit_file', arguments: '{"p' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const tc = res.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc![0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"x"}' } });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.content).toBeNull();
  });

  it('captures usage from the final chunk', () => {
    const res = reduceChatChunks([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('handles multiple distinct tool-call indices', () => {
    const res = reduceChatChunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f0', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'f1', arguments: '{}' } }] } }] },
    ]);
    expect(res.choices[0].message.tool_calls).toHaveLength(2);
    expect(res.choices[0].message.tool_calls!.map((t) => t.function.name)).toEqual(['f0', 'f1']);
  });
});
