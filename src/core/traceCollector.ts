// ============================================
// OpenSwarm - Trace Collector
// 에이전트 실행 추적을 위한 Span 모델 및 TraceCollector
// ============================================

import { randomUUID } from 'node:crypto';

// ============================================
// Types
// ============================================

export type SpanStatus = 'running' | 'completed' | 'failed';

/**
 * 개별 작업 단위 (도구 호출, 에이전트 실행 등)
 */
export type Span = {
  /** 고유 span ID */
  spanId: string;
  /** 소속 trace ID */
  traceId: string;
  /** 부모 span ID (없으면 root span) */
  parentSpanId?: string;
  /** span 이름 (예: 'worker', 'tool:git-commit') */
  name: string;
  /** 상태 */
  status: SpanStatus;
  /** 시작 시간 (epoch ms) */
  startTime: number;
  /** 종료 시간 (epoch ms) */
  endTime?: number;
  /** 추가 메타데이터 */
  metadata: Record<string, unknown>;
  /** 에러 정보 */
  errorInfo?: {
    message: string;
    stack?: string;
    code?: string;
  };
};

/**
 * 세션 레벨 trace (여러 span을 포함)
 */
export type Trace = {
  /** trace ID */
  traceId: string;
  /** trace 이름 (예: 세션/이슈 식별자) */
  name: string;
  /** 시작 시간 */
  startTime: number;
  /** 종료 시간 */
  endTime?: number;
  /** 상태 */
  status: SpanStatus;
  /** 소속 span 목록 */
  spans: Span[];
  /** 추가 메타데이터 (에이전트명, 이슈 ID 등) */
  metadata: Record<string, unknown>;
};

// ============================================
// TraceCollector
// ============================================

/**
 * 에이전트 실행 추적 수집기
 *
 * 사용법:
 *   const traceId = collector.startTrace('agent-run');
 *   const spanId = collector.startSpan(traceId, 'worker');
 *   const childId = collector.startSpan(traceId, 'tool:git', spanId);
 *   collector.endSpan(traceId, childId);
 *   collector.endSpan(traceId, spanId);
 *   collector.endTrace(traceId);
 */
export class TraceCollector {
  private traces = new Map<string, Trace>();

  /**
   * 새 trace 시작
   * @returns trace ID
   */
  startTrace(name: string, metadata: Record<string, unknown> = {}): string {
    const traceId = randomUUID();
    const trace: Trace = {
      traceId,
      name,
      startTime: Date.now(),
      status: 'running',
      spans: [],
      metadata,
    };
    this.traces.set(traceId, trace);
    return traceId;
  }

  /**
   * trace 종료
   */
  endTrace(traceId: string, status: SpanStatus = 'completed'): Trace | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    trace.endTime = Date.now();
    trace.status = status;

    // 아직 running인 span을 모두 종료
    for (const span of trace.spans) {
      if (span.status === 'running') {
        span.endTime = trace.endTime;
        span.status = status;
      }
    }

    return trace;
  }

  /**
   * trace 내에 새 span 시작
   * @param parentSpanId - 부모 span ID (계층 구조용)
   * @returns span ID
   */
  startSpan(
    traceId: string,
    name: string,
    parentSpanId?: string,
    metadata: Record<string, unknown> = {},
  ): string | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const spanId = randomUUID();
    const span: Span = {
      spanId,
      traceId,
      parentSpanId,
      name,
      status: 'running',
      startTime: Date.now(),
      metadata,
    };
    trace.spans.push(span);
    return spanId;
  }

  /**
   * span 종료
   */
  endSpan(traceId: string, spanId: string, status: SpanStatus = 'completed'): Span | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return undefined;

    span.endTime = Date.now();
    span.status = status;
    return span;
  }

  /**
   * span에 에러 기록
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

    span.errorInfo = error;
    span.status = 'failed';
    span.endTime = span.endTime ?? Date.now();
    return true;
  }

  /**
   * trace 조회
   */
  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * 특정 span의 자식 span 목록 조회
   */
  getChildSpans(traceId: string, parentSpanId: string): Span[] {
    const trace = this.traces.get(traceId);
    if (!trace) return [];
    return trace.spans.filter((s) => s.parentSpanId === parentSpanId);
  }

  /**
   * 모든 trace 목록 조회
   */
  getAllTraces(): Trace[] {
    return Array.from(this.traces.values());
  }

  /**
   * 완료된 trace 제거 (메모리 관리)
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
