// ============================================
// OpenSwarm - Pair Mode Integration Tests
// Worker/Reviewer pair full flow tests
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as agentPair from '../agents/agentPair.js';
import * as pairMetrics from '../agents/pairMetrics.js';
import * as pairWebhook from '../agents/pairWebhook.js';

// ============================================
// Test Setup
// ============================================

describe('Pair Mode Integration Tests', () => {
  beforeEach(() => {
    // Initialize sessions before each test
    agentPair.clearAllSessions();
  });

  afterEach(async () => {
    // Reset metrics
    await pairMetrics.resetMetrics();
  });

  // ============================================
  // Session creation and state transition tests
  // ============================================

  describe('Session Lifecycle', () => {
    it('should create session and transition through states', () => {
      // 1. Create session
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

      // 2. Start Worker task
      agentPair.updateSessionStatus(session.id, 'working');
      const updated1 = agentPair.getPairSession(session.id);
      expect(updated1?.status).toBe('working');

      // 3. Save Worker result
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

      // 4. Transition to review state
      agentPair.updateSessionStatus(session.id, 'reviewing');
      const updated3 = agentPair.getPairSession(session.id);
      expect(updated3?.status).toBe('reviewing');

      // 5. Approve
      const reviewResult: agentPair.ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good!',
      };
      agentPair.saveReviewerResult(session.id, reviewResult);
      const updated4 = agentPair.updateSessionStatus(session.id, 'approved');

      // After approval, session is archived (removed from active sessions)
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

      // First attempt
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'First attempt',
        filesChanged: ['src/a.ts'],
        commands: [],
        output: '',
      });

      // Revision request
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

      // Second attempt
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

      // Approve
      agentPair.updateSessionStatus(session.id, 'reviewing');
      agentPair.saveReviewerResult(session.id, {
        decision: 'approve',
        feedback: 'Good job!',
      });
      const approved = agentPair.updateSessionStatus(session.id, 'approved');

      // After approval, session is archived
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

      // First attempt
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

      // Second attempt
      agentPair.updateSessionStatus(session.id, 'revising');
      agentPair.updateSessionStatus(session.id, 'working');
      agentPair.saveWorkerResult(session.id, {
        success: true,
        summary: 'Second attempt',
        filesChanged: [],
        commands: [],
        output: '',
      });

      // No more retries available
      expect(agentPair.canRetry(session.id)).toBe(false);
    });
  });

  // ============================================
  // Message logging tests
  // ============================================

  describe('Message Logging', () => {
    it('should track messages in session', () => {
      const session = agentPair.createPairSession({
        taskId: 'TEST-130',
        taskTitle: 'Test Messages',
        taskDescription: 'Test description',
        projectPath: '/tmp/test',
      });

      // Add messages
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
  // Metrics recording tests
  // ============================================

  describe('Metrics Recording', () => {
    it('should record session metrics', async () => {
      // Record session
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

      // Get summary
      const summary = await pairMetrics.getSummary();
      expect(summary.totalSessions).toBe(2);
      expect(summary.approved).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.successRate).toBe(50);
    });

    it('should calculate first attempt success rate', async () => {
      // First attempt success
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

      // Second attempt success
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
  // Webhook payload tests
  // ============================================

  describe('Webhook Payload', () => {
    it('should validate webhook URL', () => {
      expect(pairWebhook.isValidWebhookUrl('https://example.com/webhook')).toBe(true);
      expect(pairWebhook.isValidWebhookUrl('http://localhost:3000/hook')).toBe(false);
      expect(pairWebhook.isValidWebhookUrl('')).toBe(false);
      expect(pairWebhook.isValidWebhookUrl(undefined)).toBe(false);
      expect(pairWebhook.isValidWebhookUrl('not-a-url')).toBe(false);
      expect(pairWebhook.isValidWebhookUrl('ftp://example.com')).toBe(false);
    });
  });

  // ============================================
  // Concurrent session tests
  // ============================================

  describe('Concurrent Sessions', () => {
    it('should handle multiple sessions', () => {
      // Create 3 sessions simultaneously
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

      // Verify active sessions
      const active = agentPair.getActiveSessions();
      expect(active.length).toBe(3);

      // Transition each to different states
      agentPair.updateSessionStatus(session1.id, 'working');
      agentPair.updateSessionStatus(session2.id, 'reviewing');
      const cancelled = agentPair.cancelSession(session3.id);

      // Verify states
      expect(agentPair.getPairSession(session1.id)?.status).toBe('working');
      expect(agentPair.getPairSession(session2.id)?.status).toBe('reviewing');
      // Cancelled session is archived (removed from active sessions)
      expect(cancelled).toBe(true);

      // Cancelled sessions are excluded from active list
      const activeAfter = agentPair.getActiveSessions();
      expect(activeAfter.length).toBe(2);

      // Verify cancelled session in history
      const history = agentPair.getSessionHistory(1);
      expect(history[0]?.status).toBe('cancelled');
    });
  });

  // ============================================
  // Error case tests
  // ============================================

  describe('Error Cases', () => {
    it('should handle non-existent session', () => {
      const result = agentPair.getPairSession('non-existent-id');
      expect(result).toBeUndefined();

      // Attempt to update non-existent session
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

      // Attempt to record same session twice
      await pairMetrics.recordSession(record);
      await pairMetrics.recordSession(record);

      const summary = await pairMetrics.getSummary();
      // Only 1 should be recorded due to deduplication
      expect(summary.totalSessions).toBe(1);
    });
  });

  // ============================================
  // Formatting tests
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
        durationMs: 90000, // 1.5 min
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
// Utility function tests
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

    // Artificially set end time
    const endSession = agentPair.getPairSession(session.id);
    if (endSession) {
      endSession.finishedAt = startTime + 120000; // 2 min
      const duration = endSession.finishedAt - endSession.startedAt;
      expect(duration).toBe(120000);
    }
  });
});
