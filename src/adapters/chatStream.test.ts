import { describe, it, expect, vi } from 'vitest';
import {
  MAX_PARTIAL_FRAME_CHARS,
  MAX_RETAINED_CONTENT_CHARS,
  MAX_RETAINED_TOOLCALL_CHARS,
  consumeChatCompletionsStream,
  reduceChatChunks,
} from './chatStream.js';

/** An SSE body that never emits a newline — the partial-frame buffer must not grow unboundedly. */
function endlessFrameResponse(hugeLine: string, tail: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(hugeLine));
      controller.enqueue(new TextEncoder().encode(`\n${tail}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('chat stream retention bounds (AGT-3429)', () => {
  it('keeps the partial-frame buffer bounded when a frame never terminates', async () => {
    const hugeFrame = `data: ${'x'.repeat(MAX_PARTIAL_FRAME_CHARS * 2)}`;
    const result = await consumeChatCompletionsStream(endlessFrameResponse(
      hugeFrame,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }] })}`,
    ));

    const content = result.choices[0]?.message.content;
    expect(typeof content).toBe('string');
    expect(content!.length).toBeLessThanOrEqual(MAX_PARTIAL_FRAME_CHARS);
  });

  it('caps retained content once the stream exceeds the hard limit', async () => {
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(64 * 1024) } }] })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // 2 MiB of deltas — twice MAX_RETAINED_CONTENT_CHARS.
        for (let i = 0; i < 32; i++) controller.enqueue(encoder.encode(chunk));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const seen: string[] = [];
    const result = await consumeChatCompletionsStream(
      new Response(body, { status: 200 }),
      (delta) => seen.push(delta),
    );

    const content = result.choices[0]?.message.content;
    expect(content!.length).toBeLessThanOrEqual(MAX_RETAINED_CONTENT_CHARS);
    expect(seen.join('').length).toBeLessThanOrEqual(MAX_RETAINED_CONTENT_CHARS);
  });

  it('retains a tool call whose arguments stream in many fragments', async () => {
    // Regression: evicting old chunks to bound memory once corrupted the head of
    // a streamed tool call, handing the tool layer invalid JSON.
    const total = 3000;
    const expectedArgs = `{"path":"a.ts","content":"${'A'.repeat(4000)}"}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const step = Math.ceil(expectedArgs.length / total);
        for (let i = 0; i < expectedArgs.length; i += step) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: expectedArgs.slice(i, i + step) } }] } }],
          })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const res = await consumeChatCompletionsStream(new Response(body, { status: 200 }));
    const call = res.choices[0].message.tool_calls?.[0];
    expect(call?.function.name).toBe('write_file');
    expect(call?.function.arguments).toBe(expectedArgs);
    expect(() => JSON.parse(call!.function.arguments)).not.toThrow();
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('keeps the head of a long reply, not a suffix', async () => {
    const expected = Array.from({ length: 1500 }, (_, i) => `w${i} `).join('');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (let i = 0; i < 1500; i++) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${i} ` } }] })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const res = await consumeChatCompletionsStream(new Response(body, { status: 200 }));
    expect(res.choices[0]?.message.content).toBe(expected);
  });

  it('refuses rather than silently corrupting tool-call arguments past the cap', async () => {
    const huge = 'z'.repeat(MAX_RETAINED_TOOLCALL_CHARS + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: huge } }] } }],
        })}\n\n`));
        controller.close();
      },
    });

    await expect(consumeChatCompletionsStream(new Response(body, { status: 200 }))).rejects.toThrow(
      /tool-call arguments exceed/,
    );
  });
});

describe('reduceChatChunks', () => {
  it('keeps the model the server reports serving', () => {
    const res = reduceChatChunks([
      { model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'o' } }] },
      { model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'k' }, finish_reason: 'stop' }] },
    ] as Parameters<typeof reduceChatChunks>[0]);
    expect(res.model).toBe('deepseek-v4.1-flash');
    expect(reduceChatChunks([{ choices: [{ delta: { content: 'x' } }] }]).model).toBeUndefined();
  });

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

describe('reduceChatChunks usage accounting (AGT-4178)', () => {
  it('keeps the metered cost, cached and reasoning tokens from the final chunk', () => {
    const out = reduceChatChunks([
      { choices: [{ delta: { content: 'hi' } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          total_tokens: 1240,
          cost: 0.00312,
          cost_details: { upstream_inference_cost: 0.003 },
          prompt_tokens_details: { cached_tokens: 900 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    ]);
    expect(out.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      cost: 0.00312,
      upstream_cost: 0.003,
      cached_tokens: 900,
      reasoning_tokens: 12,
    });
  });

  it('leaves cost absent — not zero — when the server does not price the call', () => {
    const out = reduceChatChunks([
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: null, prompt_tokens_details: null } },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(out.usage && 'cost' in out.usage).toBe(false);
  });
});
