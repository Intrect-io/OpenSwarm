import { describe, it, expect } from 'vitest';
import { parseReviewerResult } from './resultParsing.js';

const wrap = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';

describe('parseReviewerResult text-fallback decision (INT-2485 false-reject)', () => {
  it('does NOT reject a revise whose prose mentions the domain word "reject"', () => {
    // STO-1451: a financial hard-reject bug. The reviewer's plain-text feedback
    // begins "Decision: revise" but discusses the reject logic — old parser saw
    // "reject" and killed the task.
    const text = 'Decision: revise\nThe DCF/ROE path incorrectly downgrades large-accumulation stocks to a hard reject; fix the stale/missing input handling before this can pass.';
    expect(parseReviewerResult(text).decision).toBe('revise');
  });

  it('honors an explicit reject verdict', () => {
    expect(parseReviewerResult('Decision: reject\nThis fundamentally breaks the API contract.').decision).toBe('reject');
  });

  it('honors an explicit approve verdict', () => {
    expect(parseReviewerResult('Decision: approve\nLooks good, ships.').decision).toBe('approve');
  });

  it('defaults to the safe revise when no explicit verdict is present', () => {
    expect(parseReviewerResult('The code rejects invalid input and approves valid tokens.').decision).toBe('revise');
  });

  it('rejects an empty result instead of fabricating a finding-less REVISE', () => {
    expect(() => parseReviewerResult('  \n ')).toThrow('Reviewer output was empty');
  });

  it('preserves issues and suggestions from plain-text fallback output', () => {
    const result = parseReviewerResult(
      'Decision: revise\nNeeds work.\nIssues:\n- Missing retry test\nSuggestions:\n- Add boundary coverage',
    );
    expect(result.issues).toEqual(['Missing retry test']);
    expect(result.suggestions).toEqual(['Add boundary coverage']);
  });
});

describe('parseReviewerResult recommendedActions (INT-1954)', () => {
  it('parses structured recommendedActions on approve', () => {
    const r = parseReviewerResult(
      wrap({
        decision: 'approve',
        feedback: 'lgtm',
        issues: [],
        suggestions: [],
        recommendedActions: [
          { type: 'test', title: 'add edge-case coverage', location: 'src/x.ts:10' },
          { type: 'refactor', title: 'extract helper' },
        ],
      }),
    );
    expect(r.decision).toBe('approve');
    expect(r.recommendedActions).toEqual([
      { type: 'test', title: 'add edge-case coverage', location: 'src/x.ts:10' },
      { type: 'refactor', title: 'extract helper', location: undefined },
    ]);
  });

  it('defaults a missing type to follow-up and drops title-less entries', () => {
    const r = parseReviewerResult(
      wrap({ decision: 'approve', feedback: 'ok', recommendedActions: [{ title: 'do x' }, { type: 'bug' }] }),
    );
    expect(r.recommendedActions).toEqual([{ type: 'follow-up', title: 'do x', location: undefined }]);
  });

  it('is undefined when absent or empty', () => {
    expect(parseReviewerResult(wrap({ decision: 'approve', feedback: 'ok' })).recommendedActions).toBeUndefined();
    expect(
      parseReviewerResult(wrap({ decision: 'approve', feedback: 'ok', recommendedActions: [] })).recommendedActions,
    ).toBeUndefined();
  });
});

describe('parseReviewerResult rejects unsubstantiated verdicts (INT-3182)', () => {
  it('throws when the body is only a provider control token', () => {
    // Measured: on a 35-file diff, deepseek-v4-pro read everything across 22 API
    // calls and then emitted this as its entire final message. It is non-empty, so
    // it cleared the empty-output guard and became REVISE with zero findings.
    expect(() => parseReviewerResult('<｜｜DSML｜｜tool_calls>')).toThrow(/control tokens/);
  });

  it('throws for other providers\' sentinels too', () => {
    expect(() => parseReviewerResult('<|im_start|>')).toThrow(/control tokens/);
    expect(() => parseReviewerResult('  <|eot_id|>\n<|im_end|>  ')).toThrow(/control tokens/);
  });

  it('throws when a non-approving verdict carries no findings at all', () => {
    // "Decision: revise" and nothing else sends the worker round the loop with
    // no guidance — that is a failed review, not a verdict.
    expect(() => parseReviewerResult('Decision: revise')).toThrow(/no findings/);
    expect(() => parseReviewerResult('Decision: reject')).toThrow(/no findings/);
  });

  it('keeps a verdict that actually says something', () => {
    const r = parseReviewerResult(
      'Decision: revise\nThe session fixture depends on CSRF validation, which this diff removes.',
    );
    expect(r.decision).toBe('revise');
  });

  it('still allows approve with no findings — that is its correct shape', () => {
    const r = parseReviewerResult('Decision: approve');
    expect(r.decision).toBe('approve');
  });

  it('does not trip on review prose that merely mentions a control token', () => {
    // Reviewing tokenizer code is a legitimate reason to write one out; substantial
    // text remains after stripping, and only the residue is judged.
    const r = parseReviewerResult(
      'Decision: revise\nThe template emits <|im_start|> without a matching close, so the prompt is malformed.',
    );
    expect(r.decision).toBe('revise');
  });

  it('rejects a JSON verdict that is empty in every actionable field', () => {
    expect(() => parseReviewerResult(wrap({ decision: 'revise', feedback: '', issues: [], suggestions: [] })))
      .toThrow(/no findings/);
  });
});
