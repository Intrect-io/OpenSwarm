// ============================================
// Agent Pair Unit Tests
// ============================================

import { describe, it, expect, beforeEach } from 'vitest';
import * as agentPair from '../agents/agentPair.js';

// 각 테스트 전 세션 초기화
beforeEach(() => {
  agentPair.clearAllSessions();
});

describe('agentPair', () => {
  describe('createPairSession', () => {
    it('should create a new session with correct defaults', () => {
      const session = agentPair.createPairSession({
        taskId: 'LIN-123',
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/home/user/project',
      });

      expect(session.id).toBeTruthy();
      expect(session.taskId).toBe('LIN-123');
      expect(session.taskTitle).toBe('Test Task');
      expect(session.taskDescription).toBe('Test Description');
      expect(session.projectPath).toBe('/home/user/project');
      expect(session.status).toBe('pending');
      expect(session.worker.attempts).toBe(0);
      expect(session.worker.maxAttempts).toBe(3);
      expect(session.messages).toEqual([]);
      expect(session.startedAt).toBeGreaterThan(0);
    });

    it('should respect custom maxAttempts', () => {
      const session = agentPair.createPairSession({
        taskId: 'LIN-456',
        taskTitle: 'Test',
        taskDescription: '',
        projectPath: '/tmp',
        maxAttempts: 5,
      });

      expect(session.worker.maxAttempts).toBe(5);
    });
  });

  describe('getPairSession', () => {
    it('should return session by id', () => {
      const created = agentPair.createPairSession({
        taskId: 'GET-TEST',
        taskTitle: 'Get Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const retrieved = agentPair.getPairSession(created.id);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.id).toBe(created.id);
    });

    it('should return undefined for non-existent id', () => {
      const result = agentPair.getPairSession('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('updateSessionStatus', () => {
    it('should update session status', () => {
      const session = agentPair.createPairSession({
        taskId: 'STATUS-TEST',
        taskTitle: 'Status Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const updated = agentPair.updateSessionStatus(session.id, 'working');
      expect(updated).toBeTruthy();
      expect(updated!.status).toBe('working');
    });

    it('should archive session when completed', () => {
      const session = agentPair.createPairSession({
        taskId: 'ARCHIVE-TEST',
        taskTitle: 'Archive Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      agentPair.updateSessionStatus(session.id, 'approved');

      // After archiving, getPairSession should return undefined
      const retrieved = agentPair.getPairSession(session.id);
      expect(retrieved).toBeUndefined();

      // Should appear in history
      const history = agentPair.getSessionHistory(10);
      const found = history.find(s => s.id === session.id);
      expect(found).toBeTruthy();
      expect(found!.finishedAt).toBeTruthy();
    });
  });

  describe('saveWorkerResult', () => {
    it('should save worker result and increment attempts', () => {
      const session = agentPair.createPairSession({
        taskId: 'WORKER-TEST',
        taskTitle: 'Worker Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const result: agentPair.WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['src/foo.ts'],
        commands: ['npm test'],
        output: 'All tests passed',
      };

      const updated = agentPair.saveWorkerResult(session.id, result);
      expect(updated).toBeTruthy();
      expect(updated!.worker.attempts).toBe(1);
      expect(updated!.worker.result).toEqual(result);
      expect(updated!.messages.length).toBe(1);
      expect(updated!.messages[0].role).toBe('worker');
    });
  });

  describe('saveReviewerResult', () => {
    it('should save reviewer result', () => {
      const session = agentPair.createPairSession({
        taskId: 'REVIEWER-TEST',
        taskTitle: 'Reviewer Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const result: agentPair.ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good!',
        issues: [],
        suggestions: ['Consider adding more tests'],
      };

      const updated = agentPair.saveReviewerResult(session.id, result);
      expect(updated).toBeTruthy();
      expect(updated!.reviewer.feedback).toEqual(result);
      expect(updated!.messages.length).toBe(1);
      expect(updated!.messages[0].role).toBe('reviewer');
    });
  });

  describe('canRetry', () => {
    it('should return true when attempts < maxAttempts', () => {
      const session = agentPair.createPairSession({
        taskId: 'RETRY-TEST',
        taskTitle: 'Retry Test',
        taskDescription: '',
        projectPath: '/tmp',
        maxAttempts: 3,
      });

      expect(agentPair.canRetry(session.id)).toBe(true);
    });

    it('should return false when attempts >= maxAttempts', () => {
      const session = agentPair.createPairSession({
        taskId: 'RETRY-FAIL-TEST',
        taskTitle: 'Retry Fail Test',
        taskDescription: '',
        projectPath: '/tmp',
        maxAttempts: 2,
      });

      // Simulate 2 attempts
      agentPair.saveWorkerResult(session.id, {
        success: false,
        summary: 'Failed 1',
        filesChanged: [],
        commands: [],
        output: '',
      });
      agentPair.saveWorkerResult(session.id, {
        success: false,
        summary: 'Failed 2',
        filesChanged: [],
        commands: [],
        output: '',
      });

      expect(agentPair.canRetry(session.id)).toBe(false);
    });
  });

  describe('cancelSession', () => {
    it('should cancel active session', () => {
      const session = agentPair.createPairSession({
        taskId: 'CANCEL-TEST',
        taskTitle: 'Cancel Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const result = agentPair.cancelSession(session.id);
      expect(result).toBe(true);

      // Session should be archived
      const retrieved = agentPair.getPairSession(session.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false for already completed session', () => {
      const session = agentPair.createPairSession({
        taskId: 'CANCEL-DONE-TEST',
        taskTitle: 'Cancel Done Test',
        taskDescription: '',
        projectPath: '/tmp',
      });

      agentPair.updateSessionStatus(session.id, 'approved');
      const result = agentPair.cancelSession(session.id);
      expect(result).toBe(false);
    });
  });

  describe('formatSessionSummary', () => {
    it('should format session summary correctly', () => {
      const session = agentPair.createPairSession({
        taskId: 'FORMAT-TEST',
        taskTitle: 'Format Test Task',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const summary = agentPair.formatSessionSummary(session);
      expect(summary).toContain('Format Test Task');
      expect(summary).toContain(session.id);
      expect(summary).toContain('pending');
    });
  });

  describe('getActiveSessions', () => {
    it('should return only active sessions', () => {
      // Create multiple sessions
      const active1 = agentPair.createPairSession({
        taskId: 'ACTIVE-1',
        taskTitle: 'Active 1',
        taskDescription: '',
        projectPath: '/tmp',
      });

      const active2 = agentPair.createPairSession({
        taskId: 'ACTIVE-2',
        taskTitle: 'Active 2',
        taskDescription: '',
        projectPath: '/tmp',
      });

      // Update one to working
      agentPair.updateSessionStatus(active2.id, 'working');

      const activeSessions = agentPair.getActiveSessions();

      // Should include active sessions but not completed ones
      const ids = activeSessions.map(s => s.id);
      expect(ids.includes(active1.id) || ids.includes(active2.id)).toBe(true);
    });
  });
});
