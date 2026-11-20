/**
 * The tool-less turns the agentic loop runs AFTER its main loop, to turn a run
 * that ended badly into a usable final answer:
 *
 * - `salvageFinalAnswer`: the loop ended (turn ceiling, deadline) without a
 *   final message — ask for one with no tools, retrying once if it is empty.
 * - `repairFinalAnswerFormat`: the loop has a final message, but the caller
 *   cannot read its format — ask once to restate it.
 *
 * Both run in the loop's own `messages` (same conversation, warm cache) and
 * share one rule for errors: a rate limit or an infra failure propagates, it is
 * never papered over with whatever text happens to be at hand.
 */

import { detectRateLimit, RateLimitError } from './rateLimitError.js';
import { isInfraError } from './errorClassification.js';
import type { ChatMessage } from './agenticLoop.js';
import type { ChatUsage } from './chatStream.js';
import type { FinalAnswerRepair } from './types.js';
import type { SessionRecorder } from '../support/sessionLog.js';

interface ToollessResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: ChatUsage;
  model?: string;
}

/** What the post-loop turns need from the loop that ran before them. */
export interface FinalTurnContext {
  messages: ChatMessage[];
  /** The loop's API caller; always invoked here with no tools. */
  callApi: (messages: ChatMessage[], tools: []) => Promise<ToollessResponse>;
  /** Folds one call's usage into the run totals and counts the call. */
  onCall: (usage: ChatUsage | undefined, startedAt: number, model?: string) => void;
  session?: SessionRecorder;
  onLog?: (line: string) => void;
}

/**
 * A `FinalAnswerRepair` whose owner also wants the run's transcript digest when
 * the salvage turn ends with no text at all. The adapters forward the repair
 * object untouched, which makes it the one channel that survives an adapter
 * that swallows the loop's error into `{exitCode: 1, stdout: ''}`. (AGT-4413)
 */
export interface TranscriptAwareRepair extends FinalAnswerRepair {
  onNoFinalAnswer?: (partialTranscript: string) => void;
}

/** The salvage turn's failure, carrying what the run did before it. (AGT-4413) */
export class NoFinalAnswerError extends Error {
  /** Bounded digest of the run's assistant text and tool calls; undefined when there was none. */
  readonly partialTranscript?: string;

  constructor(message: string, partialTranscript: string | undefined) {
    super(message);
    this.name = 'NoFinalAnswerError';
    this.partialTranscript = partialTranscript;
  }
}

/** Longest transcript digest carried on a NoFinalAnswerError. */
export const MAX_TRANSCRIPT_DIGEST_CHARS = 4000;
const DIGEST_TOOL_ARGS_CHARS = 120;
const DIGEST_TEXT_CHARS = 1500;

/**
 * What a run that never answered still said and did: its assistant texts and
 * its tool calls (name + shortened arguments), newest kept when the bound bites.
 * No line starts with `{` even after trimming (JSON-looking text is quoted
 * with `> `), so the digest is not mistaken for a CLI event stream downstream
 * (partialReviewerText) and dropped.
 */
export function transcriptDigest(messages: ChatMessage[], maxChars = MAX_TRANSCRIPT_DIGEST_CHARS): string | undefined {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (text) {
      const bounded = text.length > DIGEST_TEXT_CHARS ? `${text.slice(0, DIGEST_TEXT_CHARS)} …` : text;
      lines.push(...bounded.split('\n').map((line) => (line.trimStart().startsWith('{') ? `> ${line}` : line)));
    }
    for (const call of message.tool_calls ?? []) {
      const args = call.function.arguments.replace(/\s+/g, ' ').trim();
      const shortArgs = args.length > DIGEST_TOOL_ARGS_CHARS ? `${args.slice(0, DIGEST_TOOL_ARGS_CHARS)}…` : args;
      lines.push(`- tool \`${call.function.name}\` ${shortArgs}`.trimEnd());
    }
  }
  if (lines.length === 0) return undefined;
  const omitted = '… (earlier steps omitted)';
  const kept: string[] = [];
  let size = omitted.length + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > maxChars) {
      kept.unshift(omitted);
      break;
    }
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return kept.join('\n');
}

