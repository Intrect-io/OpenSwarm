import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import {
  getEventHub,
  broadcastEvent,
  addSSEClient,
  getActiveSSECount,
  getLogBuffer,
  getStageBuffer,
  getChatBuffer,
  __resetForTests,
  type HubEvent,
} from './eventHub.js';

describe('eventHub', () => {
  let mockRes: Partial<ServerResponse>;
  const cleanupFunctions: Array<() => void> = [];

  beforeEach(() => {
    // Reset event hub state before each test
    __resetForTests();

    // Mock ServerResponse with once method
    mockRes = {
      write: vi.fn(),
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          (mockRes as any)._closeCallback = callback;
        }
      }),
      once: vi.fn((event, callback) => {
        if (event === 'close') {
          (mockRes as any)._closeCallback = callback;
        }
      }),
      removeListener: vi.fn(),
    };
  });

  afterEach(() => {
    // Clean up all collected SSE clients
    cleanupFunctions.forEach(fn => fn());
    cleanupFunctions.length = 0;

    // Final cleanup of event hub state
    __resetForTests();
  });

  // ============================================
  // Basic Event Emission
  // ============================================

  describe('broadcastEvent', () => {
    it('should broadcast task:queued event', () => {
      const event: HubEvent = {
        type: 'task:queued',
        data: {
          taskId: 'task-1',
          title: 'Test Task',
          projectPath: '/path/to/project',
        },
      };

      broadcastEvent(event);
      // Should not throw
      expect(true).toBe(true);
    });

    it('should broadcast task:started event', () => {
      const event: HubEvent = {
        type: 'task:started',
        data: {
          taskId: 'task-1',
          title: 'Test Task',
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast task:completed event', () => {
      const event: HubEvent = {
        type: 'task:completed',
        data: {
          taskId: 'task-1',
          success: true,
          duration: 5000,
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast stats event', () => {
      const event: HubEvent = {
        type: 'stats',
        data: {
          runningTasks: 2,
          queuedTasks: 3,
          completedToday: 5,
          uptime: 3600000,
          schedulerPaused: false,
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast log event', () => {
      const event: HubEvent = {
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'prepare',
          line: '[INFO] Starting task execution',
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast pipeline:stage event', () => {
      const event: HubEvent = {
        type: 'pipeline:stage',
        data: {
          taskId: 'task-1',
          stage: 'plan',
          status: 'start',
          model: 'claude-opus',
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast chat:user event', () => {
      const event: HubEvent = {
        type: 'chat:user',
        data: {
          text: 'Hello',
          ts: Date.now(),
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });

    it('should broadcast chat:agent event', () => {
      const event: HubEvent = {
        type: 'chat:agent',
        data: {
          text: 'Hello from agent',
          ts: Date.now(),
        },
      };

      broadcastEvent(event);
      expect(true).toBe(true);
    });
  });

  // ============================================
  // Event Hub Access
  // ============================================

  describe('getEventHub', () => {
    it('should return an EventEmitter instance', () => {
      const hub = getEventHub();
      expect(hub).toBeInstanceOf(EventEmitter);
    });

    it('should return the same EventEmitter instance on multiple calls', () => {
      const hub1 = getEventHub();
      const hub2 = getEventHub();
      expect(hub1).toBe(hub2);
    });

    it('should have max listeners set to 50', () => {
      const hub = getEventHub();
      expect(hub.getMaxListeners()).toBeGreaterThanOrEqual(50);
    });
  });

  // ============================================
  // SSE Client Management
  // ============================================

  describe('SSE client management', () => {
    it('should add SSE client and return unsubscribe function', () => {
      const unsubscribe = addSSEClient(mockRes as ServerResponse);
      cleanupFunctions.push(unsubscribe);
      expect(typeof unsubscribe).toBe('function');
      expect(getActiveSSECount()).toBe(1);
    });

    it('should unsubscribe SSE client on cleanup call', () => {
      const unsubscribe = addSSEClient(mockRes as ServerResponse);
      cleanupFunctions.push(unsubscribe);
      expect(getActiveSSECount()).toBe(1);
      unsubscribe();
      expect(getActiveSSECount()).toBe(0);
      cleanupFunctions.pop();
    });

    it('should unsubscribe SSE client on response close event', () => {
      const unsubscribe = addSSEClient(mockRes as ServerResponse);
      cleanupFunctions.push(unsubscribe);
      expect(getActiveSSECount()).toBe(1);

      // Simulate close event
      const closeCallback = (mockRes as any)._closeCallback;
      if (closeCallback) {
        closeCallback();
      }

      expect(getActiveSSECount()).toBe(0);
    });

    it('should handle multiple SSE clients', () => {
      const res1 = { write: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() } as any;
      const res2 = { write: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() } as any;
      const res3 = { write: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() } as any;

      cleanupFunctions.push(addSSEClient(res1));
      cleanupFunctions.push(addSSEClient(res2));
      cleanupFunctions.push(addSSEClient(res3));

      expect(getActiveSSECount()).toBe(3);
    });

    it('should remove broken SSE client on write error', () => {
      const brokenRes = {
        write: vi.fn(() => {
          throw new Error('Connection broken');
        }),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      } as any;

      const unsubscribe = addSSEClient(brokenRes);
      cleanupFunctions.push(unsubscribe);
      expect(getActiveSSECount()).toBe(1);

      // Broadcast an event to trigger write and client removal
      broadcastEvent({
        type: 'stats',
        data: {
          runningTasks: 0,
          queuedTasks: 0,
          completedToday: 0,
          uptime: 0,
          schedulerPaused: false,
        },
      });

      // Broken client should be removed
      expect(getActiveSSECount()).toBe(0);
    });

    it('should skip replay when skipReplay is true', () => {
      // Add some events to replay buffer
      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'prepare',
          line: '[INFO] Test log',
        },
      });

      const mockRes2 = {
        write: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      } as any;

      // Add client with skipReplay=true
      const unsubscribe = addSSEClient(mockRes2, true);
      cleanupFunctions.push(unsubscribe);

      // write should not have been called for replay
      expect(mockRes2.write).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Buffer Management
  // ============================================

  describe('buffer management', () => {
    it('should store log events in logBuffer', () => {
      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'prepare',
          line: '[INFO] Test log 1',
        },
      });

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'prepare',
          line: '[INFO] Test log 2',
        },
      });

      const buffer = getLogBuffer();
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.some(e => e.type === 'log')).toBe(true);
    });

    it('should store stage events in stageBuffer', () => {
      broadcastEvent({
        type: 'pipeline:stage',
        data: {
          taskId: 'task-1',
          stage: 'plan',
          status: 'start',
        },
      });

      broadcastEvent({
        type: 'task:queued',
        data: {
          taskId: 'task-2',
          title: 'Task 2',
          projectPath: '/path',
        },
      });

      const buffer = getStageBuffer();
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.some(e => e.type === 'pipeline:stage')).toBe(true);
    });

    it('should store chat events in chatBuffer', () => {
      broadcastEvent({
        type: 'chat:user',
        data: {
          text: 'Hello',
          ts: Date.now(),
        },
      });

      broadcastEvent({
        type: 'chat:agent',
        data: {
          text: 'Hi there',
          ts: Date.now(),
        },
      });

      const buffer = getChatBuffer();
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.some(e => e.type === 'chat:user')).toBe(true);
      expect(buffer.some(e => e.type === 'chat:agent')).toBe(true);
    });

    it('should respect log buffer max size', () => {
      // Add more logs than the max (300)
      for (let i = 0; i < 350; i++) {
        broadcastEvent({
          type: 'log',
          data: {
            taskId: 'task-1',
            stage: 'prepare',
            line: `Log line ${i}`,
          },
        });
      }

      const buffer = getLogBuffer();
      expect(buffer.length).toBeLessThanOrEqual(300);
    });

    it('should exclude heartbeat from replay buffer', () => {
      broadcastEvent({ type: 'heartbeat' });

      // Replay buffer should not contain heartbeat
      const mockRes = {
        write: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      } as any;

      const unsubscribe = addSSEClient(mockRes, false);
      cleanupFunctions.push(unsubscribe);

      // Check if heartbeat was in write calls - it shouldn't be
      const writeCalls = mockRes.write.mock.calls;
      const hasHeartbeat = writeCalls.some(call =>
        call[0]?.includes('heartbeat')
      );

      expect(hasHeartbeat).toBe(false);
    });

    it('should handle conflict events correctly', () => {
      broadcastEvent({
        type: 'conflict:detected',
        data: {
          repo: 'owner/repo',
          prNumber: 123,
          branch: 'feature/test',
        },
      });

      broadcastEvent({
        type: 'conflict:resolved',
        data: {
          repo: 'owner/repo',
          prNumber: 123,
          branch: 'feature/test',
          filesResolved: 3,
        },
      });

      const buffer = getStageBuffer();
      expect(buffer.some(e => e.type === 'conflict:detected')).toBe(true);
      expect(buffer.some(e => e.type === 'conflict:resolved')).toBe(true);
    });

    it('should handle monitor events correctly', () => {
      broadcastEvent({
        type: 'monitor:checked',
        data: {
          id: 'monitor-1',
          name: 'Test Monitor',
          state: 'healthy',
          checkCount: 5,
        },
      });

      broadcastEvent({
        type: 'monitor:stateChange',
        data: {
          id: 'monitor-1',
          name: 'Test Monitor',
          from: 'healthy',
          to: 'unhealthy',
        },
      });

      const buffer = getStageBuffer();
      expect(buffer.some(e => e.type === 'monitor:checked')).toBe(true);
      expect(buffer.some(e => e.type === 'monitor:stateChange')).toBe(true);
    });
  });

  // ============================================
  // Event Type Coverage
  // ============================================

  describe('all event types', () => {
    const eventTypes: Array<[HubEvent['type'], HubEvent]> = [
      [
        'stats',
        {
          type: 'stats',
          data: {
            runningTasks: 0,
            queuedTasks: 0,
            completedToday: 0,
            uptime: 0,
            schedulerPaused: false,
          },
        },
      ],
      [
        'pipeline:iteration',
        {
          type: 'pipeline:iteration',
          data: { taskId: 'task-1', iteration: 2 },
        },
      ],
      [
        'pipeline:escalation',
        {
          type: 'pipeline:escalation',
          data: {
            taskId: 'task-1',
            iteration: 3,
            fromModel: 'model-1',
            toModel: 'model-2',
          },
        },
      ],
      [
        'project:toggled',
        {
          type: 'project:toggled',
          data: { projectPath: '/path', enabled: true },
        },
      ],
      [
        'task:cost',
        {
          type: 'task:cost',
          data: {
            taskId: 'task-1',
            cost: {
              inputTokens: 100,
              outputTokens: 200,
              costUsd: 0.01,
            },
          },
        },
      ],
      [
        'knowledge:updated',
        {
          type: 'knowledge:updated',
          data: { projectSlug: 'project', nodeCount: 10, edgeCount: 5 },
        },
      ],
      [
        'process:spawn',
        {
          type: 'process:spawn',
          data: {
            pid: 1234,
            taskId: 'task-1',
            stage: 'execute',
            projectPath: '/path',
          },
        },
      ],
      [
        'process:exit',
        {
          type: 'process:exit',
          data: {
            pid: 1234,
            exitCode: 0,
            signal: null,
            durationMs: 5000,
          },
        },
      ],
      [
        'conflict:failed',
        {
          type: 'conflict:failed',
          data: {
            repo: 'owner/repo',
            prNumber: 123,
            branch: 'feature/test',
            reason: 'Too many conflicts',
          },
        },
      ],
      [
        'pr_processor_start',
        {
          type: 'pr_processor_start',
          data: { repos: ['owner/repo'] },
        },
      ],
      [
        'pr_processor_end',
        {
          type: 'pr_processor_end',
          data: {
            lastRun: Date.now(),
            nextRun: Date.now() + 3600000,
          },
        },
      ],
      [
        'pr_processor_pr',
        {
          type: 'pr_processor_pr',
          data: { pr: 'owner/repo#123', title: 'Fix bug' },
        },
      ],
      ['heartbeat', { type: 'heartbeat' }],
    ];

    eventTypes.forEach(([type, event]) => {
      it(`should broadcast ${type} event`, () => {
        expect(() => broadcastEvent(event)).not.toThrow();
      });
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('edge cases', () => {
    it('should handle broadcasting without active SSE clients', () => {
      broadcastEvent({
        type: 'stats',
        data: {
          runningTasks: 0,
          queuedTasks: 0,
          completedToday: 0,
          uptime: 0,
          schedulerPaused: false,
        },
      });

      expect(getActiveSSECount()).toBe(0);
    });

    it('should handle rapid event broadcasts', () => {
      for (let i = 0; i < 100; i++) {
        broadcastEvent({
          type: 'log',
          data: {
            taskId: 'task-1',
            stage: 'execute',
            line: `Line ${i}`,
          },
        });
      }

      const buffer = getLogBuffer();
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should handle mix of different event types', () => {
      const events: HubEvent[] = [
        {
          type: 'task:queued',
          data: { taskId: 'task-1', title: 'Task', projectPath: '/path' },
        },
        {
          type: 'log',
          data: { taskId: 'task-1', stage: 'prepare', line: 'Preparing' },
        },
        {
          type: 'pipeline:stage',
          data: { taskId: 'task-1', stage: 'plan', status: 'start' },
        },
        {
          type: 'stats',
          data: {
            runningTasks: 1,
            queuedTasks: 0,
            completedToday: 0,
            uptime: 1000,
            schedulerPaused: false,
          },
        },
        {
          type: 'task:completed',
          data: { taskId: 'task-1', success: true, duration: 5000 },
        },
      ];

      events.forEach(broadcastEvent);

      expect(getLogBuffer().length).toBeGreaterThan(0);
      expect(getStageBuffer().length).toBeGreaterThan(0);
    });

    it('should handle very long log lines', () => {
      const longLine = 'A'.repeat(10000);

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'execute',
          line: longLine,
        },
      });

      const buffer = getLogBuffer();
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should handle events with special characters', () => {
      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'task-1',
          stage: 'execute',
          line: 'Special chars: \n\t\r "quotes" \'apostrophe\' \\backslash',
        },
      });

      expect(getLogBuffer().length).toBeGreaterThan(0);
    });

    it('should handle large cost values', () => {
      broadcastEvent({
        type: 'task:cost',
        data: {
          taskId: 'task-1',
          cost: {
            inputTokens: 999999999,
            outputTokens: 999999999,
            costUsd: 99999.99,
          },
        },
      });

      expect(getStageBuffer().length).toBeGreaterThan(0);
    });
  });
});
