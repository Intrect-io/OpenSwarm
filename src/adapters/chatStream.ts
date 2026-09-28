// ============================================
// OpenSwarm - chat/completions SSE streaming
// ============================================
//
// Shared streaming parser for the OpenAI chat/completions-style adapters
// (gpt / openrouter / local). With `stream: true` the server emits SSE chunks
// whose `choices[0].delta` carry incremental content + tool-call fragments;
// this reduces them back into the same shape `res.json()` would have produced
// (so the agentic loop is unaffected) while emitting each content delta via
// `onToken` for live chat streaming. Mirrors vega-agent streaming.py.

/** A chat-completions tool call (same shape the non-streaming path returns). */
export interface StreamToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletionLike {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: StreamToolCall[] };
    finish_reason: string;
  }>;
  usage?: ChatUsage;
  /** Model id the server reports having served (may differ from the one requested). */
  model?: string;
}

/**
 * Usage as the agentic loop consumes it. `cost` / `upstream_cost` are the
 * metered charge in USD (OpenRouter attaches them to the final chunk of every
 * response; other chat-completions servers omit them, so the loop records the
 * call as unmetered rather than $0). `cached_tokens` is a subset of
 * prompt_tokens; `reasoning_tokens` a subset of completion_tokens. (AGT-4178)
 */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
  upstream_cost?: number;
}

interface StreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: RawChatUsage | null;
}

/** The wire shape (OpenRouter's usage-accounting fields are optional extras). */
export interface RawChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | null;
  cost_details?: { upstream_inference_cost?: number | null } | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}

/** Normalise a wire usage object; `usage.cost` survives only when it is a finite number. */
export function normalizeChatUsage(raw: RawChatUsage): ChatUsage {
  const pt = raw.prompt_tokens ?? 0;
  const ct = raw.completion_tokens ?? 0;
  const usage: ChatUsage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: raw.total_tokens ?? pt + ct };
  const cached = raw.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') usage.cached_tokens = cached;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') usage.reasoning_tokens = reasoning;
  if (typeof raw.cost === 'number' && Number.isFinite(raw.cost)) usage.cost = raw.cost;
  const upstream = raw.cost_details?.upstream_inference_cost;
  if (typeof upstream === 'number' && Number.isFinite(upstream)) usage.upstream_cost = upstream;
  return usage;
}

/**
 * Reduce parsed SSE chunks → a chat-completions response. Exported so the
 * content/tool-call accumulation is unit-testable without a live stream.
 * `onToken` is called for each content delta in order.
 */
export function reduceChatChunks(chunks: StreamChunk[], onToken?: (delta: string) => void): ChatCompletionLike {
  let content = '';
  let sawContent = false;
  let finishReason = 'stop';
  let usage: ChatCompletionLike['usage'];
  let model: string | undefined;
  // Tool calls accumulate by their streaming index (id/name arrive once, arguments stream).
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (const chunk of chunks) {
    if (chunk.usage) usage = normalizeChatUsage(chunk.usage);
    if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      sawContent = true;
      onToken?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls: StreamToolCall[] = [...calls.values()].map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: c.args },
  }));

  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: sawContent ? content : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
      },
    ],
    usage,
    ...(model ? { model } : {}),
  };
}

/** Parse one `data: {json}` SSE line into a chunk, or null for [DONE]/keep-alives. */
function parseChunkLine(line: string): StreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as StreamChunk;
  } catch {
    return null;
  }
}

/**
 * Byte ceilings on ONE streamed chat/completions call.
 *
 * Frames are split on '\n', so bytes from an endpoint that never sends one pile
 * up in the carry buffer for as long as it keeps writing — the request deadline
 * is the only other thing that would stop it, and that is minutes away. 1 MiB
 * matches the partial-line bound this repo already keeps for the same reason
 * (streamBuffer.ts MAX_LINE_BUFFER_BYTES); a real chunk here is a few hundred
 * bytes, so nothing legitimate approaches it.
 *
 * The raw ceiling bounds bytes read from a source we do not control, the same
 * class as the 2 MiB web-fetch body cap (webTools.ts) and the 16 MiB
 * GIT_OUTPUT_LIMIT in applyPatch.ts. It is deliberately the same 16 MiB the
 * Responses adapter applies, so the two streaming parsers this repo runs against
 * model endpoints share one ceiling: below the model's own output window, and
 * far above any real answer. Both limits are stated in the error.
 */
const MAX_CHAT_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_PARTIAL_FRAME_BYTES = 1024 * 1024;
/** Read a chat/completions SSE body and reduce it, emitting content deltas live. */
export async function consumeChatCompletionsStream(
  res: Response,
  onToken?: (delta: string) => void,
  /** Called whenever body bytes arrive — progress for a stall guard. */
  onBytes?: () => void,
): Promise<ChatCompletionLike> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('chat stream: empty response body');

  const chunks: StreamChunk[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let readBytes = 0;
  const handle = (c: StreamChunk | null) => {
    if (!c) return;
    const delta = c.choices?.[0]?.delta?.content;
    if (onToken && typeof delta === 'string' && delta) onToken(delta);
    chunks.push(c);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes?.();
    readBytes += value.byteLength;
    if (readBytes > MAX_CHAT_STREAM_BYTES) {
      await reader.cancel('chat stream exceeded retention limit').catch(() => {});
      throw new Error(`chat stream exceeded the 16 MiB limit (${readBytes} bytes read)`);
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The carry is what a non-newline flood grows, so the ceiling is applied to
    // the carry rather than to the decoded chunk: a burst of many complete
    // frames in one chunk is not a partial frame and must not trip this bound.
    buffer = lines.pop() ?? '';
    if (Buffer.byteLength(buffer, 'utf8') > MAX_CHAT_PARTIAL_FRAME_BYTES) {
      await reader.cancel('chat stream partial frame exceeded limit').catch(() => {});
      throw new Error('chat stream partial frame exceeded the 1 MiB limit (no newline in the stream)');
    }
    for (const line of lines) handle(parseChunkLine(line));
  }
  handle(parseChunkLine(buffer));

  // Final reduce WITHOUT onToken (already emitted above) to assemble the result.
  return reduceChatChunks(chunks);
}