/**
 * Did the main loop end on an answer worth repairing? Not when it stopped on a
 * user abort, an API error or an empty API response — those sentinels are the
 * loop's own words, not the model's, and a repair turn would spend a call (or
 * ignore the operator's stop) asking the model to restate text it never wrote.
 * Nor after a sandbox outcome the loop refuses to continue past. (AGT-4313 review)
 */
export function loopEndedOnAnswer(finalText: string): boolean {
  return finalText !== '(stopped)'
    && finalText !== 'Empty API response'
    && !finalText.startsWith('API error: ')
    && !finalText.startsWith('OUTCOME_UNKNOWN_DO_NOT_RETRY');
}

/** Re-throw the errors that must not be replaced by a fallback answer. */
function rethrowIfFatal(err: unknown): string {
  // A rate limit must still propagate — swallowing it would return an answer
  // the scheduler reads as a plain result instead of pausing. Preserve a typed
  // RateLimitError, then re-detect an untyped one from the message. (INT-2519)
  if (err instanceof RateLimitError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const rl = detectRateLimit('', msg);
  if (rl) throw rl;
  if (isInfraError(err)) throw err; // infra → infra_error, not a fake result (INT-2520)
  return msg;
}

const SALVAGE_PROMPT =
  "You've reached this turn's step limit, so stop calling tools now. Using everything " +
  'above, write a non-empty final answer now. Follow the output format requested in the ' +
  'original task exactly. If the original task requests a review or verdict, begin with ' +
  '`Decision: approve`, `Decision: revise`, or `Decision: reject` and give concrete ' +
  'reasoning; do not return a worker-status summary. Do not mention step/tool limits or ' +
  '"budget" to the user.';

const SALVAGE_RETRY_PROMPT =
  'Your previous final-answer attempt returned no user-visible text. Respond now with ' +
  'the complete, non-empty final answer in the exact format requested by the original task.';

async function callToolless(ctx: FinalTurnContext): Promise<string | null | undefined> {
  const startedAt = Date.now();
  const response = await ctx.callApi(ctx.messages, []);
  ctx.onCall(response.usage, startedAt, response.model);
  return response.choices?.[0]?.message?.content;
}

/**
 * Final answer turn — maxTurns/타임아웃으로 끊겼는데 모델이 최종 텍스트를 못 낸 경우,
 * 도구 없이 호출해 결론을 강제한다. 이게 없으면 진단·분석형 작업이
 * 끝까지 도구만 호출하다 빈 결과("(no summary)")로 끝난다 — SWE 하이브리드 진단
 * 단계에서 발견된 결함.
 * 첫 salvage가 reasoning-only 응답처럼 사용자에게 보이는 content를 하나도 내지
 * 않으면 딱 한 번 재시도한다. 두 번 모두 비면 성공/REVISE로 위장하지 않고 실패로
 * 올려 보내 reviewer/worker 호출자가 명시적으로 처리하게 한다. (INT-1442, INT-2879)
 */
export async function salvageFinalAnswer(ctx: FinalTurnContext, repair?: TranscriptAwareRepair): Promise<string> {
  const { messages, session, onLog } = ctx;
  const maxFinalAnswerAttempts = 2;
  const stepLimitPrompt = SALVAGE_PROMPT;
  messages.push({ role: 'user', content: stepLimitPrompt });
  // Salvage is where a cut-short run gets the answer that becomes its verdict,
  // and it used to leave no trace at all: the transcript ended on a tool
  // result, and the reviewer's entire REVISE — evidence table, three named
  // problems, decision JSON — existed only inside the `end` summary. Reading
  // the events, the run looked like it simply stopped. Worse, nothing said the
  // loop had run out of turns; establishing that meant counting API calls
  // against recorded events. Record the reason, the injected prompt and every
  // attempt, so a salvaged run explains itself. (AGT-4450)
  session?.record({
    type: 'notice',
    note: 'salvage',
    reason: 'the loop ended without a final message; asking for an answer with no tools',
    attempts: maxFinalAnswerAttempts,
    prompt: stepLimitPrompt,
  });

  let finalText = '';
  for (let attempt = 1; attempt <= maxFinalAnswerAttempts && !finalText; attempt++) {
    if (attempt === 1) {
      onLog?.('▸ Final answer turn (no tools) — loop ended without a final message');
    } else {
      onLog?.('↻ Final answer was empty — retrying once (no tools)');
      const retryPrompt = SALVAGE_RETRY_PROMPT;
      messages.push({ role: 'user', content: retryPrompt });
      session?.record({ type: 'notice', note: 'salvage-retry', attempt, prompt: retryPrompt });
    }

    try {
      const content = await callToolless(ctx);
      finalText = typeof content === 'string' && content.trim() ? content : '';
      // Recorded even when empty, so recorded assistant events reconcile with
      // `apiCallCount` and an empty salvage is visible rather than inferred.
      session?.record({
        type: 'assistant',
        salvage: attempt,
        content: typeof content === 'string' ? content : '',
        toolCalls: [],
      });
    } catch (err) {
      session?.record({
        type: 'notice',
        note: 'salvage-failed',
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      const msg = rethrowIfFatal(err);
      onLog?.(`✖ Final answer turn failed (${attempt}/${maxFinalAnswerAttempts}): ${msg}`);
    }
  }

  if (!finalText) {
    onLog?.('✖ Final answer remained empty after one retry');
    session?.record({
      type: 'notice',
      note: 'salvage-exhausted',
      reason: 'every final-answer attempt came back empty; the run ends with no answer',
    });
    // Carry what the run did, so a reviewer can still post its reading as
    // "no decision" notes instead of nothing (cgf-portal PR 521). (AGT-4413)
    const partialTranscript = transcriptDigest(messages);
    if (partialTranscript) repair?.onNoFinalAnswer?.(partialTranscript);
    throw new NoFinalAnswerError('Agentic loop produced no final message after one retry', partialTranscript);
  }
  return finalText;
}

/**
 * Format repair — the loop has a final answer, but the caller cannot read it:
 * a reviewer that wrote a long prose review and never emitted the verdict JSON
 * or a `Decision:` line. Measured on a 2026-09-15 OpenRouter audit: 3 of 17
 * areas spent 18–20 API calls and 114k–144k tokens and then failed as
 * "carried no verdict", throwing all of that reading away. Ask once, in the
 * same conversation and with no tools, for the answer restated in the required
 * format. Exactly one attempt; the repair is taken only when the caller can
 * read it, so a model that cannot comply leaves the original answer — and the
 * caller's original failure — untouched. Returns the text the loop should
 * return. (AGT-4313)
 */
export async function repairFinalAnswerFormat(
  ctx: FinalTurnContext,
  finalText: string,
  repair: FinalAnswerRepair | undefined,
): Promise<string> {
  if (!repair || !finalText || !loopEndedOnAnswer(finalText) || !repair.needsRepair(finalText)) return finalText;
  const { messages, session, onLog } = ctx;
  onLog?.('↻ Final answer is not in the required format — one repair turn (no tools)');
  messages.push({ role: 'assistant', content: finalText });
  messages.push({ role: 'user', content: repair.prompt });
  session?.record({
    type: 'notice',
    note: 'format-repair',
    reason: 'the final answer could not be read in the required format; asking once to restate it with no tools',
    prompt: repair.prompt,
  });
  try {
    const content = await callToolless(ctx);
    const repaired = typeof content === 'string' && content.trim() ? content : '';
    session?.record({ type: 'assistant', formatRepair: 1, content: repaired, toolCalls: [] });
    if (repaired && !repair.needsRepair(repaired) && (repair.acceptRepair?.(finalText, repaired) ?? true)) {
      onLog?.('✓ Format repair produced a readable answer');
      return repaired;
    }
    onLog?.('✖ Format repair did not produce a readable answer — keeping the original');
  } catch (err) {
    session?.record({
      type: 'notice',
      note: 'format-repair-failed',
      error: err instanceof Error ? err.message : String(err),
    });
    const msg = rethrowIfFatal(err);
    onLog?.(`✖ Format repair turn failed: ${msg} — keeping the original answer`);
  }
  return finalText;
}
