import { describe, it, expect, vi } from 'vitest';
import { consumeChatCompletionsStream, reduceChatChunks } from './chatStream.js';

const encoder = new TextEncoder();

/** An SSE body delivered as exactly the given chunks. */
const sseBody = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

/**
 * A lazy byte flood: `chunks` copies of one buffer, pulled on demand. Lazy so a
 * test can describe an over-cap stream without allocating it up front, and so a
 * bounded reader that cancels stops the source instead of draining it. The
 * returned `pulls` reads -1 once the reader cancelled the body.
 */
const floodResponse = (chunk: Uint8Array, chunks: number) => {
  let pulls = 0;
  const res = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= chunks) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        pulls = -1;
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  return { res, pulls: () => pulls };
};

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

describe('consumeChatCompletionsStream bounds (AGT-3429)', () => {
  it('aborts a non-newline flood instead of buffering it forever', async () => {
    // Frames are split on '\n', so newline-free bytes are carried until one
    // arrives. Without a ceiling this stream just accumulates — 2 MiB of 'x' in
    // 64 KiB chunks — and the call only ends when the server gives up. Real SSE
    // frames for this adapter are a few hundred bytes.
    const { res } = floodResponse(encoder.encode('x'.repeat(64 * 1024)), 32);

    await expect(consumeChatCompletionsStream(res)).rejects.toThrow(
      /partial frame exceeded the 1 MiB limit/,
    );
  });

  it('caps total bytes read even when every frame is well formed', async () => {
    // Every line parses, so the carry never trips — only the raw ceiling can stop
    // an endpoint that streams valid-but-endless frames (a runaway server loop).
    const frame = `data: {"choices":[{"delta":{"content":"${'x'.repeat(4_096)}"}}]}\n`;
    const burst = encoder.encode(frame.repeat(8));
    const { res } = floodResponse(burst, Math.ceil((17 * 1024 * 1024) / burst.byteLength));

    await expect(consumeChatCompletionsStream(res)).rejects.toThrow(/exceeded the 16 MiB limit/);
  });

  it('cancels the body when it gives up, so the source stops producing', async () => {
    // The bound must stop the endpoint, not just stop storing what it sends —
    // otherwise a flooding server keeps a connection busy draining bytes.
    const { res, pulls } = floodResponse(encoder.encode('y'.repeat(64 * 1024)), 32);

    await expect(consumeChatCompletionsStream(res)).rejects.toThrow(/1 MiB limit/);
    expect(pulls()).toBe(-1);
  });

  it('does not mistake one chunk carrying many complete frames for a partial frame', async () => {
    // The carry ceiling must be applied AFTER the split: a burst of complete
    // frames arriving in one chunk can legitimately exceed 1 MiB in total (the
    // whole point of the raw ceiling being 16 MiB), while the carry is empty.
    const frame = `data: {"choices":[{"delta":{"content":"${'q'.repeat(1_024)}"}}]}\n`;
    const frames = 2_048; // 2 MiB of complete frames in a single chunk
    const res = sseBody([`${frame.repeat(frames)}data: [DONE]\n`]);

    const out = await consumeChatCompletionsStream(res);

    expect(out.choices[0].message.content).toBe('q'.repeat(1_024 * frames));
  });

  it('parses a normal multi-frame stream end to end', async () => {
    // The bound must not disturb the ordinary case: content deltas streamed in
    // several frames, a tool call split across frames, usage last — and a single
    // frame as large as a real tool-call fragment (256 KiB) staying well inside
    // the carry ceiling.
    const onToken = vi.fn();
    const bigFrame = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'z'.repeat(256 * 1024) } }],
    })}\n`;
    const res = sseBody([
      'data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      bigFrame,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"edit_file","arguments":"{\\"p"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":\\"x\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n',
      'data: [DONE]\n',
    ]);

    const out = await consumeChatCompletionsStream(res, onToken);

    expect(out.choices[0].message.content).toBe(`Hello${'z'.repeat(256 * 1024)}`);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"x"}' } },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(out.model).toBe('deepseek-v4.1-flash');
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo', 'z'.repeat(256 * 1024)]);
  });
});
