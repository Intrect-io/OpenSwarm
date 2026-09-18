import { describe, expect, it } from 'vitest';
import {
  GUARD_WARNING_ISSUE_CHARS,
  GUARD_WARNING_LOG_CAP,
  GUARD_WARNING_RECORD_CAP,
  formatGuardWarningLine,
  guardWarningRecords,
  guardWarningsForResult,
  nonBlockingWarnings,
} from './guardWarningRecord.js';
import type { GuardResult } from './pipelineGuards.js';

function guard(overrides: Partial<GuardResult> & { guard: string }): GuardResult {
  return { passed: false, issues: [], blocking: false, ...overrides };
}

/** The shape observed on cgf-portal AX-1556, 2026-09-18. */
const BS_DETECTOR = guard({
  guard: 'bsDetector',
  issues: [
    'apps/pipelines/src/cgf_pipelines/a2_fixed_expense_master.py:118 possible fake/mock data detected: "TODO"',
    'apps/pipelines/tests/test_a2_fixed_expense_master.py:44 possible fake/mock data detected: "dummy"',
  ],
});

describe('nonBlockingWarnings (AGT-4439)', () => {
  it('keeps only the guards that failed without blocking', () => {
    const results = [
      BS_DETECTOR,
      guard({ guard: 'typecheck', blocking: true, issues: ['TypeScript check failed'] }),
      guard({ guard: 'reformatCheck', passed: true }),
    ];
    expect(nonBlockingWarnings(results).map((r) => r.guard)).toEqual(['bsDetector']);
  });

  it('treats a missing results array as nothing to report', () => {
    expect(nonBlockingWarnings()).toEqual([]);
    expect(formatGuardWarningLine()).toBe('');
    expect(guardWarningsForResult()).toBeUndefined();
  });
});

describe('formatGuardWarningLine (AGT-4439)', () => {
  it('names the guard, the count and the issues — not just the guard', () => {
    const line = formatGuardWarningLine([BS_DETECTOR]);
    expect(line).toContain('bsDetector (2):');
    expect(line).toContain('a2_fixed_expense_master.py:118');
    expect(line).toContain('test_a2_fixed_expense_master.py:44');
    // What the old line said, and all it said.
    expect(line).not.toBe('Guard warnings: bsDetector');
  });

  it('reports the real count even when the list is cut, so truncation cannot understate', () => {
    const many = guard({
      guard: 'deadModuleCheck',
      issues: Array.from({ length: GUARD_WARNING_LOG_CAP + 4 }, (_, i) => `issue ${i}`),
    });
    const line = formatGuardWarningLine([many]);
    expect(line).toContain(`deadModuleCheck (${GUARD_WARNING_LOG_CAP + 4}):`);
    expect(line).toContain('(+4 more)');
    expect(line).toContain('issue 0');
    expect(line).not.toContain(`issue ${GUARD_WARNING_LOG_CAP}`);
  });

  it('clips one long issue and flattens its newlines, so a quoted file cannot own the log', () => {
    const line = formatGuardWarningLine([guard({
      guard: 'rewriteCheck',
      issues: [`head\n${'x'.repeat(GUARD_WARNING_ISSUE_CHARS * 2)}\ntail`],
    })]);
    expect(line).not.toContain('\n');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(GUARD_WARNING_ISSUE_CHARS * 2);
  });

  it('separates several warning guards so neither is lost in the other', () => {
    const line = formatGuardWarningLine([BS_DETECTOR, guard({ guard: 'reformatCheck', issues: ['whitespace-only churn'] })]);
    expect(line).toContain('bsDetector (2):');
    expect(line).toContain('reformatCheck (1): whitespace-only churn');
  });
});

describe('guardWarningRecords (AGT-4439)', () => {
  it('records each warning guard with its issues', () => {
    expect(guardWarningRecords([BS_DETECTOR])).toEqual([{
      guard: 'bsDetector',
      issues: BS_DETECTOR.issues,
      omitted: 0,
    }]);
  });

  it('counts what it dropped rather than losing it silently', () => {
    const many = guard({
      guard: 'bsDetector',
      issues: Array.from({ length: GUARD_WARNING_RECORD_CAP + 7 }, (_, i) => `issue ${i}`),
    });
    const [record] = guardWarningRecords([many]);
    expect(record.issues).toHaveLength(GUARD_WARNING_RECORD_CAP);
    expect(record.omitted).toBe(7);
  });

  it('omits the field for a clean run instead of storing an empty array', () => {
    expect(guardWarningsForResult([guard({ guard: 'bsDetector', passed: true })])).toBeUndefined();
    expect(guardWarningsForResult([BS_DETECTOR])).toHaveLength(1);
  });

  it('leaves blocking guards out — their reason travels in the worker feedback', () => {
    const blocking = guard({ guard: 'typecheck', blocking: true, issues: ['TypeScript check failed: x'] });
    expect(guardWarningsForResult([blocking])).toBeUndefined();
  });
});
