// ============================================
// Reviewer Unit Tests
// ============================================

import { describe, it, expect } from 'vitest';
import { formatReviewFeedback, buildRevisionPrompt } from '../agents/reviewer.js';
import type { ReviewResult } from '../agents/agentPair.js';

describe('reviewer', () => {
  describe('formatReviewFeedback', () => {
    it('should format approve decision correctly', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'Code looks good, well structured.',
        issues: [],
        suggestions: ['Consider adding more tests'],
      };

      const formatted = formatReviewFeedback(result);

      expect(formatted).toContain('✅');
      expect(formatted).toContain('APPROVED');
      expect(formatted).toContain('Code looks good');
      expect(formatted).toContain('Consider adding more tests');
    });

    it('should format revise decision correctly', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Needs some improvements.',
        issues: ['Missing error handling', 'No tests'],
        suggestions: ['Add try-catch blocks'],
      };

      const formatted = formatReviewFeedback(result);

      expect(formatted).toContain('🔄');
      expect(formatted).toContain('REVISION NEEDED');
      expect(formatted).toContain('Missing error handling');
      expect(formatted).toContain('No tests');
    });

    it('should format reject decision correctly', () => {
      const result: ReviewResult = {
        decision: 'reject',
        feedback: 'Fundamental issues with approach.',
        issues: ['Wrong architecture', 'Security vulnerability'],
        suggestions: [],
      };

      const formatted = formatReviewFeedback(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('REJECTED');
      expect(formatted).toContain('Fundamental issues');
      expect(formatted).toContain('Security vulnerability');
    });

    it('should handle empty arrays gracefully', () => {
      const result: ReviewResult = {
        decision: 'approve',
        feedback: 'All good!',
        issues: [],
        suggestions: [],
      };

      const formatted = formatReviewFeedback(result);

      expect(formatted).toContain('All good!');
      expect(formatted).not.toContain('**Issues:**');
    });
  });

  describe('buildRevisionPrompt', () => {
    it('should build revision prompt with all fields', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Code needs improvement.',
        issues: ['Issue 1', 'Issue 2'],
        suggestions: ['Suggestion A', 'Suggestion B'],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toContain('Reviewer Feedback');
      expect(prompt).toContain('REVISE');
      expect(prompt).toContain('Code needs improvement');
      expect(prompt).toContain('Issue 1');
      expect(prompt).toContain('Issue 2');
      expect(prompt).toContain('Suggestion A');
      expect(prompt).toContain('Apply the above feedback');
    });

    it('should handle empty issues and suggestions', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Minor fixes needed.',
        issues: [],
        suggestions: [],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toContain('Minor fixes needed');
      expect(prompt).not.toContain('Issues to resolve');
      expect(prompt).not.toContain('Suggestions');
    });

    it('should number issues and suggestions', () => {
      const result: ReviewResult = {
        decision: 'revise',
        feedback: 'Multiple issues.',
        issues: ['First issue', 'Second issue'],
        suggestions: ['First suggestion'],
      };

      const prompt = buildRevisionPrompt(result);

      expect(prompt).toContain('1. First issue');
      expect(prompt).toContain('2. Second issue');
      expect(prompt).toContain('1. First suggestion');
    });
  });
});
