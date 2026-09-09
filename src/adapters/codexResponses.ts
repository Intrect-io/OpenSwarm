/** Parse a `data: {json}` SSE line into an event, or null for keep-alives/[DONE]. */
function parseSseLine(line: string): SseEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  // Discard oversized event payloads to prevent memory exhaustion (32KB cap)
  if (data.length > 32 * 1024) return null;
  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return null;
  }
}

/**
 * Read the whole SSE body and reduce it to a chat-shaped response. When
 * `onToken` is provided, each `response.output_text.delta` is emitted live so
 * the chat TUI can stream tokens as they arrive.
 */
// Maximum number of SSE events to retain in memory
const MAX_EVENTS_BUFFER = 500;
// Maximum size of the partial-frame buffer before truncation
const MAX_FRAME_BUFFER = 1024 * 1024; // 1 MiB

async function consumeResponsesStream(
  res: Response,
  onToken?: (delta: string) => void,
  onReasoning?: (line: string) => void,
): Promise<ChatLikeResponse> {
  const events: SseEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Codex responses: empty stream body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Reasoning summary streams token-by-token; buffer and emit whole lines so the
  // live log shows readable thoughts instead of one-word-per-line spam.
  let reasoningBuf = '';
  const flushReasoning = (force: boolean) => {
    if (!onReasoning) { reasoningBuf = ''; return; }
    let idx;
    while ((idx = reasoningBuf.indexOf('\n')) >= 0) {
      const line = reasoningBuf.slice(0, idx).trim();
      reasoningBuf = reasoningBuf.slice(idx + 1);
      if (line) onReasoning(line);
    }
    if (force && reasoningBuf.trim()) { onReasoning(reasoningBuf.trim()); reasoningBuf = ''; }
  };
  const handle = (ev: SseEvent | null) => {
    if (!ev) return;
    // Enforce maximum buffer size with sliding window
    if (events.length >= MAX_EVENTS_BUFFER) {
      events.shift(); // Remove oldest event
    }
    events.push(ev);
    if (onToken && ev.type === 'response.output_text.delta' && ev.delta) onToken(ev.delta);
    if (onReasoning && ev.type === 'response.reasoning_summary_text.delta' && ev.delta) {
      reasoningBuf += ev.delta;
      flushReasoning(false);
    }
    // End of a summary part → flush whatever partial line remains.
    if (ev.type === 'response.reasoning_summary_text.done' || ev.type === 'response.reasoning_summary_part.added') {
      flushReasoning(true);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    // Cap partial-frame buffer to prevent OOM from a malicious or runaway stream
    if (buffer.length + decoded.length > MAX_FRAME_BUFFER) {
      buffer = buffer.slice(-MAX_FRAME_BUFFER) + decoded.slice(0, MAX_FRAME_BUFFER);
    } else {
      buffer += decoded;
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(parseSseLine(line));
  }
  handle(parseSseLine(buffer));
  flushReasoning(true);

  return reduceResponsesEvents(events);
}