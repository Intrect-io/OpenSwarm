// Format repair of a reviewer's final answer (AGT-4313 / AGT-4413).
//
// A reviewer that spends its whole budget reading and then ends in prose with
// no verdict JSON and no `Decision:` line used to fail the area outright. The
// loop now gets exactly one tool-less, same-conversation restatement turn when
// the caller says the answer is unreadable — and keeps the original answer when
// the repair does not help, so the caller still fails closed.

import { describe, expect, it } from 'vitest';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';
import { reviewerOutputNeedsFormatRepair, reviewerFormatRepairIsConsistent, parseReviewerResult } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
import { NoFinalAnswerError, loopEndedOnAnswer, repairFinalAnswerFormat, transcriptDigest } from './finalAnswerTurns.js';
import { DECLARED_NON_APPROVAL } from './reviewerDeclarations.js';
import { transcriptNotes } from '../agents/reviewerNoVerdict.js';
import { REVIEWER_FORMAT_REPAIR_PROMPT } from '../agents/reviewer.js';

const toolCallResp = (id: string, name: string, args: object) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: 'tool_calls',
  }],
});
const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const PROSE =
  'I read src/a.ts and src/b.ts. The retry path in src/a.ts:42 swallows the error, ' +
  'and the counter in src/b.ts:10 is never reset between batches.';
const REPAIRED =
  '```json\n{"decision": "revise", "feedback": "Two defects.", ' +
  '"issues": ["src/a.ts:42 swallows the error", "src/b.ts:10 counter never reset"], "suggestions": []}\n```';
const BARE_REJECT = 'Decision: reject';

const repair = {
  needsRepair: reviewerOutputNeedsFormatRepair,
  prompt: REVIEWER_FORMAT_REPAIR_PROMPT,
  acceptRepair: reviewerFormatRepairIsConsistent,
};
const MALFORMED_REJECT = '```json\n{"decision": "reject", "issues": ["src/a.ts:42 data loss"],}\n```';

type CallApi = (messages: ChatMessage[], tools: unknown[]) => Promise<unknown>;

/** A reviewer-shaped loop run with the repair enabled unless `extra` overrides it. */
const runReview = (callApi: CallApi, extra: Record<string, unknown> = {}) =>
  runAgenticLoop({
    prompt: 'Review the change and return a verdict.',
    cwd: process.cwd(),
    model: 'test',
    webTools: false,
    finalAnswerRepair: repair,
    ...extra,
    callApi: callApi as never,
  });

/** First call answers `first`; every later call answers `then` (or throws it). */
const scripted = (first: string, then: string | Error) => {
  const state = { calls: 0 };
  const callApi: CallApi = async () => {
    state.calls++;
    if (state.calls === 1) return finalResp(first);
    if (then instanceof Error) throw then;
    return finalResp(then);
  };
  return { state, callApi };
};

describe('reviewerOutputNeedsFormatRepair', () => {
  it('asks for a repair when prose carries no verdict at all', () => {
    expect(() => parseReviewerResult(PROSE)).toThrow(/carried no verdict/);
    expect(reviewerOutputNeedsFormatRepair(PROSE)).toBe(true);
  });

  it('asks for a repair when the answer is only provider control tokens', () => {
    expect(reviewerOutputNeedsFormatRepair('<｜｜DSML｜｜tool_calls>')).toBe(true);
  });

  it('leaves a readable verdict alone', () => {
    expect(reviewerOutputNeedsFormatRepair(REPAIRED)).toBe(false);
    expect(reviewerOutputNeedsFormatRepair('Decision: approve\nNo findings.')).toBe(false);
  });

  it('never repairs a declared reject/revise, even one with no findings', () => {
    // The reviewer reached a conclusion; a second ask must not be able to flip
    // it into an approval. The caller fails on it exactly as before.
    expect(() => parseReviewerResult(BARE_REJECT)).toThrow(/with no findings/);
    expect(reviewerOutputNeedsFormatRepair(BARE_REJECT)).toBe(false);
  });

  it('leaves empty text to the salvage turn', () => {
    expect(reviewerOutputNeedsFormatRepair('   ')).toBe(false);
  });
});

