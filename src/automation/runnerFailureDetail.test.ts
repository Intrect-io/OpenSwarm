import { describe, expect, it } from 'vitest';
import {
  MAX_FAILURE_DETAIL_CHARS,
  clipFailureDetail,
  pickPipelineFailureDetail,
} from './runnerState.js';
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import type { VerifyEvidence } from '../verify/runner.js';

/**
 * The AX-1556 shape (cgf-portal, 2026-09-18): 2013 tests pass, one contract
 * test fails, and pytest prints a screenful of progress dots before the
 * summary. Head-slicing this stored dots only.
 */
const PYTEST_BANNER = '[pytest:apps/pipelines] ..... [  1%]\n';
const PYTEST_DOTS = `${'.'.repeat(72)} [  3%]\n`.repeat(60);
const PYTEST_SUMMARY = [
  "E       assert not [('cgf_materials.py:1135', {'key': 'automatic_debit', 'type': 'boolean'},",
  `        "'boolean' is not one of ['text', 'date', 'datetime', 'number', 'money', 'status']")]`,
  'tests/test_contracts.py:551: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_contracts.py::test_dataset_column_schema_describes_every_column_this_repo_builds',
  '1 failed, 2013 passed, 139 skipped in 26.10s',
].join('\n');
const PYTEST_OUTPUT = `${PYTEST_BANNER}${PYTEST_DOTS}${PYTEST_SUMMARY}`;

function evidence(overrides: Partial<VerifyEvidence> & { name: string }): VerifyEvidence {
  const { name, ...rest } = overrides;
  return {
    command: { name, run: name, kind: 'test' },
    baseStatus: 'pass',
    headStatus: 'pass',
    newFailure: false,
    rawOutputTail: '',
    durationMs: 1,
    ...rest,
  } as VerifyEvidence;
}

describe('clipFailureDetail (AGT-4436)', () => {
  it('leaves a detail under the cap byte-identical, with no marker', () => {
    expect(clipFailureDetail(PYTEST_SUMMARY)).toBe(PYTEST_SUMMARY);
    expect(clipFailureDetail(PYTEST_SUMMARY)).not.toContain('elided');
  });

  it('keeps the failing test and the rejected value that head-slicing dropped', () => {
    expect(PYTEST_OUTPUT.length).toBeGreaterThan(MAX_FAILURE_DETAIL_CHARS);
    const clipped = clipFailureDetail(PYTEST_OUTPUT);

    expect(clipped).toContain('FAILED tests/test_contracts.py::test_dataset_column_schema');
    expect(clipped).toContain("'boolean' is not one of");
    expect(clipped).toContain('1 failed, 2013 passed');
    // What the old head slice returned instead.
    expect(PYTEST_OUTPUT.slice(0, MAX_FAILURE_DETAIL_CHARS)).not.toContain('FAILED');
  });

  it('still names the suite that spoke, so the worker knows which runner failed', () => {
    const clipped = clipFailureDetail(PYTEST_OUTPUT);
    expect(clipped).toContain('[pytest:apps/pipelines]');
    expect(clipped).toContain('elided');
  });

  it('honours the cap exactly — the prompt budget is why it exists', () => {
    expect(clipFailureDetail('x'.repeat(5000)).length).toBe(MAX_FAILURE_DETAIL_CHARS);
    expect(clipFailureDetail(PYTEST_OUTPUT).length).toBe(MAX_FAILURE_DETAIL_CHARS);
  });

  it('falls back to a pure tail when the cap is too small to hold head and marker', () => {
    const clipped = clipFailureDetail(`prefix-${'y'.repeat(200)}-TAIL`, 12);
    expect(clipped).toBe('y'.repeat(7) + '-TAIL');
    expect(clipped.length).toBe(12);
  });
});

describe('pickPipelineFailureDetail tester evidence (AGT-4436)', () => {
  const base = { success: false, stages: [] } as unknown as PipelineResult;

  it('reports only the commands that failed, not the ones that passed', () => {
    const detail = pickPipelineFailureDetail({
      ...base,
      testerResult: {
        success: false,
        testsPassed: 2013,
        testsFailed: 1,
        output: '[ruff:apps/pipelines] All checks passed!',
        verificationEvidence: [
          evidence({ name: 'ruff:apps/pipelines', rawOutputTail: 'All checks passed!' }),
          evidence({
            name: 'pytest:apps/pipelines',
            headStatus: 'fail',
            newFailure: true,
            rawOutputTail: PYTEST_SUMMARY,
          }),
        ],
      },
    } as unknown as PipelineResult);

    expect(detail).toContain('[pytest:apps/pipelines]');
    expect(detail).toContain('FAILED tests/test_contracts.py');
    expect(detail).not.toContain('All checks passed!');
  });

  it('puts a new failure ahead of a pre-existing one, so the clip cannot lose it', () => {
    const detail = pickPipelineFailureDetail({
      ...base,
      testerResult: {
        success: false,
        testsPassed: 0,
        testsFailed: 2,
        output: 'ignored',
        verificationEvidence: [
          evidence({
            name: 'pytest:legacy',
            baseStatus: 'fail',
            headStatus: 'fail',
            newFailure: false,
            rawOutputTail: 'pre-existing breakage',
          }),
          evidence({
            name: 'pytest:apps/pipelines',
            headStatus: 'fail',
            newFailure: true,
            rawOutputTail: 'the change broke this',
          }),
        ],
      },
    } as unknown as PipelineResult);

    expect(detail?.indexOf('the change broke this')).toBeLessThan(detail!.indexOf('pre-existing breakage'));
  });

  it('falls back to the raw output when no evidence was recorded', () => {
    const detail = pickPipelineFailureDetail({
      ...base,
      testerResult: { success: false, testsPassed: 0, testsFailed: 1, output: 'plain runner output' },
    } as unknown as PipelineResult);

    expect(detail).toBe('plain runner output');
  });

  it('ignores evidence when every command passed — success=false came from elsewhere', () => {
    const detail = pickPipelineFailureDetail({
      ...base,
      testerResult: {
        success: false,
        testsPassed: 1,
        testsFailed: 0,
        output: 'coverage below threshold',
        verificationEvidence: [evidence({ name: 'vitest', rawOutputTail: 'ok' })],
      },
    } as unknown as PipelineResult);

    expect(detail).toBe('coverage below threshold');
  });
});
