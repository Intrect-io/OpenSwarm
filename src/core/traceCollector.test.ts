import { describe, it, expect, beforeEach } from 'vitest';
import { TraceCollector } from './traceCollector.js';

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

  // ============================================
  // Edge Cases and Stress Tests
  // ============================================

  describe('edge cases and stress tests', () => {
    it('should handle many spans in a single trace', () => {
      const traceId = collector.startTrace('heavy-session');
      const spanIds: string[] = [];

      for (let i = 0; i < 1000; i++) {
        const spanId = collector.startSpan(traceId, `span-${i}`);
        spanIds.push(spanId!);
      }

      const trace = collector.getTrace(traceId);
      expect(trace!.spans).toHaveLength(1000);
    });

    it('should handle deep span hierarchies', () => {
      const traceId = collector.startTrace('deep-session');
      let parentId: string | undefined;

      // Create 50-level deep hierarchy
      for (let i = 0; i < 50; i++) {
        parentId = collector.startSpan(traceId, `level-${i}`, parentId);
      }

      const trace = collector.getTrace(traceId);
      expect(trace!.spans).toHaveLength(50);

      // Verify hierarchy
      const leaf = trace!.spans[trace!.spans.length - 1];
      expect(leaf.parentSpanId).toBeDefined();
    });

    it('should handle many concurrent traces', () => {
      const traceIds: string[] = [];

      for (let i = 0; i < 100; i++) {
        const traceId = collector.startTrace(`session-${i}`);
        traceIds.push(traceId);
      }

      const all = collector.getAllTraces();
      expect(all).toHaveLength(100);
    });

    it('should handle span metadata with complex structures', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker', undefined, {
        nested: {
          object: {
            with: {
              deep: {
                structure: [1, 2, 3, 4, 5],
              },
            },
          },
        },
        array: [{ item: 1 }, { item: 2 }, { item: 3 }],
        number: 12345,
        string: 'value',
        boolean: true,
        null_value: null,
      });

      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      expect(span.metadata.nested).toBeDefined();
      expect(span.metadata.array).toHaveLength(3);
    });

    it('should handle very large metadata values', () => {
      const traceId = collector.startTrace('session');
      const largeString = 'A'.repeat(100000);
      const spanId = collector.startSpan(traceId, 'worker', undefined, {
        largeData: largeString,
      });

      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      expect((span.metadata.largeData as string).length).toBe(100000);
    });

    it('should handle special characters in span names and traces', () => {
      const specialName = 'session-with-special_chars';
      const traceId = collector.startTrace(specialName);
      const spanId = collector.startSpan(traceId, 'tool:git:special_chars');

      const trace = collector.getTrace(traceId);
      expect(trace!.name).toBe(specialName);
      expect(trace!.spans[0].name).toContain('special_chars');
    });

    it('should handle recordError on already-ended span', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      // First end the span normally
      collector.endSpan(traceId, spanId, 'completed');

      // Then try to record error (should still work)
      const result = collector.recordError(traceId, spanId, {
        message: 'Error after completion',
      });

      expect(result).toBe(true);
      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      expect(span.status).toBe('failed');
    });

    it('should handle recordError with missing optional fields', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      const result = collector.recordError(traceId, spanId, {
        message: 'Simple error',
      });

      expect(result).toBe(true);
      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      expect(span.errorInfo?.message).toBe('Simple error');
      expect(span.errorInfo?.stack).toBeUndefined();
      expect(span.errorInfo?.code).toBeUndefined();
    });

    it('should handle endSpan on already-ended span', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      const firstEnd = collector.endSpan(traceId, spanId);
      expect(firstEnd).toBeDefined();

      const secondEnd = collector.endSpan(traceId, spanId);
      expect(secondEnd).toBeDefined();
      // Should still return the span
      expect(secondEnd!.status).toBe('completed');
    });

    it('should handle endTrace on already-ended trace', () => {
      const traceId = collector.startTrace('session');

      const firstEnd = collector.endTrace(traceId);
      expect(firstEnd).toBeDefined();

      const secondEnd = collector.endTrace(traceId);
      expect(secondEnd).toBeDefined();
    });

    it('should preserve span timing accuracy', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      const beforeEnd = Date.now();
      collector.endSpan(traceId, spanId);
      const afterEnd = Date.now();

      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];

      expect(span.endTime!).toBeGreaterThanOrEqual(beforeEnd);
      expect(span.endTime!).toBeLessThanOrEqual(afterEnd + 100); // 100ms tolerance
    });

    it('should handle getChildSpans with non-existent parent', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      const children = collector.getChildSpans(traceId, 'non-existent-parent');
      expect(children).toEqual([]);
    });

    it('should handle multiple error recordings on same span', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, 'worker')!;

      collector.recordError(traceId, spanId, { message: 'First error' });
      const secondRecord = collector.recordError(traceId, spanId, {
        message: 'Second error',
        code: 'ERR_OVERWRITE',
      });

      expect(secondRecord).toBe(true);
      const trace = collector.getTrace(traceId);
      const span = trace!.spans[0];
      // Should be overwritten with latest error
      expect(span.errorInfo?.message).toBe('Second error');
      expect(span.errorInfo?.code).toBe('ERR_OVERWRITE');
    });

    it('should handle pruneCompleted with mix of statuses', () => {
      const completed1 = collector.startTrace('completed1');
      const completed2 = collector.startTrace('completed2');
      const failed1 = collector.startTrace('failed1');
      const running1 = collector.startTrace('running1');
      const failed2 = collector.startTrace('failed2');

      collector.endTrace(completed1, 'completed');
      collector.endTrace(completed2, 'completed');
      collector.endTrace(failed1, 'failed');
      collector.endTrace(failed2, 'failed');
      // running1 stays running

      const pruned = collector.pruneCompleted();
      expect(pruned).toBe(4); // All non-running should be pruned

      const remaining = collector.getAllTraces();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('running');
    });

    it('should handle metadata with undefined values', () => {
      const traceId = collector.startTrace('session', {
        value1: 'defined',
        value2: undefined,
        value3: null,
      });

      const trace = collector.getTrace(traceId);
      expect(trace!.metadata.value1).toBe('defined');
      expect(trace!.metadata.value2).toBeUndefined();
      expect(trace!.metadata.value3).toBeNull();
    });

    it('should handle span timing when created close together', () => {
      const traceId = collector.startTrace('session');
      const spanIds: string[] = [];

      // Create 10 spans quickly
      for (let i = 0; i < 10; i++) {
        spanIds.push(collector.startSpan(traceId, `span-${i}`)!);
      }

      const trace = collector.getTrace(traceId);
      for (let i = 0; i < spanIds.length - 1; i++) {
        const currentSpan = trace!.spans[i];
        const nextSpan = trace!.spans[i + 1];
        // Next span should start at same time or later
        expect(nextSpan.startTime).toBeGreaterThanOrEqual(currentSpan.startTime);
      }
    });

    it('should handle empty trace name', () => {
      const traceId = collector.startTrace('');
      const trace = collector.getTrace(traceId);

      expect(trace).toBeDefined();
      expect(trace!.name).toBe('');
    });

    it('should handle empty span name', () => {
      const traceId = collector.startTrace('session');
      const spanId = collector.startSpan(traceId, '');

      const trace = collector.getTrace(traceId);
      expect(trace!.spans[0].name).toBe('');
    });

    it('should handle getChildSpans returning large result set', () => {
      const traceId = collector.startTrace('session');
      const parentId = collector.startSpan(traceId, 'parent')!;

      // Create 500 child spans
      for (let i = 0; i < 500; i++) {
        collector.startSpan(traceId, `child-${i}`, parentId);
      }

      const children = collector.getChildSpans(traceId, parentId);
      expect(children).toHaveLength(500);
    });
  });

  // ============================================
  // Memory and Performance
  // ============================================

  describe('memory and performance considerations', () => {
    it('should allow pruning to free memory', () => {
      const before = collector.getAllTraces().length;

      for (let i = 0; i < 100; i++) {
        const traceId = collector.startTrace(`session-${i}`);
        collector.endTrace(traceId);
      }

      const duringCompleted = collector.getAllTraces().filter((t) => t.status !== 'running').length;
      expect(duringCompleted).toBeGreaterThan(0);

      const pruned = collector.pruneCompleted();
      expect(pruned).toBeGreaterThan(0);

      const after = collector.getAllTraces().length;
      expect(after).toBeLessThan(duringCompleted + before);
    });

    it('should handle rapid start/end cycles', () => {
      for (let i = 0; i < 1000; i++) {
        const traceId = collector.startTrace(`quick-${i}`);
        const spanId = collector.startSpan(traceId, 'task');
        collector.endSpan(traceId, spanId!);
        collector.endTrace(traceId);
      }

      // Should be able to complete without issues
      const all = collector.getAllTraces();
      expect(all.length).toBeGreaterThan(0);
    });
  });
});