describe('agentic loop final-answer format repair', () => {
  it('runs one tool-less repair turn in the same conversation and returns the readable answer', async () => {
    const calls: Array<{ tools: number; last: ChatMessage | undefined; prior: ChatMessage | undefined }> = [];
    const logs: string[] = [];
    const result = await runReview(async (messages, tools) => {
      calls.push({ tools: tools.length, last: messages.at(-1), prior: messages.at(-2) });
      return calls.length === 1 ? finalResp(PROSE) : finalResp(REPAIRED);
    }, { onLog: (l: string) => logs.push(l) });

    expect(calls).toHaveLength(2);
    // The repair call: no tools, the unreadable answer kept as the assistant
    // turn right before the repair prompt (same conversation, not a restart).
    expect(calls[1].tools).toBe(0);
    expect(calls[1].last).toMatchObject({ role: 'user', content: REVIEWER_FORMAT_REPAIR_PROMPT });
    expect(calls[1].prior).toMatchObject({ role: 'assistant', content: PROSE });
    expect(result.text).toBe(REPAIRED);
    expect(result.apiCallCount).toBe(2);
    expect(parseReviewerResult(result.text).decision).toBe('revise');
    expect(logs).toContain('✓ Format repair produced a readable answer');
  });

  it('repairs a salvaged (forced final turn) answer that came back as prose — the AGT-4413 shape', async () => {
    let finalCalls = 0;
    const result = await runReview(async (_messages, tools) => {
      if (tools.length > 0) return toolCallResp('c1', 'read_file', { path: 'package.json' });
      finalCalls++;
      return finalCalls === 1 ? finalResp(PROSE) : finalResp(REPAIRED);
    }, { maxTurns: 1 });

    expect(finalCalls).toBe(2); // salvage + exactly one repair
    expect(parseReviewerResult(result.text).issues).toHaveLength(2);
  });

  // AGT-4413 DoD: the PR 521 run ended its forced final turn with NO text. The
  // empty-final retry (AGT-4450) and the format repair together must still end
  // with a readable decision when the reviewer can give one.
  it('turns an empty forced final message into a decision via the retry and one repair', async () => {
    const finals: string[] = [];
    const result = await runReview(async (_messages, tools) => {
      if (tools.length > 0) return toolCallResp('c1', 'read_file', { path: 'package.json' });
      const answer = finals.length === 0 ? '' : finals.length === 1 ? PROSE : REPAIRED;
      finals.push(answer);
      return finalResp(answer);
    }, { maxTurns: 1 });

    expect(finals).toEqual(['', PROSE, REPAIRED]);
    expect(parseReviewerResult(result.text).decision).toBe('revise');
  });

  it('turns an empty forced final message straight into a decision when the retry already has one', async () => {
    let finals = 0;
    const result = await runReview(async (_messages, tools) => {
      if (tools.length > 0) return toolCallResp('c1', 'read_file', { path: 'package.json' });
      finals++;
      return finalResp(finals === 1 ? '' : 'Decision: REVISE\n- src/a.ts:42 swallows the error');
    }, { maxTurns: 1 });

    expect(finals).toBe(2);
    expect(parseReviewerResult(result.text).decision).toBe('revise');
  });

  it('attempts the repair exactly once and keeps the original answer when it does not help', async () => {
    const logs: string[] = [];
    const { state, callApi } = scripted(PROSE, 'Still thinking about it, the code looks mostly fine.');
    const result = await runReview(callApi, { onLog: (l: string) => logs.push(l) });

    expect(state.calls).toBe(2);
    expect(result.text).toBe(PROSE);
    // Fail-closed downstream: the caller still sees an unreadable verdict.
    expect(() => parseReviewerResult(result.text)).toThrow(/carried no verdict/);
    expect(logs).toContain('✖ Format repair did not produce a readable answer — keeping the original');
  });

  it('does not run a repair turn when the answer is already readable', async () => {
    const { state, callApi } = scripted('Decision: approve\nNo findings.', REPAIRED);
    await runReview(callApi);
    expect(state.calls).toBe(1);
  });

  it('does not repair a declared verdict with no findings into anything else', async () => {
    const { state, callApi } = scripted(BARE_REJECT, 'Decision: approve\nLooks fine.');
    const result = await runReview(callApi);
    expect(state.calls).toBe(1);
    expect(result.text).toBe(BARE_REJECT);
  });

  it('refuses a repair that turns a malformed but declared reject into an approval', async () => {
    // The JSON is unreadable (trailing comma), so the predicate asks for a
    // repair — but the reviewer had written down "reject". An approve coming
    // back must not replace it.
    expect(reviewerOutputNeedsFormatRepair(MALFORMED_REJECT)).toBe(true);
    const { state, callApi } = scripted(MALFORMED_REJECT, 'Decision: approve\nLooks fine on a second look.');
    const result = await runReview(callApi);
    expect(state.calls).toBe(2);
    expect(result.text).toBe(MALFORMED_REJECT);
  });

  it('accepts a repair that restates the malformed reject readably', async () => {
    const restated = '```json\n{"decision": "reject", "feedback": "Data loss.", "issues": ["src/a.ts:42 data loss"]}\n```';
    const { callApi } = scripted(MALFORMED_REJECT, restated);
    const result = await runReview(callApi);
    expect(parseReviewerResult(result.text).decision).toBe('reject');
  });

  it('propagates a rate limit hit on the repair turn instead of returning the unreadable answer', async () => {
    const { callApi } = scripted(PROSE, new RateLimitError(undefined, 'rate limited'));
    await expect(runReview(callApi)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('keeps the original answer when the repair call fails for a non-infra reason', async () => {
    const { callApi } = scripted(PROSE, new Error('model returned malformed JSON'));
    const result = await runReview(callApi);
    expect(result.text).toBe(PROSE);
  });

  it('is off unless the caller asks for it', async () => {
    const { state, callApi } = scripted(PROSE, REPAIRED);
    const result = await runReview(callApi, { finalAnswerRepair: undefined });
    expect(state.calls).toBe(1);
    expect(result.text).toBe(PROSE);
  });
});

// Review of #887: a written-down reject in a shape the parser did not read
// (`**Decision:** REJECT`) let the repair run and a repaired approve win.
describe('format repair never flips a written non-approval into approve (AGT-4313 review)', () => {
  const APPROVE_JSON = '```json\n{"decision": "approve", "feedback": "Looks fine."}\n```';
  const shapes: Array<[string, string, 'reject' | 'revise']> = [
    ['markdown bold', '**Decision:** REJECT\n\nsrc/a.ts:42 loses data on retry.', 'reject'],
    ['markdown underscore', '__Decision__: revise\n\nsrc/a.ts:42 loses data on retry.', 'revise'],
    ['em dash', 'Decision — reject\n\nsrc/a.ts:42 loses data on retry.', 'reject'],
    ['verdict label', 'Verdict: reject\n\nsrc/a.ts:42 loses data on retry.', 'reject'],
    ['recommendation: request changes', 'Recommendation: request changes\n\nsrc/a.ts:42 loses data on retry.', 'revise'],
  ];

  it.each(shapes)('reads a %s declaration as a verdict, so no repair runs', (_label, text, decision) => {
    expect(parseReviewerResult(text).decision).toBe(decision);
    expect(reviewerOutputNeedsFormatRepair(text)).toBe(false);
  });

  it.each(shapes)('refuses a repaired approve over a %s declaration', (_label, text) => {
    expect(reviewerFormatRepairIsConsistent(text, APPROVE_JSON)).toBe(false);
  });

  it.each(shapes)('the non-approval detector itself reads a %s declaration', (_label, text) => {
    expect(DECLARED_NON_APPROVAL.test(text)).toBe(true);
  });

  it.each([
    ['Decision: revisions needed\n- src/a.ts:42 data loss', 'revise'],
    ['**Decision:** rejection\n- src/a.ts:42 data loss', 'reject'],
  ] as const)('reads an inflected verdict word: %s', (text, decision) => {
    expect(parseReviewerResult(text).decision).toBe(decision);
    expect(DECLARED_NON_APPROVAL.test(text)).toBe(true);
    expect(reviewerFormatRepairIsConsistent(text, APPROVE_JSON)).toBe(false);
  });

  it('does not read "revisit" as a revise', () => {
    expect(DECLARED_NON_APPROVAL.test('Decision: revisit later')).toBe(false);
  });

  it.each([
    ['bare **Decision:** REJECT with no findings', '**Decision:** REJECT'],
    ['undeclared prose that asks for a fix', 'src/a.ts:42 swallows the error. This is blocking and must fix before merge.'],
    ['prose that says it would reject', 'I would reject this: the retry in src/a.ts:42 loses data.'],
    ['prose that requests changes', 'Requesting changes — the counter in src/b.ts:10 is never reset.'],
  ])('refuses a repaired approve for %s', (_label, text) => {
    expect(reviewerFormatRepairIsConsistent(text, APPROVE_JSON)).toBe(false);
    expect(reviewerFormatRepairIsConsistent(text, 'Decision: approve\nFine.')).toBe(false);
  });

  it('still accepts a repaired approve when the original has no sign of non-approval', () => {
    expect(reviewerFormatRepairIsConsistent(PROSE.replace(' swallows the error', ' reads the config'), APPROVE_JSON)).toBe(true);
  });

  it('still accepts a repaired revise or reject over non-approving prose', () => {
    expect(reviewerFormatRepairIsConsistent('This is blocking.', REPAIRED)).toBe(true);
  });

  it('keeps the original answer when the loop repair of blocking prose comes back as approve', async () => {
    const blocking = 'src/a.ts:42 swallows the error — blocking, must fix before merge.';
    expect(reviewerOutputNeedsFormatRepair(blocking)).toBe(true);
    const { state, callApi } = scripted(blocking, APPROVE_JSON);
    const result = await runReview(callApi);
    expect(state.calls).toBe(2);
    expect(result.text).toBe(blocking);
  });

  it('lets a later declared non-approval beat an earlier approve', () => {
    expect(parseReviewerResult('Recommendation: approve once fixed.\n**Decision:** REJECT\n- src/a.ts:42 data loss').decision)
      .toBe('reject');
  });

  // INT-2485: a leading `Decision: revise` must not be escalated to a terminal
  // reject by a later hit inside quoted code or prose.
  it('keeps the first declared non-approval over a later reject in quoted code', () => {
    const text = "Decision: revise\n- src/a.ts:42 swallows the error\nThe handler's `decision: 'reject'` branch is never hit.";
    expect(parseReviewerResult(text).decision).toBe('revise');
  });

  it('does not read prose about an earlier approval as a declaration', () => {
    expect(() => parseReviewerResult('The earlier verdict approved the old API; src/a.ts:42 now breaks it.'))
      .toThrow(/carried no verdict/);
  });
});

// Review of #887: the repair is for a model's own answer, not the loop's sentinels.
describe('format repair only after a clean answer or a successful salvage (AGT-4313 review)', () => {
  it('recognises the loop sentinels', () => {
    expect(loopEndedOnAnswer('(stopped)')).toBe(false);
    expect(loopEndedOnAnswer('API error: 402 Payment Required')).toBe(false);
    expect(loopEndedOnAnswer('Empty API response')).toBe(false);
    expect(loopEndedOnAnswer(PROSE)).toBe(true);
  });

  it('does not repair "Empty API response"', async () => {
    let calls = 0;
    const result = await runReview(async () => { calls++; return { choices: [] }; });
    expect(result.text).toBe('Empty API response');
    expect(calls).toBe(1);
  });

  it.each(['API error: 402 Payment Required', '(stopped)', 'Empty API response'])(
    'repairFinalAnswerFormat leaves the sentinel %s alone without a call',
    async (sentinel) => {
      let calls = 0;
      const ctx = {
        messages: [] as ChatMessage[],
        callApi: async () => { calls++; return finalResp(REPAIRED); },
        onCall: () => undefined,
      };
      const out = await repairFinalAnswerFormat(ctx as never, sentinel, { needsRepair: () => true, prompt: 'restate' });
      expect(out).toBe(sentinel);
      expect(calls).toBe(0);
    },
  );

  it('does not repair after a user stop', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await runReview(async () => {
      calls++;
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }, { signal: controller.signal });
    expect(result.text).toBe('(stopped)');
    expect(calls).toBe(1);
  });
});

// AGT-4413 DoD: PR 521 ended with an empty forced final turn AND an empty
// retry, so nothing was posted. The salvage failure now carries a digest.
describe('an empty salvage carries a transcript digest (AGT-4413)', () => {
  it('throws NoFinalAnswerError with the tool calls and notes, and reports it through the repair', async () => {
    let reported: string | undefined;
    const err = await runReview(async (_messages, tools) => {
      if (tools.length > 0) {
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: 'Reading src/a.ts — the retry at line 42 looks suspicious.',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) } }],
            },
            finish_reason: 'tool_calls',
          }],
        };
      }
      return finalResp('');
    }, { maxTurns: 1, finalAnswerRepair: { ...repair, onNoFinalAnswer: (d: string) => { reported = d; } } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoFinalAnswerError);
    const digest = (err as NoFinalAnswerError).partialTranscript!;
    expect(digest).toContain('the retry at line 42 looks suspicious');
    expect(digest).toContain('- tool `read_file` {"path":"src/a.ts"}');
    expect(reported).toBe(digest);
  });

  it('bounds the digest, keeps the newest steps and never starts a line with "{"', () => {
    const messages: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'assistant' as const,
      content: `{"step": ${i}} note ${i}`,
      tool_calls: [{ id: `c${i}`, type: 'function' as const, function: { name: 'grep', arguments: JSON.stringify({ q: 'x'.repeat(500) }) } }],
    }));
    const digest = transcriptDigest(messages)!;
    expect(digest.length).toBeLessThanOrEqual(4000);
    expect(digest).toContain('note 199');
    expect(digest).not.toContain('note 0\n');
    expect(digest.startsWith('… (earlier steps omitted)')).toBe(true);
    expect(digest.split('\n').some((line) => line.trimStart().startsWith('{'))).toBe(false);
    // The downstream filter drops mostly-JSON text; a JSON-heavy digest must survive it.
    expect(transcriptNotes(digest)).toBeDefined();
  });

  it('returns nothing when the run said and did nothing', () => {
    expect(transcriptDigest([{ role: 'user', content: 'review' }])).toBeUndefined();
  });
});
