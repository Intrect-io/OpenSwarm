import { describe, it, expect } from 'vitest';
import { buildTestFixPrompt, TEST_FIX_PROMPT_BUDGET_CHARS, type TesterResult } from './tester.js';

// `failedTests`/`suggestions` come straight from the tester's JSON without
// validation (parseTesterOutput), and this prompt is carried into the next
// worker prompt as untrusted data. Before the bounds, 100 oversized entries
// composed a 1,004,282-character prompt and a single 1 MB entry a
// 1,000,114-character one — enough to blow a provider request limit.
describe('buildTestFixPrompt bounds a malformed tester result', () => {
  function baseResult(overrides: Partial<TesterResult> = {}): TesterResult {
    return { success: false, testsPassed: 2, testsFailed: 3, output: '', ...overrides };
  }

  it('bounds 100 oversized entries and says so', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `suite::case_${i} ${'x'.repeat(5_000)}`);
    const prompt = buildTestFixPrompt(baseResult({ failedTests: entries, suggestions: entries }));

    expect(prompt.length).toBeLessThanOrEqual(TEST_FIX_PROMPT_BUDGET_CHARS);
    expect(prompt).toContain('## Report withheld (prompt budget)');
    // The notice, not just the marker: the worker must know entries are missing.
    expect(prompt).toContain('the rest is not here');
    expect(prompt).toContain('Fix the above test failures.');

    // Both lists stay represented — a bound that dropped every suggestion
    // would leave the worker nothing to act on — and each notice states its
    // own real count, so a partial report cannot read as the whole one.
    const listed = [...prompt.matchAll(/(Failed Tests|Fix Suggestions): (\d+) of (\d+) listed, (\d+) cut short/g)];
    expect(listed.map((m) => m[1])).toEqual(['Failed Tests', 'Fix Suggestions']);
    for (const [, , shown, total, clipped] of listed) {
      expect(Number(shown)).toBeGreaterThan(0);
      expect(Number(shown)).toBeLessThan(100);
      expect(total).toBe('100');
      expect(Number(clipped)).toBe(Number(shown));
    }
    // The elided entries are genuinely absent, not merely announced.
    expect(prompt).not.toContain('suite::case_99');
  });

  it('bounds a single 1 MB entry and says so', () => {
    const prompt = buildTestFixPrompt(baseResult({ failedTests: [`suite::huge ${'z'.repeat(1_000_000)}`] }));

    expect(prompt.length).toBeLessThanOrEqual(TEST_FIX_PROMPT_BUDGET_CHARS);
    expect(prompt).toContain('## Report withheld (prompt budget)');
    expect(prompt).toContain('1 cut short (marked in place)');
    expect(prompt).toContain('Fix the above test failures.');
  });

  it('leaves a normal small result unchanged', () => {
    const prompt = buildTestFixPrompt(baseResult({
      failedTests: ['test_a', 'test_b'],
      suggestions: ['Check null handling'],
    }));

    expect(prompt).toBe([
      '## Test Failures',
      '',
      '**Passed:** 2 | **Failed:** 3',
      '',
      '### Failed Tests:',
      '1. `test_a`',
      '2. `test_b`',
      '',
      '### Fix Suggestions:',
      '1. Check null handling',
      '',
      'Fix the above test failures.',
    ].join('\n'));
    expect(prompt).not.toContain('withheld');
  });

  it('still reports the counts a malformed result claims', () => {
    const entries = Array.from({ length: 100 }, () => 'y'.repeat(5_000));
    const prompt = buildTestFixPrompt(baseResult({ testsPassed: 7, testsFailed: 93, failedTests: entries }));

    expect(prompt).toContain('**Passed:** 7 | **Failed:** 93');
  });
});
