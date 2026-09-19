// ============================================
// OpenSwarm - Guard Dispute Arbiter tests (AGT-4462)
// ============================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FileDiffDetail } from '../support/gitTracker.js';

const { getWorkingDiffDetail, getAddedLinesForFile, spawnCli, getAdapter, getDefaultAdapterName, resolveBoundarySafeDefaultModel } = vi.hoisted(() => ({
  getWorkingDiffDetail: vi.fn(),
  getAddedLinesForFile: vi.fn(),
  spawnCli: vi.fn(),
  getAdapter: vi.fn(),
  getDefaultAdapterName: vi.fn(),
  resolveBoundarySafeDefaultModel: vi.fn(),
}));

vi.mock('../support/gitTracker.js', () => ({ getWorkingDiffDetail }));

vi.mock('./pipelineGuards.js', async () => {
  const actual = await vi.importActual<typeof import('./pipelineGuards.js')>('./pipelineGuards.js');
  return { ...actual, getAddedLinesForFile };
});

vi.mock('../adapters/index.js', () => ({
  spawnCli,
  getAdapter,
  getDefaultAdapterName,
  resolveBoundarySafeDefaultModel,
}));

import { parseContractEvidenceIssues, adjudicateContractEvidenceStagnation } from './guardArbiter.js';

function diffDetail(overrides: Partial<FileDiffDetail> = {}): FileDiffDetail {
  return { file: 'src/example.ts', added: 1, deleted: 0, isNew: false, whitespaceOnly: false, ...overrides };
}

describe('parseContractEvidenceIssues', () => {
  it('extracts file and literal from the guard\'s own message shape', () => {
    const issues = [
      '[apps/pipelines/tests/test_foundation.py] test adds contract literal "day_of_month" but it is not present in HEAD and no producer/consumer evidence was cited. Avoid self-referential contract tests.',
    ];
    expect(parseContractEvidenceIssues(issues)).toEqual([
      { file: 'apps/pipelines/tests/test_foundation.py', literal: 'day_of_month' },
    ]);
  });

  it('handles a literal containing embedded quote characters via greedy backtracking', () => {
    const issues = [
      String.raw`[t.py] test adds contract literal "c2-run:{run_id}" but it is not present in HEAD and no producer/consumer evidence was cited. Avoid self-referential contract tests.`,
    ];
    expect(parseContractEvidenceIssues(issues)).toEqual([{ file: 't.py', literal: 'c2-run:{run_id}' }]);
  });

  it('ignores issue strings from unrelated guards', () => {
    expect(parseContractEvidenceIssues(['[cache.ts] TS2322: type mismatch'])).toEqual([]);
  });

  it('returns an empty list for an empty issues array', () => {
    expect(parseContractEvidenceIssues([])).toEqual([]);
  });
});

