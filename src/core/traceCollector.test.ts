import { describe, it, expect, beforeEach } from 'vitest';
import { TraceCollector } from './traceCollector.js';
import type { Trace, Span } from './traceCollector.js';

describe('TraceCollector', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
  });

  // ============================================
  // Trace 생성/종료
  // ============================================

  describe('startTrace / endTrace', () => {
    it('trace를 생성하고 ID를 반환해야 한다', () => {
      const traceId = collector.startTrace('test-session');
      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe('string');
    });

    it('생성된 trace는 running 상태여야 한다', () => {
      const traceId = collector.startTrace('test-session');
      const trace = collector.getTrace(traceId);
      expect(trace).toBeDefined();
      expect(trace!.status).toBe('running');
      expect(trace!.name).toBe('test-session');
      expect(trace!.startTime).toBeGreaterThan(0);
      expect(trace!.endTime).toBeUndefined();
    });

    it('metadata가 저장되어야 한다', () => {
      const traceId = collector.startTrace('test', { agentName: 'worker', issueId: 'INT-100' });
      const trace = collector.getTrace(traceId);
      expect(trace!.metadata.agentName).toBe('worker');
      expect(trace!.metadata.issueId).toBe('INT-100');
    });

    it('trace를 종료하면 completed 상태가 되어야 한다', () => {
      const traceId = collector.startTrace('test-session');
      const trace = collector.endTrace(traceId);
      expect(trace).toBeDefined();
      expect(trace!.status).toBe('completed');
      expect(trace!.endTime).toBeGreaterThan(0);
    });

    it('trace 종료 시 커스텀 상태를 지정할 수 있어야 한다', () => {
      const traceId = collector.startTrace('test-session');
      const trace = collector.endTrace(traceId, 'failed');
      expect(trace!.status).toBe('failed');
    });

    it('존재하지 않는 trace를 종료하면 undefined를 반환해야 한다', () => {
      const result = collector.endTrace('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ============================================
  // Span 생성/종료
  // ============================================

  describe('startSpan / endSpan', () => {
    it('span을 생성하고 ID를 반환해야 한다', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker');
      expect(spanId).toBeDefined();
      expect(typeof spanId).toBe('string');
    });

    it('생성된 span이 trace에 포함되어야 한다', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker');
      const trace = collector.getTrace(traceId);
      expect(trace!.spans).toHaveLength(1);
      expect(trace!.spans[0].spanId).toBe(spanId);
      expect(trace!.spans[0].name).toBe('worker');
      expect(trace!.spans[0].status).toBe('running');
    });

    it('존재하지 않는 trace에 span을 추가하면 undefined를 반환해야 한다', () => {
      const result = collector.startSpan('nonexistent', 'worker');
      expect(result).toBeUndefined();
    });

    it('span을 종료하면 completed 상태가 되어야 한다', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;
      const span = collector.endSpan(traceId, spanId);
      expect(span).toBeDefined();
      expect(span!.status).toBe('completed');
      expect(span!.endTime).toBeGreaterThan(0);
    });

    it('존재하지 않는 span을 종료하면 undefined를 반환해야 한다', () => {
      const traceId = collector.startTrace('session');
      const result = collector.endSpan(traceId, 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ============================================
  // Parent-Child 관계
  // ============================================

  describe('parent-child span 관계', () => {
    it('child span이 parent를 참조해야 한다', () => {
      const traceId = collector.startTrace('session');
      const parentId = collector.startSpan(traceId, 'agent')!;
      const childId = collector.startSpan(traceId, 'tool:git', parentId)!;

      const trace = collector.getTrace(traceId);
      const child = trace!.spans.find((s) => s.spanId === childId);
      expect(child!.parentSpanId).toBe(parentId);
    });

    it('getChildSpans로 자식 span을 조회할 수 있어야 한다', () => {
      const traceId = collector.startTrace('session');
      const parentId = collector.startSpan(traceId, 'agent')!;
      collector.startSpan(traceId, 'tool:git', parentId);
      collector.startSpan(traceId, 'tool:test', parentId);
      collector.startSpan(traceId, 'other-root'); // 부모 없는 span

      const children = collector.getChildSpans(traceId, parentId);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.name)).toContain('tool:git');
      expect(children.map((c) => c.name)).toContain('tool:test');
    });

    it('3단계 계층 구조를 지원해야 한다 (trace → agent → tool)', () => {
      const traceId = collector.startTrace('session');
      const agentSpan = collector.startSpan(traceId, 'agent')!;
      const toolSpan = collector.startSpan(traceId, 'tool:lint', agentSpan)!;

      // tool span의 parent는 agent span
      const trace = collector.getTrace(traceId);
      const tool = trace!.spans.find((s) => s.spanId === toolSpan);
      expect(tool!.parentSpanId).toBe(agentSpan);

      // agent span의 parent는 없음 (root)
      const agent = trace!.spans.find((s) => s.spanId === agentSpan);
      expect(agent!.parentSpanId).toBeUndefined();
    });

    it('존재하지 않는 trace의 자식 span 조회는 빈 배열을 반환해야 한다', () => {
      const result = collector.getChildSpans('nonexistent', 'any');
      expect(result).toEqual([]);
    });
  });

  // ============================================
  // 에러 기록
  // ============================================

  describe('recordError', () => {
    it('span에 에러를 기록해야 한다', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      const result = collector.recordError(traceId, spanId, {
        message: 'Test failed',
        stack: 'Error: Test failed\n    at ...',
        code: 'TEST_FAILURE',
      });

      expect(result).toBe(true);
      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      expect(span.status).toBe('failed');
      expect(span.errorInfo).toBeDefined();
      expect(span.errorInfo!.message).toBe('Test failed');
      expect(span.errorInfo!.code).toBe('TEST_FAILURE');
      expect(span.endTime).toBeGreaterThan(0);
    });

    it('존재하지 않는 trace에 에러 기록 시 false를 반환해야 한다', () => {
      const result = collector.recordError('nonexistent', 'any', { message: 'err' });
      expect(result).toBe(false);
    });

    it('존재하지 않는 span에 에러 기록 시 false를 반환해야 한다', () => {
      const traceId = collector.startTrace('session');
      const result = collector.recordError(traceId, 'nonexistent', { message: 'err' });
      expect(result).toBe(false);
    });
  });

  // ============================================
  // trace 종료 시 running span 자동 종료
  // ============================================

  describe('trace 종료 시 running span 정리', () => {
    it('trace 종료 시 running 상태 span이 모두 종료되어야 한다', () => {
      const traceId = collector.startTrace('session');
      collector.startSpan(traceId, 'span1');
      collector.startSpan(traceId, 'span2');

      collector.endTrace(traceId);
      const trace = collector.getTrace(traceId);

      for (const span of trace!.spans) {
        expect(span.status).not.toBe('running');
        expect(span.endTime).toBeGreaterThan(0);
      }
    });

    it('이미 종료된 span은 상태가 유지되어야 한다', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'span1')!;
      collector.endSpan(traceId, spanId, 'failed');

      collector.endTrace(traceId, 'completed');
      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      // 이미 failed인 span은 그대로 유지
      expect(span.status).toBe('failed');
    });
  });

  // ============================================
  // 전체 목록 및 정리
  // ============================================

  describe('getAllTraces / pruneCompleted', () => {
    it('모든 trace를 조회할 수 있어야 한다', () => {
      collector.startTrace('session1');
      collector.startTrace('session2');
      collector.startTrace('session3');

      const all = collector.getAllTraces();
      expect(all).toHaveLength(3);
    });

    it('완료된 trace만 정리해야 한다', () => {
      const t1 = collector.startTrace('done1');
      const t2 = collector.startTrace('running1');
      const t3 = collector.startTrace('done2');

      collector.endTrace(t1);
      collector.endTrace(t3, 'failed');
      // t2는 running 상태

      const pruned = collector.pruneCompleted();
      expect(pruned).toBe(2);

      const remaining = collector.getAllTraces();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].traceId).toBe(t2);
    });
  });
});
