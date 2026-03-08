// Created: 2026-03-07
// Purpose: Unit tests for agentPair module
// Test Status: Complete

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createPairSession,
  getPairSession,
  getActiveSessions,
  updateSessionStatus,
  setSessionThreadId,
  saveWorkerResult,
  saveReviewerResult,
  addMessage,
  cancelSession,
  canRetry,
  getSessionHistory,
  clearAllSessions,
  calculateConfidence,
  updateConfidenceTracker,
  needsConfidenceIntervention,
  getConfidenceSummary,
  trackFailure,
  resetFailureStreak,
  shouldUseFreshContext,
  consumeFreshContext,
  formatSessionSummary,
  formatDiscussion,
  CONFIDENCE_THRESHOLDS,
  type WorkerResult,
  type ReviewResult,
} from './agentPair.js';

describe('agentPair', () => {
  beforeEach(() => {
    clearAllSessions();
  });

  afterEach(() => {
    clearAllSessions();
  });

  describe('Session Management', () => {
    it('should create a new pair session', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      expect(session.id).toBeDefined();
      expect(session.taskId).toBe('INT-123');
      expect(session.status).toBe('pending');
      expect(session.worker.attempts).toBe(0);
      expect(session.worker.maxAttempts).toBe(3);
    });

    it('should get session by ID', () => {
      const created = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const retrieved = getPairSession(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent session', () => {
      const session = getPairSession('non-existent');
      expect(session).toBeUndefined();
    });

    it('should list only active sessions', () => {
      const session1 = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Task 1',
        taskDescription: 'Desc 1',
        projectPath: '/tmp/p1',
      });
      const session2 = createPairSession({
        taskId: 'INT-124',
        taskTitle: 'Task 2',
        taskDescription: 'Desc 2',
        projectPath: '/tmp/p2',
      });

      updateSessionStatus(session2.id, 'approved');
      const active = getActiveSessions();

      expect(active.length).toBe(1);
      expect(active[0].id).toBe(session1.id);
    });

    it('should update session status', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const updated = updateSessionStatus(session.id, 'working');
      expect(updated?.status).toBe('working');

      const retrieved = getPairSession(session.id);
      expect(retrieved?.status).toBe('working');
    });

    it('should archive session when completed', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      updateSessionStatus(session.id, 'approved');
      const active = getActiveSessions();

      expect(active).not.toContainEqual(
        expect.objectContaining({ id: session.id })
      );
    });

    it('should set discord thread ID', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const updated = setSessionThreadId(session.id, 'thread-123');
      expect(updated?.threadId).toBe('thread-123');
    });
  });

  describe('Worker Result Handling', () => {
    it('should save worker result', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file1.ts', 'file2.ts'],
        commands: ['npm test'],
        output: 'All tests passed',
      };

      const updated = saveWorkerResult(session.id, result);
      expect(updated?.worker.result).toEqual(result);
      expect(updated?.worker.attempts).toBe(1);
    });

    it('should increment attempt count on multiple saves', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      saveWorkerResult(session.id, result);
      saveWorkerResult(session.id, result);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.worker.attempts).toBe(2);
    });

    it('should add message when saving worker result', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
      };

      saveWorkerResult(session.id, result);
      const retrieved = getPairSession(session.id);

      expect(retrieved?.messages).toBeDefined();
      expect(retrieved!.messages.length).toBeGreaterThan(0);
      expect(retrieved!.messages[0].role).toBe('worker');
    });
  });

  describe('Reviewer Result Handling', () => {
    it('should save reviewer result', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const review: ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good',
      };

      const updated = saveReviewerResult(session.id, review);
      expect(updated?.reviewer.feedback).toEqual(review);
    });

    it('should save reviewer result with issues and suggestions', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const review: ReviewResult = {
        decision: 'revise',
        feedback: 'Needs work',
        issues: ['Issue 1', 'Issue 2'],
        suggestions: ['Suggestion 1'],
      };

      saveReviewerResult(session.id, review);
      const retrieved = getPairSession(session.id);

      expect(retrieved?.reviewer.feedback?.issues).toEqual(['Issue 1', 'Issue 2']);
      expect(retrieved?.reviewer.feedback?.suggestions).toEqual(['Suggestion 1']);
    });
  });

  describe('Message Handling', () => {
    it('should add message to session', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      addMessage(session.id, 'worker', 'Test message');

      const retrieved = getPairSession(session.id);
      expect(retrieved?.messages.length).toBe(1);
      expect(retrieved?.messages[0].content).toBe('Test message');
    });

    it('should have timestamps for messages', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const beforeTime = Date.now();
      addMessage(session.id, 'worker', 'Test message');
      const afterTime = Date.now();

      const retrieved = getPairSession(session.id);
      expect(retrieved?.messages[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(retrieved?.messages[0].timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('Session Cancellation', () => {
    it('should not cancel non-existent session', () => {
      const cancelled = cancelSession('non-existent-id');
      expect(cancelled).toBe(false);
    });

    it('should not cancel already completed session', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      updateSessionStatus(session.id, 'approved');
      const cancelled = cancelSession(session.id);

      expect(cancelled).toBe(false);
    });
  });

  describe('Retry Logic', () => {
    it('should allow retry when attempts < maxAttempts', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
        maxAttempts: 3,
      });

      expect(canRetry(session.id)).toBe(true);

      const result: WorkerResult = {
        success: false,
        summary: 'Failed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      saveWorkerResult(session.id, result);
      expect(canRetry(session.id)).toBe(true);
    });

    it('should deny retry when maxAttempts exceeded', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
        maxAttempts: 2,
      });

      const result: WorkerResult = {
        success: false,
        summary: 'Failed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      saveWorkerResult(session.id, result);
      saveWorkerResult(session.id, result);

      expect(canRetry(session.id)).toBe(false);
    });
  });

  describe('Session History', () => {
    it('should maintain history of completed sessions', () => {
      const session1 = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Task 1',
        taskDescription: 'Desc 1',
        projectPath: '/tmp/p1',
      });

      updateSessionStatus(session1.id, 'approved');

      const history = getSessionHistory(10);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].id).toBe(session1.id);
    });

    it('should limit history by provided limit', () => {
      for (let i = 0; i < 5; i++) {
        const session = createPairSession({
          taskId: `INT-${i}`,
          taskTitle: `Task ${i}`,
          taskDescription: `Desc ${i}`,
          projectPath: `/tmp/p${i}`,
        });
        updateSessionStatus(session.id, 'approved');
      }

      const history = getSessionHistory(2);
      expect(history.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Confidence Calculation', () => {
    it('should calculate confidence from explicit confidencePercent', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidencePercent: 85,
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBe(85);
    });

    it('should calculate confidence from legacy ConfidenceLevel', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidence: 3, // High confidence
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBe(100);
    });

    it('should return 0 for failed results', () => {
      const result: WorkerResult = {
        success: false,
        summary: 'Task failed',
        filesChanged: [],
        commands: [],
        output: 'Error',
        error: 'Something went wrong',
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBe(0);
    });

    it('should penalize missing file changes', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: 'Success with good length output text content here to avoid short output penalty',
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBeLessThan(100);
      expect(confidence).toBeGreaterThan(0);
    });

    it('should penalize uncertainty words', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed, maybe it works',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success but I think there might be some issues',
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBeLessThan(100);
    });

    it('should penalize explicit halt reason', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        haltReason: 'Could not proceed',
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBeLessThan(100);
    });

    it('should clamp confidence between 0-100', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidencePercent: 150,
      };

      const confidence = calculateConfidence(result);
      expect(confidence).toBeLessThanOrEqual(100);
      expect(confidence).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Confidence Tracking', () => {
    it('should update confidence tracker with new result', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidencePercent: 85,
      };

      updateConfidenceTracker(session.id, result, 1);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.confidenceTracker).toBeDefined();
      expect(retrieved?.confidenceTracker?.history.length).toBe(1);
      expect(retrieved?.confidenceTracker?.lastConfidence).toBe(85);
    });

    it('should detect low confidence streak', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      for (let i = 0; i < 3; i++) {
        const result: WorkerResult = {
          success: true,
          summary: 'Task completed maybe',
          filesChanged: [],
          commands: [],
          output: 'Short',
          confidencePercent: 30,
        };
        updateConfidenceTracker(session.id, result, i + 1);
      }

      const needsIntervention = needsConfidenceIntervention(session.id);
      expect(needsIntervention).toBe(true);
    });

    it('should detect sudden confidence drop', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result1: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidencePercent: 85,
      };

      const result2: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: 'Short',
        confidencePercent: 20,
      };

      updateConfidenceTracker(session.id, result1, 1);
      updateConfidenceTracker(session.id, result2, 2);

      const needsIntervention = needsConfidenceIntervention(session.id);
      expect(needsIntervention).toBe(true);
    });

    it('should provide confidence summary', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: 'Success',
        confidencePercent: 85,
      };

      updateConfidenceTracker(session.id, result, 1);

      const summary = getConfidenceSummary(session.id);
      expect(summary).toContain('85%');
    });
  });

  describe('Fresh Context Strategy', () => {
    it('should track failure streak', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      trackFailure(session.id);
      trackFailure(session.id);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.worker.failureStreak).toBe(2);
    });

    it('should trigger fresh context after threshold', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      trackFailure(session.id);
      trackFailure(session.id);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.worker.useFreshContext).toBe(true);
    });

    it('should reset failure streak on success', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      trackFailure(session.id);
      trackFailure(session.id);
      resetFailureStreak(session.id);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.worker.failureStreak).toBe(0);
      expect(retrieved?.worker.useFreshContext).toBe(false);
    });

    it('should check if fresh context should be used', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      trackFailure(session.id);
      trackFailure(session.id);

      expect(shouldUseFreshContext(session.id)).toBe(true);
    });

    it('should consume fresh context flag', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      trackFailure(session.id);
      trackFailure(session.id);
      consumeFreshContext(session.id);

      const retrieved = getPairSession(session.id);
      expect(retrieved?.worker.useFreshContext).toBe(false);
    });
  });

  describe('Formatting', () => {
    it('should format session summary', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const summary = formatSessionSummary(session);
      expect(summary).toContain('Test Task');
      expect(summary).toContain('INT-123');
      expect(summary).toContain('pending');
    });

    it('should format discussion history', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      addMessage(session.id, 'worker', 'Worker message');
      addMessage(session.id, 'reviewer', 'Reviewer message');

      const retrieved = getPairSession(session.id);
      const discussion = formatDiscussion(retrieved!);

      expect(discussion).toContain('Worker message');
      expect(discussion).toContain('Reviewer message');
      expect(discussion).toContain('WORKER');
      expect(discussion).toContain('REVIEWER');
    });

    it('should handle empty discussion history', () => {
      const session = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      const discussion = formatDiscussion(session);
      expect(discussion).toContain('No discussion history');
    });
  });

  describe('Constants', () => {
    it('should define confidence thresholds', () => {
      expect(CONFIDENCE_THRESHOLDS.PROCEED).toBe(80);
      expect(CONFIDENCE_THRESHOLDS.CAUTIOUS).toBe(60);
      expect(CONFIDENCE_THRESHOLDS.HALT).toBe(60);
    });
  });

  describe('Edge Cases', () => {
    it('should handle operations on non-existent session', () => {
      const result = updateSessionStatus('non-existent', 'approved');
      expect(result).toBeUndefined();
    });

    it('should handle clear all sessions', () => {
      createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      });

      clearAllSessions();

      const active = getActiveSessions();
      expect(active.length).toBe(0);

      const history = getSessionHistory();
      expect(history.length).toBe(0);
    });

    it('should generate unique session IDs', () => {
      const session1 = createPairSession({
        taskId: 'INT-123',
        taskTitle: 'Test Task 1',
        taskDescription: 'Desc 1',
        projectPath: '/tmp/p1',
      });

      const session2 = createPairSession({
        taskId: 'INT-124',
        taskTitle: 'Test Task 2',
        taskDescription: 'Desc 2',
        projectPath: '/tmp/p2',
      });

      expect(session1.id).not.toBe(session2.id);
    });
  });
});
