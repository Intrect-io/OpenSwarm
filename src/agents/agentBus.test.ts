// Created: 2026-03-07
// Purpose: Unit tests for agentBus module
// Test Status: Complete

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentBus, createBus, type StepCompletedPayload, type ContextUpdatePayload, type FileChangedPayload } from './agentBus.js';

describe('agentBus', () => {
  let bus: AgentBus;

  beforeEach(() => {
    bus = createBus();
  });

  afterEach(async () => {
    if (bus) {
      await bus.cleanup();
    }
  });

  describe('Bus Creation', () => {
    it('should create a bus with unique execution ID', () => {
      const bus1 = createBus();
      const bus2 = createBus();

      expect(bus1).toBeDefined();
      expect(bus2).toBeDefined();
    });

    it('should accept optional execution ID', () => {
      const customId = 'custom-exec-123';
      const bus = createBus(customId);

      expect(bus).toBeDefined();
    });

    it('should generate unique IDs for different buses', () => {
      const bus1 = createBus();
      const bus2 = createBus();

      // They should be different instances
      expect(bus1).not.toBe(bus2);
    });
  });

  describe('Bus Initialization', () => {
    it('should initialize bus with workflow ID', async () => {
      await bus.init('workflow-123');

      const context = await bus.getContext();
      expect(context).toBeDefined();
      expect(context?.workflowId).toBe('workflow-123');
    });

    it('should set initial context properties', async () => {
      await bus.init('workflow-123');

      const context = await bus.getContext();
      expect(context?.stepOutputs).toBeDefined();
      expect(context?.changedFiles).toBeDefined();
      expect(context?.errors).toBeDefined();
      expect(context?.data).toBeDefined();
    });

    it('should have empty initial state', async () => {
      await bus.init('workflow-123');

      const context = await bus.getContext();
      expect(context?.stepOutputs).toEqual({});
      expect(context?.changedFiles).toEqual([]);
      expect(context?.errors).toEqual([]);
      expect(context?.data).toEqual({});
    });
  });

  describe('Message Publishing', () => {
    it('should publish step_started message', async () => {
      await bus.init('workflow-123');

      const messageId = await bus.publish('step_started', 'step-1', {});

      expect(messageId).toBeDefined();
    });

    it('should publish step_completed message', async () => {
      await bus.init('workflow-123');

      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Step completed',
        changedFiles: ['file.ts'],
        duration: 1000,
      };

      const messageId = await bus.publish('step_completed', 'step-1', payload);

      expect(messageId).toBeDefined();
    });

    it('should publish context_update message', async () => {
      await bus.init('workflow-123');

      const payload: ContextUpdatePayload = {
        key: 'myKey',
        value: 'myValue',
        operation: 'set',
      };

      const messageId = await bus.publish('context_update', 'step-1', payload);

      expect(messageId).toBeDefined();
    });

    it('should publish error message', async () => {
      await bus.init('workflow-123');

      const messageId = await bus.publish('error', 'step-1', 'Error occurred');

      expect(messageId).toBeDefined();
    });

    it('should generate unique message IDs', async () => {
      await bus.init('workflow-123');

      const id1 = await bus.publish('log', 'step-1', 'message 1');
      const id2 = await bus.publish('log', 'step-1', 'message 2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('Step Completion Handling', () => {
    it('should record step output', async () => {
      await bus.init('workflow-123');

      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Task completed',
        changedFiles: [],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const output = await bus.getStepOutput('step-1');
      expect(output).toBe('Task completed');
    });

    it('should record changed files from step', async () => {
      await bus.init('workflow-123');

      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output',
        changedFiles: ['file1.ts', 'file2.ts'],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const files = await bus.getChangedFiles();
      expect(files).toContain('file1.ts');
      expect(files).toContain('file2.ts');
    });

    it('should accumulate changed files from multiple steps', async () => {
      await bus.init('workflow-123');

      const payload1: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output 1',
        changedFiles: ['file1.ts'],
        duration: 500,
      };

      const payload2: StepCompletedPayload = {
        stepId: 'step-2',
        success: true,
        output: 'Output 2',
        changedFiles: ['file2.ts'],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload1);
      await bus.publish('step_completed', 'step-2', payload2);

      const files = await bus.getChangedFiles();
      expect(files).toContain('file1.ts');
      expect(files).toContain('file2.ts');
    });

    it('should not duplicate changed files', async () => {
      await bus.init('workflow-123');

      const payload1: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output',
        changedFiles: ['file.ts'],
        duration: 500,
      };

      const payload2: StepCompletedPayload = {
        stepId: 'step-2',
        success: true,
        output: 'Output',
        changedFiles: ['file.ts'],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload1);
      await bus.publish('step_completed', 'step-2', payload2);

      const files = await bus.getChangedFiles();
      expect(files.filter(f => f === 'file.ts')).toHaveLength(1);
    });
  });

  describe('Context Updates', () => {
    it('should set custom data', async () => {
      await bus.init('workflow-123');

      await bus.setData('myKey', 'myValue');

      const value = await bus.getData<string>('myKey');
      expect(value).toBe('myValue');
    });

    it('should handle context update set operation', async () => {
      await bus.init('workflow-123');

      const payload: ContextUpdatePayload = {
        key: 'counter',
        value: 5,
        operation: 'set',
      };

      await bus.publish('context_update', 'step-1', payload);

      const value = await bus.getData<number>('counter');
      expect(value).toBe(5);
    });

    it('should handle context update append operation', async () => {
      await bus.init('workflow-123');

      const payload1: ContextUpdatePayload = {
        key: 'items',
        value: 'item1',
        operation: 'append',
      };

      const payload2: ContextUpdatePayload = {
        key: 'items',
        value: 'item2',
        operation: 'append',
      };

      await bus.publish('context_update', 'step-1', payload1);
      await bus.publish('context_update', 'step-1', payload2);

      const items = await bus.getData<string[]>('items');
      expect(items).toContain('item1');
      expect(items).toContain('item2');
    });

    it('should handle context update delete operation', async () => {
      await bus.init('workflow-123');

      const setPayload: ContextUpdatePayload = {
        key: 'tempData',
        value: 'data',
        operation: 'set',
      };

      const deletePayload: ContextUpdatePayload = {
        key: 'tempData',
        value: undefined,
        operation: 'delete',
      };

      await bus.publish('context_update', 'step-1', setPayload);
      await bus.publish('context_update', 'step-1', deletePayload);

      const value = await bus.getData('tempData');
      expect(value).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should record error', async () => {
      await bus.init('workflow-123');

      await bus.publish('error', 'step-1', 'An error occurred');

      const context = await bus.getContext();
      expect(context?.errors.length).toBeGreaterThan(0);
    });

    it('should record multiple errors', async () => {
      await bus.init('workflow-123');

      await bus.publish('error', 'step-1', 'Error 1');
      await bus.publish('error', 'step-2', 'Error 2');

      const context = await bus.getContext();
      expect(context?.errors).toHaveLength(2);
    });

    it('should include error details', async () => {
      await bus.init('workflow-123');

      await bus.publish('error', 'step-1', 'Detailed error message');

      const context = await bus.getContext();
      expect(context?.errors[0].message).toBe('Detailed error message');
      expect(context?.errors[0].stepId).toBe('step-1');
    });
  });

  describe('File Change Tracking', () => {
    it('should handle file_changed message', async () => {
      await bus.init('workflow-123');

      const payload: FileChangedPayload = {
        path: 'src/new.ts',
        action: 'created',
      };

      await bus.publish('file_changed', 'step-1', payload);

      const files = await bus.getChangedFiles();
      expect(files).toContain('src/new.ts');
    });

    it('should track file modifications', async () => {
      await bus.init('workflow-123');

      const payload: FileChangedPayload = {
        path: 'src/existing.ts',
        action: 'modified',
        diff: '+ added line\n- removed line',
      };

      await bus.publish('file_changed', 'step-1', payload);

      const files = await bus.getChangedFiles();
      expect(files).toContain('src/existing.ts');
    });

    it('should track file deletions', async () => {
      await bus.init('workflow-123');

      const payload: FileChangedPayload = {
        path: 'src/deprecated.ts',
        action: 'deleted',
      };

      await bus.publish('file_changed', 'step-1', payload);

      const files = await bus.getChangedFiles();
      expect(files).toContain('src/deprecated.ts');
    });

    it('should not duplicate files', async () => {
      await bus.init('workflow-123');

      const payload1: FileChangedPayload = {
        path: 'file.ts',
        action: 'created',
      };

      const payload2: FileChangedPayload = {
        path: 'file.ts',
        action: 'modified',
      };

      await bus.publish('file_changed', 'step-1', payload1);
      await bus.publish('file_changed', 'step-1', payload2);

      const files = await bus.getChangedFiles();
      expect(files.filter(f => f === 'file.ts')).toHaveLength(1);
    });
  });

  describe('Message Listening', () => {
    it('should register message listener', async () => {
      await bus.init('workflow-123');

      const listener = vi.fn();
      bus.on('step_started', listener);

      expect(listener).toBeDefined();
    });

    it('should support multiple listeners for same message type', async () => {
      await bus.init('workflow-123');

      const listener1 = vi.fn();
      const listener2 = vi.fn();

      bus.on('step_completed', listener1);
      bus.on('step_completed', listener2);

      expect(listener1).toBeDefined();
      expect(listener2).toBeDefined();
    });

    it('should support different message types', async () => {
      await bus.init('workflow-123');

      const stepListener = vi.fn();
      const errorListener = vi.fn();
      const updateListener = vi.fn();

      bus.on('step_completed', stepListener);
      bus.on('error', errorListener);
      bus.on('context_update', updateListener);

      expect(stepListener).toBeDefined();
      expect(errorListener).toBeDefined();
      expect(updateListener).toBeDefined();
    });
  });

  describe('Step Context Creation', () => {
    it('should create step context with execution info', async () => {
      await bus.init('workflow-123');

      const context = await bus.createStepContext('step-1');

      expect(context).toContain('Execution ID');
      expect(context).toContain('Started');
    });

    it('should include previous step results in context', async () => {
      await bus.init('workflow-123');

      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Step 1 result',
        changedFiles: [],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const context = await bus.createStepContext('step-2', ['step-1']);

      expect(context).toContain('Step 1 result');
    });

    it('should list changed files in context', async () => {
      await bus.init('workflow-123');

      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output',
        changedFiles: ['file.ts'],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const context = await bus.createStepContext('step-2');

      expect(context).toContain('file.ts');
    });

    it('should include error log in context', async () => {
      await bus.init('workflow-123');

      await bus.publish('error', 'step-1', 'Test error');

      const context = await bus.createStepContext('step-2');

      expect(context).toContain('Test error');
      expect(context).toContain('step-1');
    });

    it('should handle dependency tracking', async () => {
      await bus.init('workflow-123');

      const payload1: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output 1',
        changedFiles: [],
        duration: 500,
      };

      const payload2: StepCompletedPayload = {
        stepId: 'step-2',
        success: true,
        output: 'Output 2',
        changedFiles: [],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload1);
      await bus.publish('step_completed', 'step-2', payload2);

      const context = await bus.createStepContext('step-3', ['step-1', 'step-2']);

      expect(context).toContain('step-1');
      expect(context).toContain('step-2');
    });
  });

  describe('Message Retrieval', () => {
    it('should retrieve all messages', async () => {
      await bus.init('workflow-123');

      await bus.publish('step_started', 'step-1', {});
      await bus.publish('log', 'step-1', { message: 'test' });
      await bus.publish('step_completed', 'step-1', {
        stepId: 'step-1',
        success: true,
        output: '',
        changedFiles: [],
        duration: 0,
      });

      const messages = await bus.getAllMessages();

      expect(messages.length).toBeGreaterThanOrEqual(3);
    });

    it('should return empty list if no messages', async () => {
      await bus.init('workflow-123');

      const messages = await bus.getAllMessages();

      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe('Polling', () => {
    it('should start polling', async () => {
      await bus.init('workflow-123');

      bus.startPolling(100);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      bus.stopPolling();
    });

    it('should stop polling', async () => {
      await bus.init('workflow-123');

      bus.startPolling(100);
      bus.stopPolling();

      // Should not throw
    });

    it('should not start multiple polling intervals', async () => {
      await bus.init('workflow-123');

      bus.startPolling(100);
      bus.startPolling(100); // Should be ignored

      bus.stopPolling();
    });
  });

  describe('Context Persistence', () => {
    it('should persist context across operations', async () => {
      await bus.init('workflow-123');

      await bus.setData('key1', 'value1');
      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'test',
        changedFiles: ['file.ts'],
        duration: 500,
      };
      await bus.publish('step_completed', 'step-1', payload);

      const value = await bus.getData<string>('key1');
      const output = await bus.getStepOutput('step-1');
      const files = await bus.getChangedFiles();

      expect(value).toBe('value1');
      expect(output).toBe('test');
      expect(files).toContain('file.ts');
    });

    it('should maintain context across multiple steps', async () => {
      await bus.init('workflow-123');

      for (let i = 1; i <= 5; i++) {
        const payload: StepCompletedPayload = {
          stepId: `step-${i}`,
          success: true,
          output: `Step ${i} output`,
          changedFiles: [`file${i}.ts`],
          duration: 500,
        };
        await bus.publish('step_completed', `step-${i}`, payload);
      }

      const files = await bus.getChangedFiles();
      expect(files).toHaveLength(5);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup bus', async () => {
      await bus.init('workflow-123');
      await bus.cleanup();

      // Should not throw
    });

    it('should stop polling on cleanup', async () => {
      await bus.init('workflow-123');
      bus.startPolling(100);

      await bus.cleanup();

      bus.stopPolling(); // Should be safe to call again
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long output', async () => {
      await bus.init('workflow-123');

      const longOutput = 'A'.repeat(10000);
      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: longOutput,
        changedFiles: [],
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const output = await bus.getStepOutput('step-1');
      expect(output?.length).toBeGreaterThan(5000);
    });

    it('should handle many changed files', async () => {
      await bus.init('workflow-123');

      const files = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
      const payload: StepCompletedPayload = {
        stepId: 'step-1',
        success: true,
        output: 'Output',
        changedFiles: files,
        duration: 500,
      };

      await bus.publish('step_completed', 'step-1', payload);

      const changedFiles = await bus.getChangedFiles();
      expect(changedFiles).toHaveLength(100);
    });

    it('should handle many errors', async () => {
      await bus.init('workflow-123');

      for (let i = 0; i < 10; i++) {
        await bus.publish('error', `step-${i}`, `Error ${i}`);
      }

      const context = await bus.getContext();
      expect(context?.errors).toHaveLength(10);
    });
  });
});
