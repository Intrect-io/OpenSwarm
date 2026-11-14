// Format repair of a reviewer's final answer (AGT-4313 / AGT-4413).
//
// A reviewer that spends its whole budget reading and then ends in prose with
// no verdict JSON and no `Decision:` line used to fail the area outright. The
// loop now gets exactly one tool-less, same-conversation restatement turn when
// the caller says the answer is unreadable — and keeps the original answer when
// the repair does not help, so the caller still fails closed.

import { describe, expect, it } from 'vitest';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';
import { reviewerOutputNeedsFormatRepair, parseReviewerResult } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
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

const repair = { needsRepair: reviewerOutputNeedsFormatRepair, prompt: REVIEWER_FORMAT_REPAIR_PROMPT };

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
