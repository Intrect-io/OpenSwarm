// ============================================
// Claude Swarm - Pair Mode Integration Tests
// Worker/Reviewer 페어 전체 플로우 테스트
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as agentPair from './agentPair.js';
import * as pairMetrics from './pairMetrics.js';
import * as pairWebhook from './pairWebhook.js';

// ============================================
// Test Setup
// ============================================

describe('Pair Mode Integration Tests', () => {
  beforeEach(() => {
    // 각 테스트 전 세션 초기화
    agentPair.clearAllSessions();
  });

  afterEach(async () => {
    // 메트릭 초기화
    await pairMetrics.resetMetrics();
  });

  // ============================================
  // 세션 생성 및 상태 전이 테스트
  // ============================================

  describe('Session Lifecycle', () => {
    it('should create session and transition through states', () => {
      // 1. 세션 생성
      const session = agentPair.createPairSession({
        taskId: 'TEST-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
        maxAttempts: 3,
      });

      expect(session.status).toBe('pending');
      expect(session.worker.attempts).toBe(0);
      expect(session.worker.maxAttempts).toBe(3);

      // 2. Worker 작업 시작
      agentPair.updateSessionStatus(session.id, 'working');
      const updated1 = agentPair.getPairSession(session.id);
      expect(updated1?.status).toBe('working');

      // 3. Worker 결과 저장
      const workerResult: agentPair.WorkerResult = {
        success: true,
        summary: 'Added new feature',
        filesChanged: ['src/feature.ts'],
        commands: ['npm test'],
        output: 'Tests passed',
      };
      agentPair.saveWorkerResult(session.id, workerResult);

      const updated2 = agentPair.getPairSession(session.id);
      expect(updated2?.worker.attempts).toBe(1);
      expect(updated2?.worker.result).toEqual(workerResult);

      // 4. 리뷰 상태로 전환
      agentPair.updateSessionStatus(session.id, 'reviewing');
      const updated3 = agentPair.getPairSession(session.id);
      expect(updated3?.status).toBe('reviewing');

      // 5. 승인
      const reviewResult: agentPair.ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good!',
      };
      agentPair.saveReviewerResult(session.id, reviewResult);
      const updated4 = agentPair.updateSessionStatus(session.id, 'approved');

      // 승인 후 세션은 아카이브됨 (active sessions에서 제거)
      expect(updated4?.status).toBe('approved');
      expect(updated4?.reviewer.feedback?.decision).toBe('approve');
    });

    it('should handle revise cycle', () => {
      const session = agentPair.createPairSession({
        taskId: 'TEST-124',
        taskTitle: 'Test Revise',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
        maxAttempts: 3,
      });

      // 첫 번째 시도
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'First attempt',
        filesChanged: ['src/a.ts'],
        commands: [],
        output: '',
      });

      // 수정 요청
      agentPair.updateSessionStatus(session.id, 'reviewing');
      agentPair.saveReviewerResult(session.id, {
        decision: 'revise',
        feedback: 'Need error handling',
        issues: ['Missing try-catch'],
      });
      agentPair.updateSessionStatus(session.id, 'revising');

      let updated = agentPair.getPairSession(session.id);
      expect(updated?.status).toBe('revising');
      expect(agentPair.canRetry(session.id)).toBe(true);

      // 두 번째 시도
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'Second attempt with error handling',
        filesChanged: ['src/a.ts'],
        commands: [],
        output: '',
      });

      updated = agentPair.getPairSession(session.id);
      expect(updated?.worker.attempts).toBe(2);

      // 승인
      agentPair.updateSessionStatus(session.id, 'reviewing');
      agentPair.saveReviewerResult(session.id, {
        decision: 'approve',
        feedback: 'Good job!',
      });
      const approved = agentPair.updateSessionStatus(session.id, 'approved');

      // 승인 후 세션은 아카이브됨
      expect(approved?.status).toBe('approved');
    });

    it('should reject after max attempts', () => {
      const session = agentPair.createPairSession({
        taskId: 'TEST-125',
        taskTitle: 'Test Max Attempts',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
        maxAttempts: 2,
      });

      // 첫 번째 시도
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'First attempt',
        filesChanged: [],
        commands: [],
        output: '',
      });
      agentPair.saveReviewerResult(session.id, {
        decision: 'revise',
        feedback: 'Needs improvement',
      });
      expect(agentPair.canRetry(session.id)).toBe(true);

      // 두 번째 시도
      agentPair.updateSessionStatus(session.id, 'revising');
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'Second attempt',
        filesChanged: [],
        commands: [],
        output: '',
      });

      // 더 이상 재시도 불가
      expect(agentPair.canRetry(session.id)).toBe(false);
    });
  });

  // ============================================
  // 메시지 기록 테스트
  // ============================================

  describe('Message Logging', () => {
    it('should track messages in session', () => {
      const session = agentPair.createPairSession({
        taskId: 'TEST-130',
        taskTitle: 'Test Messages',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
      });

      // 메시지 추가
      agentPair.addMessage(session.id, 'worker', 'Starting work on feature...');
      agentPair.addMessage(session.id, 'worker', 'Completed implementation.');
      agentPair.addMessage(session.id, 'reviewer', 'Reviewing changes...');
      agentPair.addMessage(session.id, 'reviewer', 'Approved!');
      agentPair.addMessage(session.id, 'system', 'Session completed.');

      const updated = agentPair.getPairSession(session.id);
      expect(updated?.messages.length).toBe(5);
      expect(updated?.messages[0].role).toBe('worker');
      expect(updated?.messages[3].role).toBe('reviewer');
      expect(updated?.messages[4].role).toBe('system');
    });

    it('should format session summary correctly', () => {
      const session = agentPair.createPairSession({
        taskId: 'TEST-131',
        taskTitle: 'Test Summary Format',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
        maxAttempts: 3,
      });

      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'Added feature X',
        filesChanged: ['a.ts', 'b.ts'],
        commands: ['npm test'],
        output: 'All tests passed',
      });

      const summary = agentPair.formatSessionSummary(session);
      expect(summary).toContain('working');
      expect(summary).toContain('1/3');
    });
  });

  // ============================================
  // 메트릭 기록 테스트
  // ============================================

  describe('Metrics Recording', () => {
    it('should record session metrics', async () => {
      // 세션 기록
      await pairMetrics.recordSession({
        sessionId: 'test-1',
        taskId: 'TEST-200',
        taskTitle: 'Test Task',
        result: 'approved',
        attempts: 2,
        maxAttempts: 3,
        durationMs: 120000,
        filesChanged: 3,
        startedAt: Date.now() - 120000,
        finishedAt: Date.now(),
      });

      await pairMetrics.recordSession({
        sessionId: 'test-2',
        taskId: 'TEST-201',
        taskTitle: 'Test Task 2',
        result: 'rejected',
        attempts: 3,
        maxAttempts: 3,
        durationMs: 180000,
        filesChanged: 1,
        startedAt: Date.now() - 180000,
        finishedAt: Date.now(),
      });

      // 요약 조회
      const summary = await pairMetrics.getSummary();
      expect(summary.totalSessions).toBe(2);
      expect(summary.approved).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.successRate).toBe(50);
    });

    it('should calculate first attempt success rate', async () => {
      // 첫 시도 성공
      await pairMetrics.recordSession({
        sessionId: 'test-3',
        taskId: 'TEST-210',
        taskTitle: 'First Try Success',
        result: 'approved',
        attempts: 1,
        maxAttempts: 3,
        durationMs: 60000,
        filesChanged: 1,
        startedAt: Date.now() - 60000,
        finishedAt: Date.now(),
      });

      // 두 번째 시도 성공
      await pairMetrics.recordSession({
        sessionId: 'test-4',
        taskId: 'TEST-211',
        taskTitle: 'Second Try Success',
        result: 'approved',
        attempts: 2,
        maxAttempts: 3,
        durationMs: 120000,
        filesChanged: 2,
        startedAt: Date.now() - 120000,
        finishedAt: Date.now(),
      });

      const summary = await pairMetrics.getSummary();
      expect(summary.approved).toBe(2);
      expect(summary.firstAttemptSuccessRate).toBe(50); // 1/2 = 50%
    });

    it('should track daily metrics', async () => {
      await pairMetrics.recordSession({
        sessionId: 'test-5',
        taskId: 'TEST-220',
        taskTitle: 'Today Task',
        result: 'approved',
        attempts: 1,
        maxAttempts: 3,
        durationMs: 60000,
        filesChanged: 1,
        startedAt: Date.now() - 60000,
        finishedAt: Date.now(),
      });

      const daily = await pairMetrics.getDailyMetrics(7);
      expect(daily.length).toBeGreaterThanOrEqual(1);

      const today = new Date().toISOString().slice(0, 10);
      const todayMetrics = daily.find(d => d.date === today);
      expect(todayMetrics).toBeTruthy();
      expect(todayMetrics!.sessions).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================
  // Webhook 페이로드 테스트
  // ============================================

  describe('Webhook Payload', () => {
    it('should validate webhook URL', () => {
      expect(pairWebhook.isValidWebhookUrl('https://example.com/webhook')).toBe(true);
      expect(pairWebhook.isValidWebhookUrl('http://localhost:3000/hook')).toBe(true);
      expect(pairWebhook.isValidWebhookUrl('')).toBe(false);
      expect(pairWebhook.isValidWebhookUrl(undefined)).toBe(false);
      expect(pairWebhook.isValidWebhookUrl('not-a-url')).toBe(false);
      expect(pairWebhook.isValidWebhookUrl('ftp://example.com')).toBe(false);
    });
  });

  // ============================================
  // 동시 세션 테스트
  // ============================================

  describe('Concurrent Sessions', () => {
    it('should handle multiple sessions', () => {
      // 3개 세션 동시 생성
      const session1 = agentPair.createPairSession({
        taskId: 'TEST-300',
        taskTitle: 'Task 1',
        taskDescription: 'Desc 1',
        projectPath: '/tmp/test1',
      });
      const session2 = agentPair.createPairSession({
        taskId: 'TEST-301',
        taskTitle: 'Task 2',
        taskDescription: 'Desc 2',
        projectPath: '/tmp/test2',
      });
      const session3 = agentPair.createPairSession({
        taskId: 'TEST-302',
        taskTitle: 'Task 3',
        taskDescription: 'Desc 3',
        projectPath: '/tmp/test3',
      });

      // 활성 세션 확인
      const active = agentPair.getActiveSessions();
      expect(active.length).toBe(3);

      // 각각 다른 상태로 전환
      agentPair.updateSessionStatus(session1.id, 'working');
      agentPair.updateSessionStatus(session2.id, 'reviewing');
      const cancelled = agentPair.cancelSession(session3.id);

      // 상태 확인
      expect(agentPair.getPairSession(session1.id)?.status).toBe('working');
      expect(agentPair.getPairSession(session2.id)?.status).toBe('reviewing');
      // 취소된 세션은 아카이브됨 (active sessions에서 제거)
      expect(cancelled).toBe(true);

      // 취소된 세션은 활성 목록에서 제외
      const activeAfter = agentPair.getActiveSessions();
      expect(activeAfter.length).toBe(2);

      // 히스토리에서 취소된 세션 확인
      const history = agentPair.getSessionHistory(1);
      expect(history[0]?.status).toBe('cancelled');
    });
  });

  // ============================================
  // 에러 케이스 테스트
  // ============================================

  describe('Error Cases', () => {
    it('should handle non-existent session', () => {
      const result = agentPair.getPairSession('non-existent-id');
      expect(result).toBeUndefined();

      // 존재하지 않는 세션 업데이트 시도
      const updated = agentPair.updateSessionStatus('non-existent-id', 'working');
      expect(updated).toBeUndefined();
    });

    it('should not duplicate metrics records', async () => {
      const record = {
        sessionId: 'test-dup',
        taskId: 'TEST-400',
        taskTitle: 'Duplicate Test',
        result: 'approved' as const,
        attempts: 1,
        maxAttempts: 3,
        durationMs: 60000,
        filesChanged: 1,
        startedAt: Date.now() - 60000,
        finishedAt: Date.now(),
      };

      // 같은 세션 2번 기록 시도
      await pairMetrics.recordSession(record);
      await pairMetrics.recordSession(record);

      const summary = await pairMetrics.getSummary();
      // 중복 방지로 1개만 기록되어야 함
      expect(summary.totalSessions).toBe(1);
    });
  });

  // ============================================
  // 포맷팅 테스트
  // ============================================

  describe('Formatting', () => {
    it('should format metrics summary', async () => {
      await pairMetrics.recordSession({
        sessionId: 'test-fmt',
        taskId: 'TEST-500',
        taskTitle: 'Format Test',
        result: 'approved',
        attempts: 1,
        maxAttempts: 3,
        durationMs: 90000, // 1.5분
        filesChanged: 2,
        startedAt: Date.now() - 90000,
        finishedAt: Date.now(),
      });

      const summary = await pairMetrics.getSummary();
      const formatted = pairMetrics.formatMetricsSummary(summary);

      expect(formatted).toContain('Pair Mode Statistics');
      expect(formatted).toContain('Total sessions');
      expect(formatted).toContain('Success rate');
    });

    it('should format daily metrics', async () => {
      await pairMetrics.recordSession({
        sessionId: 'test-daily-fmt',
        taskId: 'TEST-501',
        taskTitle: 'Daily Format Test',
        result: 'approved',
        attempts: 1,
        maxAttempts: 3,
        durationMs: 60000,
        filesChanged: 1,
        startedAt: Date.now() - 60000,
        finishedAt: Date.now(),
      });

      const daily = await pairMetrics.getDailyMetrics(7);
      const formatted = pairMetrics.formatDailyMetrics(daily);

      expect(formatted).toContain('Daily Statistics');
    });
  });
});

// ============================================
// 유틸리티 함수 테스트
// ============================================

describe('Utility Functions', () => {
  beforeEach(() => {
    agentPair.clearAllSessions();
  });

  it('should calculate session duration', () => {
    const session = agentPair.createPairSession({
      taskId: 'TEST-600',
      taskTitle: 'Duration Test',
      taskDescription: 'Test',
      projectPath: '/tmp/test',
    });

    const startTime = session.startedAt;

    // 인위적으로 종료 시간 설정
    const endSession = agentPair.getPairSession(session.id);
    if (endSession) {
      endSession.finishedAt = startTime + 120000; // 2분
      const duration = endSession.finishedAt - endSession.startedAt;
      expect(duration).toBe(120000);
    }
  });
});
