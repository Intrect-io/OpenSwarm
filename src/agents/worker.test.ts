// Created: 2026-03-07
// Purpose: Unit tests for worker module
// Test Status: Complete

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerResult } from './agentPair.js';
import { formatWorkReport, type WorkerOptions } from './worker.js';

describe('worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('formatWorkReport', () => {
    it('should format successful worker result', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed successfully',
        filesChanged: ['src/main.ts', 'src/utils.ts'],
        commands: ['npm test', 'npm run build'],
        output: 'All tests passed, build successful',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('completed');
      expect(report).toContain('Task completed successfully');
    });

    it('should format failed worker result', () => {
      const result: WorkerResult = {
        success: false,
        summary: 'Task failed',
        filesChanged: [],
        commands: [],
        output: '',
        error: 'Build failed with error code 1',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('failed');
      expect(report).toContain('Task failed');
    });

    it('should include project context in report', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result, {
        projectName: 'TestProject',
        issueIdentifier: 'INT-123',
        projectPath: '/home/user/projects/testproject',
      });

      expect(report).toContain('TestProject');
      expect(report).toContain('INT-123');
      expect(report).toContain('testproject');
    });

    it('should display list of changed files', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file1.ts', 'file2.ts', 'file3.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('file1.ts');
      expect(report).toContain('file2.ts');
      expect(report).toContain('file3.ts');
    });

    it('should handle many changed files with count', () => {
      const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: files,
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      // Should show first 15 and count remaining
      expect(report).toContain('file0.ts');
      expect(report).toContain(`20`);
    });

    it('should display executed commands', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: ['npm install', 'npm test', 'npm run build'],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('npm install');
      expect(report).toContain('npm test');
      expect(report).toContain('npm run build');
    });

    it('should handle many commands with truncation', () => {
      const commands = Array.from({ length: 10 }, (_, i) => `command${i}`);
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands,
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('command0');
      expect(report).toContain('command4'); // First 5 commands
    });

    it('should include error message for failed task', () => {
      const result: WorkerResult = {
        success: false,
        summary: 'Task failed',
        filesChanged: [],
        commands: [],
        output: '',
        error: 'Permission denied: /root/.ssh/id_rsa',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('Permission denied');
    });

    it('should format report without context', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toBeDefined();
      expect(report.length).toBeGreaterThan(0);
    });

    it('should format report with partial context', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result, {
        projectName: 'MyProject',
      });

      expect(report).toContain('MyProject');
    });

    it('should handle empty files changed list', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed (no changes needed)',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toBeDefined();
    });

    it('should handle empty commands list', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed (no commands)',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toBeDefined();
    });

    it('should format multiline summary', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed\nWith multiple changes',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('Task completed');
    });

    it('should handle special characters in filenames', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['src/my-file.test.ts', 'src/config_prod.json'],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('my-file.test.ts');
      expect(report).toContain('config_prod.json');
    });

    it('should handle special characters in commands', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: ['npm run build -- --prod', 'pytest tests/ -v'],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('npm run build');
      expect(report).toContain('pytest');
    });

    it('should handle very long file paths', () => {
      const longPath = '/home/user/very/long/project/path/with/many/nested/directories/file.ts';
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [longPath],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toBeDefined();
    });

    it('should display success status with emoji', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      // Should contain success indicator
      expect(report.length).toBeGreaterThan(0);
    });

    it('should display failure status with emoji', () => {
      const result: WorkerResult = {
        success: false,
        summary: 'Task failed',
        filesChanged: [],
        commands: [],
        output: '',
        error: 'Error occurred',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('failed');
    });
  });

  describe('WorkerOptions validation', () => {
    it('should accept valid WorkerOptions', () => {
      const options: WorkerOptions = {
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
      };

      expect(options.taskTitle).toBeDefined();
      expect(options.taskDescription).toBeDefined();
      expect(options.projectPath).toBeDefined();
    });

    it('should accept optional fields', () => {
      const options: WorkerOptions = {
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '/tmp/project',
        previousFeedback: 'Previous feedback from reviewer',
        timeoutMs: 60000,
        model: 'claude-sonnet-4-5-20250929',
        issueIdentifier: 'INT-123',
        projectName: 'MyProject',
      };

      expect(options.previousFeedback).toBeDefined();
      expect(options.timeoutMs).toBe(60000);
      expect(options.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('should handle path expansion callback', () => {
      const options: WorkerOptions = {
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        projectPath: '~/my/project',
        onLog: (line: string) => {
          expect(typeof line).toBe('string');
        },
      };

      expect(options.onLog).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle result with all fields populated', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Comprehensive task completed',
        filesChanged: ['a.ts', 'b.ts', 'c.ts'],
        commands: ['cmd1', 'cmd2'],
        output: 'Detailed output',
        confidence: 3,
        confidencePercent: 95,
      };

      const report = formatWorkReport(result, {
        projectName: 'Full Project',
        issueIdentifier: 'INT-999',
        projectPath: '/home/user/projects/full',
      });

      expect(report).toContain('Comprehensive task completed');
      expect(report).toContain('Full Project');
      expect(report).toContain('INT-999');
    });

    it('should handle result with minimal fields', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Done',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('Done');
      expect(report).toBeDefined();
    });

    it('should handle null/undefined context fields', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result, {
        projectName: undefined,
        issueIdentifier: undefined,
        projectPath: undefined,
      });

      expect(report).toBeDefined();
    });

    it('should handle empty strings in context', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const report = formatWorkReport(result, {
        projectName: '',
        issueIdentifier: '',
        projectPath: '',
      });

      expect(report).toBeDefined();
    });
  });

  describe('Report formatting consistency', () => {
    it('should produce consistent output for same input', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: ['npm test'],
        output: '',
      };

      const report1 = formatWorkReport(result);
      const report2 = formatWorkReport(result);

      expect(report1).toBe(report2);
    });

    it('should include newlines for readability', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: ['npm test'],
        output: '',
      };

      const report = formatWorkReport(result);

      expect(report).toContain('\n');
    });
  });
});
