// The reviewer states whether the change covers the whole issue (AGT-4786);
// a missing or unreadable value stays undefined (= unknown, published as partial).

import { beforeAll, describe, expect, it } from 'vitest';
import { parseReviewerResult } from '../adapters/resultParsing.js';
import { ClaudeCliAdapter } from '../adapters/claude.js';
import { initLocale } from '../locale/index.js';
import { REVIEWER_FORMAT_REPAIR_PROMPT, buildReviewerPrompt } from './reviewer.js';

const verdict = (extra: Record<string, unknown>) =>
  '```json\n' + JSON.stringify({ decision: 'approve', feedback: 'Fixes 2 of the 15 defects.', issues: [], suggestions: [], ...extra }) + '\n```';

describe('reviewer coverage parse (AGT-4786)', () => {
  beforeAll(() => { initLocale('en'); });

  it('parses coverage from the JSON verdict', () => {
    expect(parseReviewerResult(verdict({ coverage: 'partial' })).coverage).toBe('partial');
    expect(parseReviewerResult(verdict({ coverage: 'complete' })).coverage).toBe('complete');
    expect(parseReviewerResult(verdict({ coverage: ' Complete ' })).coverage).toBe('complete');
  });

  it('leaves coverage unknown (undefined) when missing or not one of the two values', () => {
    expect(parseReviewerResult(verdict({})).coverage).toBeUndefined();
    expect(parseReviewerResult(verdict({ coverage: 'mostly' })).coverage).toBeUndefined();
    expect(parseReviewerResult(verdict({ coverage: true })).coverage).toBeUndefined();
    expect('coverage' in parseReviewerResult(verdict({}))).toBe(false);
  });

  it('reads a declared Coverage line in a prose verdict', () => {
    expect(parseReviewerResult('Decision: approve\nCoverage: partial\nLooks right for the two rows.').coverage).toBe('partial');
    expect(parseReviewerResult('Decision: approve\nLooks right.').coverage).toBeUndefined();
  });

  it('the Claude CLI adapter keeps coverage too', () => {
    const stdout = JSON.stringify({ type: 'result', result: verdict({ coverage: 'complete' }) });
    expect(new ClaudeCliAdapter().parseReviewerOutput({ exitCode: 0, stdout, stderr: '', durationMs: 1 } as never).coverage).toBe('complete');
  });

  it('asks for coverage in the review prompt and the format-repair turn', () => {
    const prompt = buildReviewerPrompt({
      taskTitle: 't', taskDescription: 'd', projectPath: '/repo',
      workerResult: { success: true, summary: 's', filesChanged: ['a.ts'], commands: [], output: '' },
    });
    expect(prompt).toContain('"coverage": "partial"');
    expect(prompt).toMatch(/independent of `decision`/);
    expect(REVIEWER_FORMAT_REPAIR_PROMPT).toContain('"coverage": "complete" | "partial"');
  });
});
