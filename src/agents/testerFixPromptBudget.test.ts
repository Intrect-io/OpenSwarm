// `failedTests`/`suggestions` come straight from the tester's JSON through
// `parseTesterOutput`, which checks only `Array.isArray` — a malformed result
// yields entries of any JSON type. These lock down what `buildTestFixPrompt`
// does with them: it must compose a bounded prompt, never throw, and never let
// an entry's own size or shape escape the bound. (AGT-3466)
import { describe, it, expect } from 'vitest';
import { PROMPT_FEEDBACK_LIMIT } from '../support/outputBudget.js';
import { parseTesterOutput, buildTestFixPrompt, type TesterResult } from './tester.js';

function baseResult(overrides: Partial<TesterResult> = {}): TesterResult {
  return { success: false, testsPassed: 2, testsFailed: 3, output: '', ...overrides };
}

describe('buildTestFixPrompt survives a malformed tester result', () => {
  it('renders non-string entries instead of throwing on them', () => {
    // `truncate` reads `.length`, which a number or a plain object does not
    // have: before the guard the whole repair prompt threw a TypeError and the
    // self-repair iteration lost its feedback entirely.
    const parsed = parseTesterOutput(JSON.stringify({
      type: 'result',
      result: JSON.stringify({ success: false, testsPassed: 0, testsFailed: 3, failedTests: [42, { a: 1 }, null] }),
    }));
    expect(parsed.failedTests).toEqual([42, { a: 1 }, null]);

    const prompt = buildTestFixPrompt(parsed);
    expect(prompt).toContain('## Test Failures');
    expect(prompt).toContain('42');
    expect(prompt).toContain('(malformed entry: 1 keys)');
    expect(prompt).toContain('null');
    expect(prompt.trimEnd().endsWith('Fix the above test failures.')).toBe(true);
  });

  it('summarizes a nested array by shape, not by materializing it and losing the instruction', () => {
    // `truncate` checks `.length`, which an array HAS, so it passed a nested
    // array through unclipped, `String()` then built the full multi-megabyte
    // text, and the aggregate cut — a tail cut — removed the closing
    // instruction along with it. The entry's own size is what must not escape.
    const nested = ['x'.repeat(1_000_000)];
    const prompt = buildTestFixPrompt(baseResult({ failedTests: [nested] }));
    expect(prompt).toContain('(malformed entry: 1 items)');
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_FEEDBACK_LIMIT);
    expect(prompt.trimEnd().endsWith('Fix the above test failures.')).toBe(true);
  });

  it('summarizes a wide nested array by shape too', () => {
    const nested = Array.from({ length: 50_000 }, () => 'z');
    const prompt = buildTestFixPrompt(baseResult({ failedTests: [nested] }));
    expect(prompt).toContain('(malformed entry: 50000 items)');
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_FEEDBACK_LIMIT);
    expect(prompt.trimEnd().endsWith('Fix the above test failures.')).toBe(true);
  });

  it('holds the aggregate bound for 100 oversized entries and keeps both lists', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `suite::case_${i} ${'x'.repeat(5_000)}`);
    const prompt = buildTestFixPrompt(baseResult({ failedTests: entries, suggestions: entries }));

    expect(prompt.length).toBeLessThanOrEqual(PROMPT_FEEDBACK_LIMIT);
    expect(prompt).toContain('### Failed Tests:');
    expect(prompt).toContain('### Fix Suggestions:');
    expect(prompt.trimEnd().endsWith('Fix the above test failures.')).toBe(true);
    // The counts a malformed result claims are still reported.
    expect(prompt).toContain('**Passed:** 2 | **Failed:** 3');
    expect(prompt).toContain('… +');
  });

  it('leaves a normal small result unchanged', () => {
    const prompt = buildTestFixPrompt(baseResult({
      failedTests: ['test_a', 'test_b'],
      suggestions: ['Check null handling', 'Add missing import'],
    }));

    expect(prompt).toContain('1. `test_a`');
    expect(prompt).toContain('2. `test_b`');
    expect(prompt).toContain('1. Check null handling');
    expect(prompt).toContain('2. Add missing import');
    expect(prompt.trimEnd().endsWith('Fix the above test failures.')).toBe(true);
  });
});
