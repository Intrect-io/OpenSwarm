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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } |
         { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RawChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export function normalizeChatUsage(raw: RawChatUsage): ChatUsage {
  return {
    prompt_tokens: raw.prompt_tokens ?? 0,
    completion_tokens: raw.completion_tokens ?? 0,
    total_tokens: raw.total_tokens ?? 0,
  };
}

// Maximum accumulated content bytes before truncation in reduceChatChunks
const MAX_ACCUMULATED_CONTENT = 64 * 1024; // 64 KiB

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
  // Tool calls accumulate by their streaming index (id/name arrive once, arguments stream).
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (const c of chunks) {
    const delta = c.choices?.[0]?.delta;
    if (!delta) {
      if (c.usage) usage = c.usage as ChatCompletionLike['usage'];
      if (c.choices?.[0]?.finish_reason) finishReason = c.choices[0].finish_reason;
      continue;
    }
    if (delta.content) {
      // Truncate accumulated content at MAX_ACCUMULATED_CONTENT to prevent OOM
      if (content.length < MAX_ACCUMULATED_CONTENT) {
        const remaining = MAX_ACCUMULATED_CONTENT - content.length;
        const portion = delta.content.slice(0, remaining);
        content += portion;
        sawContent = true;
        if (onToken) onToken(portion);
      }
      // else: silently drop excess content beyond the cap
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = calls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
          calls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }
    if (c.choices?.[0]?.finish_reason) finishReason = c.choices[0].finish_reason;
  }

  const toolCalls: StreamToolCall[] = [];
  for (const [, v] of calls) {
    toolCalls.push({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args } });
  }

  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: sawContent ? content : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/** Parse a single SSE `data: …` line into a StreamChunk, or null for keep-alives/[DONE]. */
export function parseChunkLine(line: string): StreamChunk | null {
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

/** Hard cap on the SSE partial-frame buffer to prevent memory exhaustion. */
const MAX_FRAME_SIZE = 512 * 1024; // 512 KiB

/** Read a chat/completions SSE body and reduce it, emitting content deltas live. */
export async function consumeChatCompletionsStream(
  res: Response,
  onToken?: (delta: string) => void,
): Promise<ChatCompletionLike> {
  const chunks: StreamChunk[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('chat completions: empty stream body');

  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (chunk: StreamChunk | null) => {
    if (chunk) chunks.push(chunk);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    // If the partial-frame buffer would exceed the cap, flush what we have
    // and discard the rest of this frame.
    if (buffer.length + decoded.length > MAX_FRAME_SIZE) {
      const remainingSpace = MAX_FRAME_SIZE - buffer.length;
      const truncated = decoded.slice(0, remainingSpace);
      buffer += truncated;
      // Process and flush the buffer immediately
      const lines = buffer.split('\n');
      buffer = '';
      for (const line of lines) handle(parseChunkLine(line));
      continue;
    }
    buffer += decoded;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(parseChunkLine(line));
  }
  handle(parseChunkLine(buffer));

  // Final reduce WITHOUT onToken (already emitted above) to assemble the result.
  return reduceChatChunks(chunks);
}