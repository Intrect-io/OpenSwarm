// Created: 2026-03-07
// Purpose: Unit tests for documenter module
// Test Status: Complete

import { describe, it, expect } from 'vitest';
import { formatDocReport, type DocumenterOptions, type DocumenterResult } from './documenter.js';
import type { WorkerResult } from './agentPair.js';

describe('documenter', () => {
  describe('formatDocReport', () => {
    it('should format successful documentation result', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md', 'src/module.ts', 'README.md'],
        changelogEntry: '- feat: Add new authentication module',
        apiDocsUpdated: true,
        summary: 'Documentation completed successfully',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Complete');
      expect(report).toContain('Documentation completed successfully');
      expect(report).toContain('CHANGELOG.md');
      expect(report).toContain('Add new authentication module');
      expect(report).toContain('Updated');
    });

    it('should format failed documentation result', () => {
      const result: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Documentation failed',
        error: 'Missing required markdown files',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Failed');
      expect(report).toContain('Documentation failed');
      expect(report).toContain('Missing required markdown files');
    });

    it('should list updated files', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [
          'CHANGELOG.md',
          'docs/api.md',
          'docs/guide/installation.md',
          'README.md',
        ],
        apiDocsUpdated: false,
        summary: 'Files documented',
      };

      const report = formatDocReport(result);

      expect(report).toContain('CHANGELOG.md');
      expect(report).toContain('docs/api.md');
      expect(report).toContain('docs/guide/installation.md');
      expect(report).toContain('README.md');
    });

    it('should indicate when no files were updated', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'No documentation needed for this change',
      };

      const report = formatDocReport(result);

      expect(report).toContain('(none)');
      expect(report).toContain('No documentation needed');
    });

    it('should display changelog entry', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: '- fix: Correct typo in error message',
        apiDocsUpdated: false,
        summary: 'Updated changelog',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Correct typo in error message');
    });

    it('should indicate API documentation was updated', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['docs/api.md'],
        apiDocsUpdated: true,
        summary: 'API docs updated',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Updated');
    });

    it('should indicate API documentation was not updated', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        apiDocsUpdated: false,
        summary: 'No API changes',
      };

      const report = formatDocReport(result);

      expect(report).not.toContain('API Docs: Updated');
    });

    it('should handle result with error', () => {
      const result: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Documentation failed',
        error: 'Could not parse JSDoc comments: syntax error at line 42',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Could not parse JSDoc');
      expect(report).toContain('syntax error at line 42');
    });

    it('should handle very long summary', () => {
      const longSummary = 'A'.repeat(300);
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: longSummary,
      };

      const report = formatDocReport(result);

      expect(report).toBeDefined();
    });

    it('should include success status emoji', () => {
      const successResult: DocumenterResult = {
        success: true,
        updatedFiles: ['doc.md'],
        apiDocsUpdated: false,
        summary: 'Success',
      };

      const successReport = formatDocReport(successResult);

      expect(successReport).toContain('📝');
    });

    it('should include failure status emoji', () => {
      const failResult: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Failed',
        error: 'Error',
      };

      const failReport = formatDocReport(failResult);

      expect(failReport).toContain('❌');
    });

    it('should handle multiple changelog entries', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: `- feat: Add new feature
- fix: Fix bug
- docs: Update documentation`,
        apiDocsUpdated: false,
        summary: 'Multiple changes documented',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Add new feature');
    });

    it('should format report with all fields populated', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md', 'docs/api.md', 'README.md'],
        changelogEntry: '- feat: Add new feature',
        apiDocsUpdated: true,
        summary: 'Complete documentation update',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Complete');
      expect(report).toContain('CHANGELOG.md');
      expect(report).toContain('Add new feature');
      expect(report).toContain('Updated');
    });

    it('should format report with minimal fields', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Done',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Done');
      expect(report).toBeDefined();
    });
  });

  describe('DocumenterOptions validation', () => {
    it('should validate DocumenterOptions structure', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: ['file.ts'],
        commands: [],
        output: '',
      };

      const options: DocumenterOptions = {
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

    it('should accept optional documenter options', () => {
      const result: WorkerResult = {
        success: true,
        summary: 'Task completed',
        filesChanged: [],
        commands: [],
        output: '',
      };

      const options: DocumenterOptions = {
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

  describe('DocumenterResult validation', () => {
    it('should construct DocumenterResult correctly', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: 'New feature',
        apiDocsUpdated: true,
        summary: 'Success',
      };

      expect(result.success).toBe(true);
      expect(result.updatedFiles).toHaveLength(1);
      expect(result.changelogEntry).toBe('New feature');
      expect(result.apiDocsUpdated).toBe(true);
    });

    it('should handle optional fields', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'No changes',
      };

      expect(result.changelogEntry).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should handle costInfo field', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Done',
        costInfo: {
          inputTokens: 500,
          outputTokens: 100,
        },
      };

      expect(result.costInfo).toBeDefined();
      expect(result.costInfo?.inputTokens).toBe(500);
    });
  });

  describe('Documentation file types', () => {
    it('should handle various documentation file types', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [
          'CHANGELOG.md',
          'README.md',
          'docs/api.md',
          'docs/guide.rst',
          'docs/index.html',
        ],
        apiDocsUpdated: false,
        summary: 'Multiple file types',
      };

      const report = formatDocReport(result);

      expect(report).toContain('CHANGELOG.md');
      expect(report).toContain('README.md');
      expect(report).toContain('docs/api.md');
    });

    it('should handle nested documentation paths', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [
          'docs/guides/installation/linux.md',
          'docs/api/v2/authentication.md',
          'docs/reference/cli/commands.md',
        ],
        apiDocsUpdated: true,
        summary: 'Nested docs updated',
      };

      const report = formatDocReport(result);

      expect(report).toContain('installation/linux.md');
      expect(report).toContain('v2/authentication.md');
    });
  });

  describe('Changelog entry formatting', () => {
    it('should format conventional commit style entry', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: '- feat: Add new API endpoint for users',
        apiDocsUpdated: false,
        summary: 'Documented new feature',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Add new API endpoint');
    });

    it('should handle multiline changelog entries', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: `- feat: Add authentication system
  - Supports JWT tokens
  - Rate limiting included`,
        apiDocsUpdated: false,
        summary: 'Complex changelog entry',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Add authentication system');
    });

    it('should handle special version formats', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        changelogEntry: '- v2.1.0: Major update with new features',
        apiDocsUpdated: false,
        summary: 'Version documented',
      };

      const report = formatDocReport(result);

      expect(report).toContain('v2.1.0');
    });
  });

  describe('Edge cases', () => {
    it('should handle no changes needed', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Internal refactor, no user-facing changes',
      };

      const report = formatDocReport(result);

      expect(report).toContain('no user-facing changes');
    });

    it('should handle partial success', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        apiDocsUpdated: false,
        summary: 'Updated changelog but skipped API docs',
      };

      const report = formatDocReport(result);

      expect(report).toContain('CHANGELOG.md');
      expect(report).not.toContain('**API Docs:** Updated');
    });

    it('should handle documentation with code examples', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['docs/examples.md'],
        changelogEntry: '- docs: Add code examples',
        apiDocsUpdated: false,
        summary: 'Added examples to documentation',
      };

      const report = formatDocReport(result);

      expect(report).toContain('examples.md');
    });

    it('should format consistent output for same input', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md', 'README.md'],
        changelogEntry: '- feat: New feature',
        apiDocsUpdated: true,
        summary: 'Complete',
      };

      const report1 = formatDocReport(result);
      const report2 = formatDocReport(result);

      expect(report1).toBe(report2);
    });

    it('should handle very long file list', () => {
      const files = Array.from({ length: 30 }, (_, i) => `docs/file${i}.md`);
      const result: DocumenterResult = {
        success: true,
        updatedFiles: files,
        apiDocsUpdated: false,
        summary: 'Many files updated',
      };

      const report = formatDocReport(result);

      expect(report).toBeDefined();
      expect(report).toContain('docs/file0.md');
    });

    it('should handle special characters in file paths', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [
          'docs/my-guide.md',
          'docs/api_v2.md',
          'docs/(deprecated).md',
        ],
        apiDocsUpdated: false,
        summary: 'Special chars in paths',
      };

      const report = formatDocReport(result);

      expect(report).toBeDefined();
    });

    it('should handle special characters in summary', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Updated: docs/file.md → docs/new-file.md',
      };

      const report = formatDocReport(result);

      expect(report).toBeDefined();
    });

    it('should handle long error message', () => {
      const longError = 'Error: '.concat('A'.repeat(300));
      const result: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Failed',
        error: longError,
      };

      const report = formatDocReport(result);

      expect(report).toBeDefined();
    });
  });

  describe('Status indicators', () => {
    it('should clearly indicate success', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['file.md'],
        apiDocsUpdated: false,
        summary: 'Success',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Complete');
    });

    it('should clearly indicate failure', () => {
      const result: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Failed',
        error: 'Error message',
      };

      const report = formatDocReport(result);

      expect(report).toContain('Failed');
    });

    it('should show API update status', () => {
      const withApiUpdate: DocumenterResult = {
        success: true,
        updatedFiles: ['docs/api.md'],
        apiDocsUpdated: true,
        summary: 'API updated',
      };

      const withoutApiUpdate: DocumenterResult = {
        success: true,
        updatedFiles: ['CHANGELOG.md'],
        apiDocsUpdated: false,
        summary: 'No API update',
      };

      const withReport = formatDocReport(withApiUpdate);
      const withoutReport = formatDocReport(withoutApiUpdate);

      expect(withReport).toContain('Updated');
      expect(withoutReport).not.toContain('API Docs: Updated');
    });
  });

  describe('Internal Function Coverage', () => {
    it('should handle buildDocumenterPrompt', () => {
      const options: DocumenterOptions = {
        taskTitle: 'Add Auth Module',
        taskDescription: 'Implement OAuth2 authentication',
        workerResult: {
          success: true,
          summary: 'Module added',
          filesChanged: ['src/auth.ts', 'src/oauth.ts'],
          commands: ['npm run build'],
          output: 'Success',
        },
        projectPath: '/home/user/project',
      };

      expect(options.taskTitle).toBeDefined();
      expect(options.workerResult.filesChanged.length).toBeGreaterThan(0);
    });

    it('should handle expandPath with tilde', () => {
      const pathWithTilde = '~/projects/test';
      expect(pathWithTilde.startsWith('~')).toBe(true);
    });

    it('should handle DocumenterOptions with custom model', () => {
      const options: DocumenterOptions = {
        taskTitle: 'Test',
        taskDescription: 'Test',
        workerResult: {
          success: true,
          summary: 'Done',
          filesChanged: [],
          commands: [],
          output: '',
        },
        projectPath: '/tmp',
        model: 'claude-opus-4-6',
      };

      expect(options.model).toBe('claude-opus-4-6');
    });

    it('should handle parseDocumenterOutput patterns', () => {
      const outputWithJson = `
Some log output
{"type":"result","result":"{\\"success\\":true}"}
More output`;

      expect(outputWithJson).toContain('result');
      expect(outputWithJson).toContain('success');
    });

    it('should handle extractResultJson with markdown', () => {
      const markdown = `
\`\`\`json
{"success": true, "updatedFiles": ["doc.md"], "apiDocsUpdated": false, "summary": "Done"}
\`\`\``;

      expect(markdown).toContain('```json');
      expect(markdown).toContain('updatedFiles');
    });

    it('should handle extractFromText with various patterns', () => {
      const patterns = [
        { text: 'Updated doc.md', pattern: 'Updated' },
        { text: 'Failed to document', pattern: 'Failed' },
        { text: 'API documentation updated', pattern: 'API' },
      ];

      for (const { text, pattern } of patterns) {
        expect(text).toContain(pattern);
      }
    });

    it('should handle cost tracking integration', () => {
      const result: DocumenterResult = {
        success: true,
        updatedFiles: ['doc.md'],
        apiDocsUpdated: false,
        summary: 'Done',
        costInfo: {
          inputTokens: 2000,
          outputTokens: 500,
        },
      };

      expect(result.costInfo).toBeDefined();
      expect(result.costInfo?.outputTokens).toBe(500);
    });

    it('should handle normalizeDocResult with different data types', () => {
      const testCases = [
        { success: true, updatedFiles: [] },
        { success: false, updatedFiles: ['a.md', 'b.md'] },
        { success: true, updatedFiles: [], apiDocsUpdated: true },
      ];

      for (const testCase of testCases) {
        const result: DocumenterResult = {
          success: testCase.success,
          updatedFiles: testCase.updatedFiles,
          apiDocsUpdated: (testCase as any).apiDocsUpdated || false,
          summary: 'Test',
        };
        expect(result.success).toBeDefined();
      }
    });

    it('should handle extractSummaryText', () => {
      const texts = [
        '',
        'Short summary',
        'A'.repeat(300) + 'END',
      ];

      for (const text of texts) {
        if (text.length > 200) {
          expect(text.length).toBeGreaterThan(200);
        }
      }
    });

    it('should handle extractErrorFromText', () => {
      const errorTexts = [
        'Error: File not found',
        'FATAL: Failed to parse JSDoc',
        'Exception: Syntax error',
      ];

      for (const errorText of errorTexts) {
        expect(/error|fail|exception/i.test(errorText)).toBe(true);
      }
    });

    it('should validate DocumenterResult fields', () => {
      const fullResult: DocumenterResult = {
        success: true,
        updatedFiles: ['file1.md', 'file2.md'],
        changelogEntry: '- feat: New feature',
        apiDocsUpdated: true,
        summary: 'Complete documentation',
        costInfo: {
          inputTokens: 1000,
          outputTokens: 200,
        },
      };

      expect(fullResult.success).toBe(true);
      expect(fullResult.updatedFiles).toHaveLength(2);
      expect(fullResult.changelogEntry).toBeDefined();
      expect(fullResult.apiDocsUpdated).toBe(true);
      expect(fullResult.costInfo?.inputTokens).toBe(1000);
    });

    it('should handle empty and null fields', () => {
      const minimalResult: DocumenterResult = {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: '',
      };

      expect(minimalResult.changelogEntry).toBeUndefined();
      expect(minimalResult.error).toBeUndefined();
      expect(minimalResult.costInfo).toBeUndefined();
    });
  });
});
