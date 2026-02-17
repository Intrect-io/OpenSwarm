// ============================================
// Worker Unit Tests
// ============================================

import { describe, it, expect } from 'vitest';
import { formatWorkReport } from './worker.js';
import type { WorkerResult } from './agentPair.js';

describe('worker', () => {
  describe('formatWorkReport', () => {
    it('should format successful result correctly', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Added new API endpoint',
        filesChanged: ['src/api.ts', 'src/routes.ts'],
        commands: ['npm test', 'npm run build'],
        output: 'Build completed successfully',
      };

      const formatted = formatWorkReport(result);

      expect(formatted).toContain('Worker Task Completed');
      expect(formatted).toContain('Added new API endpoint');
      expect(formatted).toContain('src/api.ts');
      expect(formatted).toContain('npm test');
    });

    it('should format failed result correctly', () => {
      const result: WorkerResult = {
        success: false,
        summary: 'Build failed',
        filesChanged: [],
        commands: ['npm run build'],
        output: 'Error: Type mismatch',
        error: 'TypeScript compilation error',
      };

      const formatted = formatWorkReport(result);

      expect(formatted).toContain('Worker Task Failed');
      expect(formatted).toContain('Build failed');
      expect(formatted).toContain('TypeScript compilation error');
    });

    it('should handle empty arrays gracefully', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'No changes needed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const formatted = formatWorkReport(result);

      expect(formatted).toContain('Worker Task Completed');
      expect(formatted).toContain('No changes needed');
      // Should not crash with empty arrays
      expect(formatted).not.toContain('undefined');
    });

    it('should limit commands shown', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Many commands run',
        filesChanged: [],
        commands: ['cmd1', 'cmd2', 'cmd3', 'cmd4', 'cmd5', 'cmd6', 'cmd7'],
        output: '',
      };

      const formatted = formatWorkReport(result);

      // Should only show first 5 commands
      expect(formatted).toContain('cmd1');
      expect(formatted).toContain('cmd5');
    });
  });
});