describe('adjudicateContractEvidenceStagnation', () => {
  const issue =
    '[apps/pipelines/tests/test_foundation.py] test adds contract literal "day_of_month" but it is not present in HEAD and no producer/consumer evidence was cited. Avoid self-referential contract tests.';

  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultAdapterName.mockReturnValue('openrouter');
    getAdapter.mockReturnValue({ name: 'openrouter' });
    resolveBoundarySafeDefaultModel.mockResolvedValue('some-model');
  });

  it('fails closed with no model call when no issue is parseable', async () => {
    const result = await adjudicateContractEvidenceStagnation({
      issues: ['[cache.ts] TS2322: type mismatch'],
      projectPath: '/repo',
    });
    expect(result.overridden).toBe(false);
    expect(result.verdicts).toEqual([]);
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('fails closed with no model call when no non-test file changed in the diff', async () => {
    getWorkingDiffDetail.mockResolvedValue([
      diffDetail({ file: 'apps/pipelines/tests/test_foundation.py' }),
    ]);
    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });
    expect(result.overridden).toBe(false);
    expect(result.verdicts[0].selfDefining).toBe(false);
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('overrides the guard when the model confirms the literal is self-defining', async () => {
    getWorkingDiffDetail.mockResolvedValue([
      diffDetail({ file: 'apps/pipelines/tests/test_foundation.py' }),
      diffDetail({ file: 'apps/pipelines/src/scheduler.py' }),
    ]);
    getAddedLinesForFile.mockResolvedValue('    day_of_month: int | None = None\n');
    spawnCli.mockResolvedValue({
      stdout: 'VERDICT: day_of_month | SELF_DEFINING | this diff\'s scheduler.py adds this dataclass field',
    });

    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });

    expect(result.overridden).toBe(true);
    expect(result.verdicts).toEqual([
      { literal: 'day_of_month', selfDefining: true, reasoning: "this diff's scheduler.py adds this dataclass field" },
    ]);
    expect(spawnCli).toHaveBeenCalledTimes(1);
    const promptArg = spawnCli.mock.calls[0][1].prompt as string;
    expect(promptArg).toContain('day_of_month');
    expect(promptArg).toContain('scheduler.py');
  });

  it('overrides even when the model echoes the literal wrapped in quotes (AX-1584 live-fire regression)', async () => {
    // Confirmed live against the real AX-1584 diff: the model reasoned
    // correctly (SELF_DEFINING, citing the exact producer evidence) but
    // echoed the literal as `"c2-run:{run_id}"` instead of bare — an
    // exact-match parser silently discarded a correct verdict as missing.
    getWorkingDiffDetail.mockResolvedValue([diffDetail({ file: 'apps/pipelines/src/portal_read_model.py' })]);
    getAddedLinesForFile.mockResolvedValue('KNOWN_PRODUCERS = frozenset({"c2-run", ...})\n');
    spawnCli.mockResolvedValue({
      stdout: 'VERDICT: "c2-run:{run_id}" | SELF_DEFINING | this diff adds "c2-run" to KNOWN_PRODUCERS',
    });

    const contractIssue =
      '[t.py] test adds contract literal "c2-run:{run_id}" but it is not present in HEAD and no producer/consumer evidence was cited. Avoid self-referential contract tests.';
    const result = await adjudicateContractEvidenceStagnation({ issues: [contractIssue], projectPath: '/repo' });

    expect(result.overridden).toBe(true);
    expect(result.verdicts).toEqual([
      { literal: 'c2-run:{run_id}', selfDefining: true, reasoning: 'this diff adds "c2-run" to KNOWN_PRODUCERS' },
    ]);
  });

  it('does not override when the model rejects the literal as a fabricated contract', async () => {
    getWorkingDiffDetail.mockResolvedValue([diffDetail({ file: 'apps/pipelines/src/handler.py' })]);
    getAddedLinesForFile.mockResolvedValue('    response = call_external("day_of_month")\n');
    spawnCli.mockResolvedValue({
      stdout: 'VERDICT: day_of_month | NOT_SELF_DEFINING | this looks like an external API field, not a new definition',
    });

    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });

    expect(result.overridden).toBe(false);
    expect(result.verdicts[0].selfDefining).toBe(false);
  });

  it('fails closed when the model omits a verdict for a disputed literal', async () => {
    getWorkingDiffDetail.mockResolvedValue([diffDetail({ file: 'apps/pipelines/src/handler.py' })]);
    getAddedLinesForFile.mockResolvedValue('    pass\n');
    spawnCli.mockResolvedValue({ stdout: 'I am not sure, please clarify.' });

    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });

    expect(result.overridden).toBe(false);
    expect(result.verdicts[0]).toMatchObject({ literal: 'day_of_month', selfDefining: false });
  });

  it('requires every disputed literal to be self-defining — one rejection sinks the whole override', async () => {
    const secondIssue =
      '[t.py] test adds contract literal "some_url_path" but it is not present in HEAD and no producer/consumer evidence was cited. Avoid self-referential contract tests.';
    getWorkingDiffDetail.mockResolvedValue([diffDetail({ file: 'apps/pipelines/src/handler.py' })]);
    getAddedLinesForFile.mockResolvedValue('    day_of_month: int | None = None\n');
    spawnCli.mockResolvedValue({
      stdout: [
        'VERDICT: day_of_month | SELF_DEFINING | defined here',
        'VERDICT: some_url_path | NOT_SELF_DEFINING | looks external',
      ].join('\n'),
    });

    const result = await adjudicateContractEvidenceStagnation({
      issues: [issue, secondIssue],
      projectPath: '/repo',
    });

    expect(result.overridden).toBe(false);
    expect(result.verdicts).toHaveLength(2);
  });

  it('fails closed when the adapter call throws (timeout, quota, etc.)', async () => {
    getWorkingDiffDetail.mockResolvedValue([diffDetail({ file: 'apps/pipelines/src/handler.py' })]);
    getAddedLinesForFile.mockResolvedValue('    day_of_month: int | None = None\n');
    spawnCli.mockRejectedValue(new Error('adapter timed out'));

    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });

    expect(result.overridden).toBe(false);
    expect(result.summary).toContain('adapter timed out');
  });

  it('fails closed when getWorkingDiffDetail itself throws', async () => {
    getWorkingDiffDetail.mockRejectedValue(new Error('git diff failed'));
    const result = await adjudicateContractEvidenceStagnation({ issues: [issue], projectPath: '/repo' });
    expect(result.overridden).toBe(false);
    expect(spawnCli).not.toHaveBeenCalled();
  });
});
