// ============================================
// OpenSwarm - Trace Collector
// Span model and TraceCollector for agent execution tracing
// ============================================

import { randomUUID } from 'node:crypto';

const MAX_TRACE_NAME_BYTES = 1024;
const MAX_METADATA_BYTES = 4096;
const MAX_ERROR_BYTES = 4096;

function boundText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const char of value) {
    if (Buffer.byteLength(result + char + '…', 'utf8') > maxBytes) break;
    result += char;
  }
  return `${result}…`;
}

function boundMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    try {
      // Keep a JSON copy, not the caller's object: a reference could be
      // mutated after the check and grow past the bound. (#851 review)
      const value: unknown = raw !== null && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : raw;
      const encoded = JSON.stringify({ ...bounded, [key]: value });
      if (encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= MAX_METADATA_BYTES) bounded[key] = value;
      else if (typeof value === 'string') {
        const room = MAX_METADATA_BYTES - Buffer.byteLength(JSON.stringify(bounded), 'utf8') - Buffer.byteLength(JSON.stringify(key), 'utf8') - 8;
        const shortened = boundText(value, Math.max(0, room));
        const candidate = JSON.stringify({ ...bounded, [key]: shortened });
        if (candidate && Buffer.byteLength(candidate, 'utf8') <= MAX_METADATA_BYTES) bounded[key] = shortened;
      }
    } catch {
      // Ignore unserializable values rather than retaining them unchecked.
    }
  }
  return bounded;
}

function boundError(error: { message: string; stack?: string; code?: string }): { message: string; stack?: string; code?: string } {
  const result = {
    message: boundText(error.message, 1024),
    ...(error.stack === undefined ? {} : { stack: boundText(error.stack, 2048) }),
    ...(error.code === undefined ? {} : { code: boundText(error.code, 256) }),
  };
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_ERROR_BYTES
    ? result
    : { message: boundText(result.message, MAX_ERROR_BYTES - 16) };
}

// Types

export type SpanStatus = 'running' | 'completed' | 'failed';

/**
 * A single unit of work (tool call, agent run, etc.)
 */
export type Span = {
  /** Unique span ID */
  spanId: string;
  /** Owning trace ID */
  traceId: string;
  /** Parent span ID (root span if absent) */
  parentSpanId?: string;
  /** Span name (e.g. 'worker', 'tool:git-commit') */
  name: string;
  /** Status */
  status: SpanStatus;
  /** Start time (epoch ms) */
  startTime: number;
  /** End time (epoch ms) */
  endTime?: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Error info */
  errorInfo?: {
    message: string;
    stack?: string;
    code?: string;
  };
};

/**
 * Session-level trace (contains multiple spans)
 */
export type Trace = {
  /** trace ID */
  traceId: string;
  /** Trace name (e.g. session/issue identifier) */
  name: string;
  /** Start time */
  startTime: number;
  /** End time */
  endTime?: number;
  /** Status */
  status: SpanStatus;
  /** Owned span list */
  spans: Span[];
  /** Additional metadata (agent name, issue ID, etc.) */
  metadata: Record<string, unknown>;
};

// TraceCollector

/**
 * Agent execution trace collector
 *
 * Usage:
 *   const traceId = collector.startTrace('agent-run');
 *   const spanId = collector.startSpan(traceId, 'worker');
 *   const childId = collector.startSpan(traceId, 'tool:git', spanId);
 *   collector.endSpan(traceId, childId);
 *   collector.endSpan(traceId, spanId);
 *   collector.endTrace(traceId);
 */
export class TraceCollector {
  private traces = new Map<string, Trace>();

  constructor(
    private readonly maxTraces = 1_000,
    private readonly maxSpansPerTrace = 1_000,
  ) {
    if (!Number.isSafeInteger(maxTraces) || maxTraces <= 0 || !Number.isSafeInteger(maxSpansPerTrace) || maxSpansPerTrace <= 0) {
      throw new Error('Trace retention limits must be positive integers');
    }
  }

  /**
   * Start a new trace
   * @returns trace ID
   */
  startTrace(name: string, metadata: Record<string, unknown> = {}): string {
    if (this.traces.size >= this.maxTraces) {
      const completed = [...this.traces].find(([, trace]) => trace.status !== 'running');
      if (!completed) throw new Error(`Trace capacity exceeded (${this.maxTraces} active traces)`);
      this.traces.delete(completed[0]);
    }
    const traceId = randomUUID();
    const trace: Trace = {
      traceId,
      name: boundText(name, MAX_TRACE_NAME_BYTES),
      startTime: Date.now(),
      status: 'running',
      spans: [],
      metadata: boundMetadata(metadata),
    };
    this.traces.set(traceId, trace);
    return traceId;
  }

  /**
   * End a trace
   */
  endTrace(traceId: string, status: SpanStatus = 'completed'): Trace | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    if (trace.status !== 'running') return trace;
    if (status === 'running') throw new Error('endTrace requires a terminal status');

    trace.endTime = Date.now();
    trace.status = status;

    // End every span that is still running
    for (const span of trace.spans) {
      if (span.status === 'running') {
        span.endTime = trace.endTime;
        span.status = status;
      }
    }

    return trace;
  }

  /**
   * Start a new span within a trace
   * @param parentSpanId - parent span ID (for hierarchy)
   * @returns span ID
   */
  startSpan(
    traceId: string,
    name: string,
    parentSpanId?: string,
    metadata: Record<string, unknown> = {},
  ): string | undefined {
    const trace = this.traces.get(traceId);
    if (!trace || trace.status !== 'running') return undefined;
    if (trace.spans.length >= this.maxSpansPerTrace) {
      throw new Error(`Span capacity exceeded for trace ${traceId} (${this.maxSpansPerTrace})`);
    }

    const spanId = randomUUID();
    const span: Span = {
      spanId,
      traceId,
      parentSpanId,
      name: boundText(name, MAX_TRACE_NAME_BYTES),
      status: 'running',
      startTime: Date.now(),
      metadata: boundMetadata(metadata),
    };
    trace.spans.push(span);
    return spanId;
  }

  /**
   * End a span
   */
  endSpan(traceId: string, spanId: string, status: SpanStatus = 'completed'): Span | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return undefined;
    if (span.status !== 'running') return span;
    if (status === 'running') throw new Error('endSpan requires a terminal status');

    span.endTime = Date.now();
    span.status = status;
    return span;
  }

  /**
   * Record an error on a span
   */
  recordError(
    traceId: string,
    spanId: string,
    error: { message: string; stack?: string; code?: string },
  ): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return false;

    span.errorInfo = boundError(error);
    span.status = 'failed';
    span.endTime = span.endTime ?? Date.now();
    return true;
  }

  /**
   * Look up a trace
   */
  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * List the child spans of a given span
   */
  getChildSpans(traceId: string, parentSpanId: string): Span[] {
    const trace = this.traces.get(traceId);
    if (!trace) return [];
    return trace.spans.filter((s) => s.parentSpanId === parentSpanId);
  }

  /**
   * List all traces
   */
  getAllTraces(): Trace[] {
    return Array.from(this.traces.values());
  }

  /**
   * Remove completed traces (memory management)
   */
  pruneCompleted(): number {
    let pruned = 0;
    for (const [id, trace] of this.traces) {
      if (trace.status !== 'running') {
        this.traces.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
