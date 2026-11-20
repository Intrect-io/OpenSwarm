import { describe, it, expect } from 'vitest';
import { parseTesterOutput } from './tester.js';

// The tester is a BLOCKING stage. Its text fallback used "no error keyword ⇒
// success", so an empty/degenerate run faked a PASS and let unverified code
// through. Only genuinely empty output is now flagged — short-but-real output
// (e.g. "collected 0 items") must still pass. (INT-2521)
describe('parseTesterOutput fake-pass guard (INT-2521)', () => {
  it('empty output is NOT a pass — unverified', () => {
    const r = parseTesterOutput('');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unverified|no output/i);
  });

  it('whitespace-only output is NOT a pass', () => {
    expect(parseTesterOutput('   \n\t  ').success).toBe(false);
  });

  it('real "N passed" output IS a pass', () => {
    expect(parseTesterOutput('5 passed, 0 failed in 1.2s').success).toBe(true);
  });

  it('a legitimate short "no tests" run still passes (not mis-flagged)', () => {
    expect(parseTesterOutput('collected 0 items').success).toBe(true);
  });

  it('a failing run is not a pass', () => {
    expect(parseTesterOutput('2 failed, 3 passed').success).toBe(false);
  });
});

describe('parseTesterOutput validates result field types (AGT-3441)', () => {
  const wrap = (obj: unknown) => JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify(obj) + '\n```' });

  it('does not coerce a string "false" into success', () => {
    const r = parseTesterOutput(wrap({ success: 'false', testsPassed: 1, testsFailed: 2 }));
    expect(r.success).toBe(false);
  });

  it('keeps only string list entries, clipped and capped', () => {
    const r = parseTesterOutput(wrap({
      success: false,
      testsFailed: 1,
      failedTests: ['a.test.ts > case', 42, null, { x: 1 }, '', 'z'.repeat(2000)],
      suggestions: [{ nested: true }],
    }));
    expect(r.failedTests?.[0]).toBe('a.test.ts > case');
    expect(r.failedTests).toHaveLength(2);
    expect(r.failedTests?.[1].length).toBe(500);
    expect(r.suggestions).toBeUndefined();
  });

  it('drops non-finite or negative counts and non-string errors', () => {
    const r = parseTesterOutput(wrap({ success: false, testsPassed: -3, testsFailed: '7', coverage: 'high', error: { code: 1 } }));
    expect(r.testsPassed).toBe(0);
    expect(r.testsFailed).toBe(0);
    expect(r.coverage).toBeUndefined();
    expect(r.error).toBeUndefined();
  });
});
