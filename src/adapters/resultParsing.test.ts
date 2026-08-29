import { describe, it, expect } from 'vitest';
import { parseReviewerResult, parseWorkerResult } from './resultParsing.js';
import { t } from '../locale/index.js';

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

  it('refuses to invent a verdict from prose that never declared one', () => {
    // Used to default to a "safe" revise. That default is exactly what let a
    // stream carrying no conclusion ship as Decision: REVISE. (INT-3914)
    // The INT-2485 property this case guarded — prose keywords must not become
    // the verdict — still holds, and more strongly: no verdict is produced at all.
    expect(() => parseReviewerResult('The code rejects invalid input and approves valid tokens.'))
      .toThrow(/carried no verdict/);
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


describe('parseReviewerResult refuses a verdict the reviewer never gave (INT-3914)', () => {
  // `pr review --fresh` reported Decision: REVISE nine consecutive times on PRs
  // whose real conclusion was approve. The stream's last agent_message was the
  // reviewer's OPENING narration, not its conclusion; the parser defaulted the
  // decision to revise and quoted that narration as the feedback.
  it('throws on the opening narration that shipped as a REVISE verdict', () => {
    // Verbatim shape of the feedback posted to vega-plugins PR #29.
    expect(() => parseReviewerResult('커밋된 변경사항을 기준 커밋과 비교해 전체 diff와 관련 파일을 확인합니다.'))
      .toThrow(/carried no verdict/);
  });

  it('throws on the English narration shapes seen in the same runs', () => {
    expect(() => parseReviewerResult('I will read the full diff and the related files first.'))
      .toThrow(/carried no verdict/);
    expect(() => parseReviewerResult('Let me review the committed changes against the base commit.'))
      .toThrow(/carried no verdict/);
  });

  it('names the missing verdict rather than the missing findings', () => {
    // The two failures have different fixes, so they must not share a message:
    // one means the reviewer said nothing actionable, the other means the stream
    // never carried a conclusion.
    expect(() => parseReviewerResult('I will start by reading the diff.')).toThrow(/no explicit decision/);
    expect(() => parseReviewerResult('Decision: revise')).toThrow(/no findings/);
  });

  it('still accepts a declared verdict backed by prose', () => {
    const r = parseReviewerResult('Decision: revise\nThe retry path drops the last attempt.');
    expect(r.decision).toBe('revise');
  });

  it('still accepts structured findings even when the verdict line is missing', () => {
    // Findings ARE the conclusion here — the reviewer did the work and only
    // skipped the ceremonial line. Unchanged behaviour, pinned so the INT-3914
    // guard cannot widen into it.
    const r = parseReviewerResult('Issues:\n- src/a.ts:1 add() subtracts instead of adding');
    expect(r.decision).toBe('revise');
    expect(r.issues).toEqual(['src/a.ts:1 add() subtracts instead of adding']);
  });

  it('still accepts a JSON verdict regardless of the narration around it', () => {
    const r = parseReviewerResult(
      'I will read the diff first.\n' + wrap({ decision: 'approve', feedback: 'Coherent and well-tested.' }),
    );
    expect(r.decision).toBe('approve');
  });
});

describe('agent codename passthrough (AGT-4019)', () => {
  it('keeps the codename from a structured worker completion', () => {
    const parsed = parseWorkerResult(
      '```json\n{"success":true,"codename":"Nova","summary":"did it","noChangesReason":"n/a"}\n```',
    );
    expect(parsed.codename).toBe('Nova');
  });

  it('keeps the codename from a reviewer verdict', () => {
    const parsed = parseReviewerResult(
      '```json\n{"decision":"revise","codename":"Sable","feedback":"add the guard","issues":["missing guard"]}\n```',
    );
    expect(parsed.codename).toBe('Sable');
  });

  it('leaves codename unset when the agent did not introduce itself', () => {
    const parsed = parseWorkerResult('```json\n{"success":true,"summary":"did it","noChangesReason":"n/a"}\n```');
    expect(parsed.codename).toBeUndefined();
  });
});

describe("the worker's report survives extraction (AGT-4073)", () => {
  // The worker prompt asks for a plain-text report whose FIRST line is the
  // agent's `Codename:` introduction, and for no JSON on the success path — so
  // this is the shape the text fallback actually receives in production.
  const promptShapedReport = [
    'Codename: Atlas',
    'Wired a low-confidence filter into renderA2() so it is excluded from the daily figure.',
    'Verified with 32 targeted Node tests; the two-week backfill is still unverified.',
    'Reviewer: start at src/a2/render.ts:118.',
  ].join('\n');

  it('summarises the report body, not the codename line', () => {
    const parsed = parseWorkerResult(promptShapedReport);
    expect(parsed.summary).not.toMatch(/Codename/i);
    expect(parsed.summary).toContain('Wired a low-confidence filter');
  });

  it('carries later lines a single-line summary would have dropped', () => {
    // What the worker could not verify sits on the SECOND line; taking only the
    // first line lost it. The third line ("start at …") does not fit under the
    // 200-character cap, which is unchanged by this fix and bounds how much of
    // any report reaches the reviewer.
    const parsed = parseWorkerResult(promptShapedReport);
    expect(parsed.summary).toContain('still unverified');
  });

  it('leaves a report with no codename line exactly as before', () => {
    const parsed = parseWorkerResult('Rewrote the retry policy so a 429 backs off.');
    expect(parsed.summary).toBe('Rewrote the retry policy so a 429 backs off.');
  });

  it('stops at a whole line rather than joining past the cap and cutting mid-word', () => {
    // Joining everything and truncating afterwards would also respect the cap,
    // so length alone does not discriminate. The property that does: a report
    // whose individual lines fit is never cut mid-word, so it carries no
    // ellipsis — the summary ends where a line ended.
    const long = ['Codename: Atlas', ...Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about the change.`)].join('\n');
    const parsed = parseWorkerResult(long);
    expect(parsed.summary.length).toBeLessThanOrEqual(200);
    expect(parsed.summary.endsWith('...')).toBe(false);
    expect(parsed.summary.endsWith('.')).toBe(true);
  });

  it('truncates a single over-long line rather than returning it whole', () => {
    const parsed = parseWorkerResult('x'.repeat(400));
    expect(parsed.summary).toHaveLength(203);
    expect(parsed.summary.endsWith('...')).toBe(true);
  });

  it('falls back to the no-summary placeholder when only a codename was said', () => {
    // Nothing but the introduction: there is genuinely no report to carry, and
    // the board's own normaliser turns this into the timing line.
    const parsed = parseWorkerResult('Codename: Atlas');
    expect(parsed.summary).toBe(t('common.fallback.noSummary'));
  });
});
