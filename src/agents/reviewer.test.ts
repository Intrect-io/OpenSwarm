// Created: 2026-03-07
// Purpose: Unit tests for reviewer module
// Test Status: Complete

import { describe, it, expect } from 'vitest';
import { formatReviewFeedback, buildRevisionPrompt, type ReviewerOptions } from './reviewer.js';
import type { WorkerResult, ReviewResult } from './agentPair.js';

describe('reviewer', () => {
  describe('formatReviewFeedback', () => {
    it('should format approve decision', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Code looks good and tests pass',
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('APPROVED');
      expect(report).toContain('Code looks good and tests pass');
    });

    it('should format revise decision', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Needs some adjustments',
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('REVISION NEEDED');
      expect(report).toContain('Needs some adjustments');
    });

    it('should format reject decision', () => {
      const result: ReviewResult = {
        decision: 'reject',
        feedback: 'Does not meet acceptance criteria',
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('REJECTED');
      expect(report).toContain('Does not meet acceptance criteria');
    });

    it('should include issues list', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Several issues found',
        issues: [
          'Function too long (150 lines)',
          'Missing error handling',
          'No unit tests provided',
        ],
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Function too long');
      expect(report).toContain('Missing error handling');
      expect(report).toContain('No unit tests');
    });

    it('should include suggestions list', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Improvements needed',
        suggestions: [
          'Extract helper functions',
          'Add error handling for edge cases',
          'Write integration tests',
        ],
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Extract helper functions');
      expect(report).toContain('Add error handling');
      expect(report).toContain('Write integration tests');
    });

    it('should handle many issues with truncation', () => {
      const issues = Array.from({ length: 10 }, (_, i) => `Issue ${i}`);
      const result: ReviewResult = {
        decision: 'reject',
        feedback: 'Multiple issues',
        issues,
      };

      const report = formatReviewFeedback(result);

      // Should show first 5 issues
      expect(report).toContain('Issue 0');
      expect(report).toContain('Issue 4');
    });

    it('should handle many suggestions with truncation', () => {
      const suggestions = Array.from({ length: 10 }, (_, i) => `Suggestion ${i}`);
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Multiple suggestions',
        suggestions,
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Suggestion 0');
    });

    it('should format result with all fields', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Code review feedback',
        issues: ['Issue 1', 'Issue 2'],
        suggestions: ['Suggestion 1', 'Suggestion 2'],
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Code review feedback');
      expect(report).toContain('Issue 1');
      expect(report).toContain('Suggestion 1');
    });

    it('should format result with empty issues', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good',
        issues: [],
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Looks good');
    });

    it('should format result with undefined issues', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good',
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Looks good');
    });

    it('should include decision emoji', () => {
      const approveResult: ReviewResult = {
        decision: 'approve',
        feedback: 'Approved',
      };

      const approveReport = formatReviewFeedback(approveResult);
      expect(approveReport).toMatch(/✅|👍|✓/);
    });

    it('should handle multiline feedback', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: `Code needs improvements:
        - Better variable names
        - More comments`,
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Better variable names');
    });

    it('should handle special characters in feedback', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Special chars: @#$%^&*(){}[]|\\',
      };

      const report = formatReviewFeedback(result);

      expect(report).toBeDefined();
    });
  });

  describe('buildRevisionPrompt', () => {
    it('should build revision prompt from review result', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Fix the issues',
        issues: ['Issue 1'],
        suggestions: ['Suggestion 1'],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt.toLowerCase()).toContain('revise');
      expect(prompt).toContain('Fix the issues');
    });

    it('should include issues in revision prompt', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Needs work',
        issues: ['Issue 1', 'Issue 2', 'Issue 3'],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toContain('Issue 1');
      expect(prompt).toContain('Issue 2');
      expect(prompt).toContain('Issue 3');
    });

    it('should include suggestions in revision prompt', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Improve the code',
        suggestions: ['Suggestion 1', 'Suggestion 2'],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toContain('Suggestion 1');
      expect(prompt).toContain('Suggestion 2');
    });

    it('should handle revision with no issues', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Minor improvements needed',
        issues: [],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toBeDefined();
    });

    it('should include decision type in prompt', () => {
      const reviseResult: ReviewResult = {
        decision: 'revise',
        feedback: 'Please revise',
      };

      const revisePrompt = buildRevisionPrompt(reviseResult);

      expect(revisePrompt.toLowerCase()).toContain('revise');
    });

    it('should build different prompt for reject decision', () => {
      const rejectResult: ReviewResult = {
        decision: 'reject',
        feedback: 'Does not meet requirements',
        issues: ['Critical issue'],
      };

      const rejectPrompt = buildRevisionPrompt(rejectResult);

      expect(rejectPrompt).toBeDefined();
      expect(rejectPrompt.toLowerCase()).toContain('reject');
    });
  });

  describe('ReviewerOptions validation', () => {
    it('should validate ReviewerOptions structure', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const options: ReviewerOptions = {
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        workerResult: result,
        projectPath: '/tmp/project',
      };

      expect(options.taskTitle).toBeDefined();
      expect(options.taskDescription).toBeDefined();
      expect(options.workerResult).toBeDefined();
      expect(options.projectPath).toBeDefined();
    });

    it('should accept optional review options', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const options: ReviewerOptions = {
        taskTitle: 'Test Task',
        taskDescription: 'Test Description',
        workerResult: result,
        projectPath: '/tmp/project',
        timeoutMs: 120000,
        model: 'claude-sonnet-4-5-20250929',
      };

      expect(options.timeoutMs).toBe(120000);
      expect(options.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  describe('Edge cases', () => {
    it('should handle very long feedback text', () => {
      const longFeedback = 'A'.repeat(1000);
      const result: ReviewResult = {
        decision: 'revise',
        feedback: longFeedback,
      };

      const report = formatReviewFeedback(result);

      expect(report).toBeDefined();
      expect(report.length).toBeGreaterThan(0);
    });

    it('should handle many issues and suggestions', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Multiple issues',
        issues: Array.from({ length: 15 }, (_, i) => `Issue ${i}`),
        suggestions: Array.from({ length: 15 }, (_, i) => `Suggestion ${i}`),
      };

      const report = formatReviewFeedback(result);

      // Should truncate to first 5
      expect(report).toContain('Issue 0');
      expect(report).toContain('Suggestion 0');
    });

    it('should handle empty issues array', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'No issues',
        issues: [],
        suggestions: [],
      };

      const report = formatReviewFeedback(result);

      expect(report).toBeDefined();
    });

    it('should handle result with only feedback', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Looks good',
      };

      const report = formatReviewFeedback(result);

      expect(report).toContain('Looks good');
    });

    it('should build revision prompt for all decision types', () => {
      const decisions: Array<'approve' | 'revise' | 'reject'> = ['approve', 'revise', 'reject'];

      for (const decision of decisions) {
        const result: ReviewResult = {
          decision,
          feedback: `Decision: ${decision}`,
        };

        const prompt = buildRevisionPrompt(result);
        expect(prompt).toBeDefined();
        expect(prompt.length).toBeGreaterThan(0);
      }
    });

    it('should handle special characters in issues and suggestions', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Review feedback',
        issues: ['Issue with @#$%^&*()'],
        suggestions: ['Use {curly} and [brackets]'],
      };

      const report = formatReviewFeedback(result);

      expect(report).toBeDefined();
    });

    it('should format consistent output for same input', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Good work',
        issues: ['Minor issue'],
      };

      const report1 = formatReviewFeedback(result);
      const report2 = formatReviewFeedback(result);

      expect(report1).toBe(report2);
    });
  });

  describe('Review decision logic', () => {
    it('should differentiate between decision types', () => {
      const approve: ReviewResult = {
        decision: 'approve',
        feedback: 'Approved',
      };

      const revise: ReviewResult = {
        decision: 'revise',
        feedback: 'Needs revision',
      };

      const reject: ReviewResult = {
        decision: 'reject',
        feedback: 'Rejected',
      };

      const approveReport = formatReviewFeedback(approve);
      const reviseReport = formatReviewFeedback(revise);
      const rejectReport = formatReviewFeedback(reject);

      expect(approveReport).toContain('APPROVED');
      expect(reviseReport).toContain('REVISION NEEDED');
      expect(rejectReport).toContain('REJECTED');
    });

    it('should indicate severity based on issue count', () => {
      const manyIssues: ReviewResult = {
        decision: 'reject',
        feedback: 'Critical issues',
        issues: Array.from({ length: 10 }, (_, i) => `Critical issue ${i}`),
      };

      const fewIssues: ReviewResult = {
        decision: 'revise',
        feedback: 'Minor issues',
        issues: ['Small issue'],
      };

      const manyReport = formatReviewFeedback(manyIssues);
      const fewReport = formatReviewFeedback(fewIssues);

      expect(manyReport.length).toBeGreaterThan(fewReport.length);
    });
  });
});
