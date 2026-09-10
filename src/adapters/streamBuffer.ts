// ============================================
// OpenSwarm - Smart Stream Buffer
// Filters NDJSON stream events to reduce memory usage
// Keeps only result events and assistant text blocks

/**
 * Tracks raw vs filtered output sizes for cost reporting
 */
export interface OutputSizeInfo {
  rawBytes: number;
  filteredBytes: number;
  savingsPercent: number;
}

const MAX_RESULT_EVENTS = 8;
const MAX_TEXT_FRAGMENTS = 256;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
/** Per result-event NDJSON line — without this, eight unbounded results defeat the event-count cap. */
const MAX_RESULT_EVENT_BYTES = 64 * 1024;

/**
 * Rebuild a result event under a byte budget, preferring to keep cost/usage
 * fields and truncating the free-form `result` / text payload.
 */
function truncateResultEventLine(
  line: string,
  event: Record<string, unknown>,
  maxBytes: number,
): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line;
  const copy: Record<string, unknown> = { ...event };
  const truncatableKeys = ['result', 'error', 'message'] as const;
  for (const key of truncatableKeys) {
    const value = copy[key];
    if (typeof value !== 'string') continue;
    // Binary-search a UTF-8-safe prefix that fits with the rest of the object.
    let lo = 0;
    let hi = value.length;
    let best = '';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      copy[key] = `${value.slice(0, mid)}…[truncated]`;
      const candidate = JSON.stringify(copy);
      if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
    copy[key] = '…[truncated]';
  }
  const fallback = JSON.stringify({ type: 'result', result: '…[truncated]', truncated: true });
  return Buffer.byteLength(fallback, 'utf8') <= maxBytes ? fallback : '{"type":"result","result":"…[truncated]"}';
}

/**
 * SmartStreamBuffer filters Claude CLI stream-json (NDJSON) output in real-time.
 *
 * Kept events:
 * - type 'result' — retained (cost/usage) with a per-event byte cap
 * - type 'assistant' — only text blocks extracted (tool_use blocks discarded)
 *
 * Discarded events:
 * - tool_use content blocks (large file contents, command outputs)
 * - tool_result events
 * - system events
 * - content_block_start / content_block_delta / content_block_stop
 *
 * The filtered output is compatible with:
 * - extractResultFromStreamJson() — scans lines for type 'result'
 * - extractCostFromStreamJson() — scans lines for type 'result'
 * - extractWorkerFromText() — matches file/command patterns in text
 */
export class SmartStreamBuffer {
  private rawBytes = 0;
  private lineBuffer = '';
  private resultEvents: string[] = [];
  private textFragments: string[] = [];

  /**
   * Process a raw stdout chunk from the CLI process.
   * Splits into NDJSON lines, filters, and accumulates.
   */
  processChunk(chunk: string): void {
    this.rawBytes += Buffer.byteLength(chunk, 'utf8');

    const combined = this.lineBuffer + chunk;
    const lines = combined.split('\n');
    // Last element may be incomplete — buffer it
    this.lineBuffer = lines.pop() ?? '';
    if (Buffer.byteLength(this.lineBuffer, 'utf8') > MAX_LINE_BUFFER_BYTES) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_LINE_BUFFER_BYTES);
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processLine(trimmed);
    }
  }

  /**
   * Flush any remaining buffered line (call at end of stream).
   */
  flush(): void {
    if (this.lineBuffer.trim()) {
      this.processLine(this.lineBuffer.trim());
      this.lineBuffer = '';
    }
  }

  private processLine(line: string): void {
    try {
      const event = JSON.parse(line);

      if (event.type === 'result') {
        // Preserve result events for cost/usage parsers, but bound each line so
        // a single huge `result` string cannot defeat MAX_RESULT_EVENTS.
        const asRecord = (event && typeof event === 'object')
          ? event as Record<string, unknown>
          : { type: 'result' };
        const capped = Buffer.byteLength(line, 'utf8') > MAX_RESULT_EVENT_BYTES
          ? truncateResultEventLine(line, asRecord, MAX_RESULT_EVENT_BYTES)
          : line;
        this.resultEvents.push(capped);
        if (this.resultEvents.length > MAX_RESULT_EVENTS) this.resultEvents.shift();
        return;
      }

      if (event.type === 'assistant' && event.message?.content) {
        // Extract only text blocks, discard tool_use blocks
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            this.textFragments.push(block.text);
            while (
              this.textFragments.length > MAX_TEXT_FRAGMENTS
              || Buffer.byteLength(this.textFragments.join('\n'), 'utf8') > MAX_TEXT_BYTES
            ) {
              this.textFragments.shift();
            }
          }
        }
        return;
      }

      // All other event types (content_block_*, tool_result, system) → discard
    } catch {
      // Non-JSON line — discard
    }
  }

  /**
   * Build filtered stdout string compatible with downstream parsers.
   *
   * Output format:
   * 1. All result events (verbatim NDJSON lines)
   * 2. A synthetic assistant event containing all collected text fragments
   *
   * This ensures extractResultFromStreamJson() and extractCostFromStreamJson()
   * find their result events, while extractWorkerFromText() can match patterns
   * in the synthetic assistant text.
   */
  buildFilteredStdout(): string {
    this.flush();

    const lines: string[] = [];

    // Emit result events first (verbatim)
    for (const resultLine of this.resultEvents) {
      lines.push(resultLine);
    }

    // Emit synthetic assistant event with collected text
    if (this.textFragments.length > 0) {
      const syntheticEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: this.textFragments.join('\n') }],
        },
      };
      lines.push(JSON.stringify(syntheticEvent));
    }

    return lines.join('\n');
  }

  /**
   * Get size tracking info for cost reporting.
   */
  getSizeInfo(): OutputSizeInfo {
    const filtered = this.buildFilteredStdout();
    const filteredBytes = Buffer.byteLength(filtered, 'utf8');
    const savingsPercent = this.rawBytes > 0
      ? Math.round((1 - filteredBytes / this.rawBytes) * 100)
      : 0;

    return {
      rawBytes: this.rawBytes,
      filteredBytes,
      savingsPercent,
    };
  }
}
