// ============================================
// OpenSwarm - Shared adapter result parsing
// ============================================
//
// Worker/Reviewer result extraction shared by the gpt, local, and openrouter
// adapters. These three adapters each ran a byte-for-byte copy of the same
// eight functions; the copies had already drifted in formatting and comment
// wording (a latent correctness risk if one copy were fixed and the others
// not). This module is the single source of truth — each adapter delegates to
// `parseWorkerResult` / `parseReviewerResult`.

import type { WorkerResult, ReviewResult } from './types.js';
import { t } from '../locale/index.js';

/** JSON-first worker parse: fenced ```json block, else a `"success"`-anchored object. */
function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"success"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent:
        typeof parsed.confidencePercent === 'number' ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
      noChangesReason: typeof parsed.noChangesReason === 'string' ? parsed.noChangesReason : undefined,
      // Structured completions carry the agent's chosen display name here; the
      // plain-text path picks it up from a `Codename:` line instead (AGT-4019).
      codename: typeof parsed.codename === 'string' && parsed.codename.trim()
        ? parsed.codename.trim().slice(0, 40)
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Text fallback when no JSON result is present. */
function extractWorkerFromText(text: string): WorkerResult {
  // Only an explicit failure phrase marks the run as failed. Loose words like
  // "error" or "fail" appear in normal coding prose ("error handling", "the
  // failing test") and used to cause false negatives. git-diff promotion in
  // worker.ts is the real success signal; this is just the non-repo fallback.
  const failed = isExplicitFailure(text);

  return {
    success: !failed,
    summary: extractSummary(text),
    filesChanged: [],
    commands: [],
    output: text,
    error: failed ? extractErrorMessage(text) : undefined,
  };
}

/** JSON-first reviewer parse: fenced ```json block, else a `"decision"`-anchored object. */
function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"decision"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    const decision =
      parsed.decision === 'approve' || parsed.decision === 'reject' ? parsed.decision : 'revise';
    return {
      decision,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      recommendedActions: parseRecommendedActions(parsed.recommendedActions),
      ...(typeof parsed.codename === 'string' && parsed.codename.trim()
        ? { codename: parsed.codename.trim().slice(0, 40) }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Parse the reviewer's `recommendedActions` into structured follow-ups. Filed as
 * sub-issues on approve by fileReviewerFollowups (INT-1704). (INT-1954)
 */
function parseRecommendedActions(raw: unknown): ReviewResult['recommendedActions'] {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      type: typeof a.type === 'string' && a.type ? a.type : 'follow-up',
      title: typeof a.title === 'string' ? a.title.trim() : '',
      location: typeof a.location === 'string' ? a.location : undefined,
    }))
    .filter((a) => a.title.length > 0);
  return actions.length ? actions : undefined;
}

/**
 * Text fallback when no JSON reviewer result is present.
 *
 * Returns whether the verdict was DECLARED or merely defaulted, because the two
 * are not interchangeable downstream: a defaulted verdict is the parser's guess,
 * not the reviewer's conclusion, and must not be presented as one. (INT-3914)
 */
function extractReviewerFromText(text: string): { result: ReviewResult; explicit: boolean } {
  // Prefer the reviewer's EXPLICIT verdict ("Decision: revise") over scattered
  // keyword matching. A task whose domain is about "reject"/"approve" (e.g. a
  // financial hard-reject bug, an approval-flow feature) makes prose keyword
  // matching classify a revise as a reject and kill the task prematurely
  // (STO-1451 was rejected on feedback that literally started "Decision: revise").
  // With no explicit verdict, default to the SAFE, retryable 'revise' rather than
  // the terminal 'reject' or an unearned 'approve'. (INT-2485)
  const explicit = text.match(
    /\bdecision\b\s*[:=-]?\s*["'`]?\s*(approve[d]?|reject(?:ed)?|revis(?:e|ion)|request[- ]?changes)/i,
  );
  let decision: ReviewResult['decision'] = 'revise';
  if (explicit) {
    const verdict = explicit[1].toLowerCase();
    decision = verdict.startsWith('approv') ? 'approve' : verdict.startsWith('reject') ? 'reject' : 'revise';
  }
  return {
    result: {
      decision,
      feedback: extractSummary(text),
      issues: extractBulletsAfter(text, /issues?:/i),
      suggestions: extractBulletsAfter(text, /suggestions?:/i),
    },
    explicit: explicit !== null,
  };
}

/** Preserve structured findings from plain-text reviewer fallbacks. */
function extractBulletsAfter(text: string, heading: RegExp): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (items.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      if (items.length > 0) break;
      continue;
    }
    items.push(trimmed.replace(/^[-*]\s*/, ''));
  }
  return items;
}

/** Brace-balanced scan for the JSON object containing `marker`. */
function findJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  const start = text.lastIndexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Detect a real failure declaration, not incidental "error"/"fail" prose. */
function isExplicitFailure(text: string): boolean {
  if (/"success"\s*:\s*false/i.test(text)) return true;
  return /\b(failed to|unable to|could not|couldn['’]t|cannot (?:complete|finish|proceed|continue)|giving up|abort(?:ed|ing))\b/i.test(text);
}

/** The self-introduction line the worker prompt mandates, not part of the report. */
const CODENAME_LINE = /^\s*Codename:/i;
const SUMMARY_MAX_CHARS = 200;

/**
 * The agent's own words, recovered from a plain-text answer.
 *
 * Two rules, both learned from what the worker prompt actually asks for
 * (`locale/prompts/*.ts`: report in short plain text, first line
 * `Codename: <name>`, no JSON on the success path):
 *
 * - **Codename lines are skipped.** Taking the literal first line handed the
 *   reviewer `- **Summary:** Codename: Atlas` and threw the report away, so the
 *   worker had no channel to the reviewer at all (AGT-4073).
 * - **Content is joined up to the cap**, not cut at the first line. A report
 *   states what was done, what could not be verified, and where to look; one
 *   line keeps only the first of those. The 200-character bound is unchanged,
 *   so this carries more of the answer without carrying more text.
 */
export function extractSummary(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 10 && !CODENAME_LINE.test(line));
  if (lines.length === 0) return t('common.fallback.noSummary');
  let summary = lines[0];
  for (const line of lines.slice(1)) {
    if (summary.length + 1 + line.length > SUMMARY_MAX_CHARS) break;
    summary = `${summary} ${line}`;
  }
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}

/** JSON-first with text fallback — the canonical worker-output parse. */
export function parseWorkerResult(text: string): WorkerResult {
  return extractWorkerResultJson(text) ?? extractWorkerFromText(text);
}

/** JSON-first with text fallback — the canonical reviewer-output parse. */
/**
 * Chat-template sentinels that leaked into a final message instead of being
 * consumed by the provider's parser — `<|im_start|>`, `<|eot_id|>`, and DeepSeek's
 * fullwidth `<｜｜DSML｜｜tool_calls>`. Matched by the angle-bracket-plus-pipe shape
 * rather than a fixed list, because every provider spells its own differently.
 *
 * Deliberately narrow: real review prose can *mention* such a token when reviewing
 * tokenizer code, but then substantial text remains after stripping, and only the
 * residue is judged.
 */
const CONTROL_TOKEN = /<[｜|][^>]*>|<\/?[｜|][^>]*>/g;

/** Does anything survive that a human could act on? */
function hasSubstance(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(CONTROL_TOKEN, ''));
}

/**
 * @param opts.jsonOnly Accept a verdict only from a JSON block, never from the
 * prose fallback. Callers that consider a message OTHER than the reviewer's last
 * one must pass this: mid-stream prose like "my decision: approve, pending a
 * final check" matches the verdict regex, and honouring it would turn a merge
 * gate into a silent pass. A JSON block is something the reviewer only emits
 * when reporting a result. (INT-3914)
 */
export function parseReviewerResult(text: string, opts: { jsonOnly?: boolean } = {}): ReviewResult {
  // An empty reviewer result is a harness failure, not a quality verdict. Falling
  // through to the safe text default would fabricate REVISE with no findings and
  // leave the user with an unactionable gate result. (INT-2879)
  if (!text.trim()) {
    throw new Error('Reviewer output was empty: no final message or verdict');
  }
  // Same failure wearing a disguise: a body consisting only of control tokens is
  // non-empty, so it cleared the check above and became REVISE with zero findings.
  // Measured on a 35-file diff: deepseek-v4-pro read the whole diff across 22 API
  // calls and then emitted `<｜｜DSML｜｜tool_calls>` as its entire final message.
  // (INT-3182)
  if (!hasSubstance(text)) {
    throw new Error('Reviewer output contained no verdict: only provider control tokens');
  }

  const json = extractReviewerResultJson(text);
  // Branch on `null` explicitly, not on truthiness: a falsy check would silently
  // build a fallback while `fromJson` still read true if this ever returns
  // `undefined`, flipping the verdict-declared test to the wrong answer.
  const fromJson = json !== null;
  if (opts.jsonOnly && !fromJson) {
    throw new Error('Reviewer output carried no JSON verdict: prose is not accepted from a non-final message');
  }
  const fallback = fromJson ? null : extractReviewerFromText(text);
  const result = json ?? fallback!.result;
  const explicit = fromJson || fallback!.explicit;

  // A non-approving verdict with nothing to act on is not a verdict — it is a
  // failed review that would send the worker round the loop with no guidance.
  // `approve` is exempt: having no findings is the correct shape for it.
  if (result.decision !== 'approve' && !isSubstantiated(result, fromJson, text, explicit)) {
    // Distinguish the two failures, because they point at different fixes: the
    // reviewer declared a verdict but gave nothing to act on, versus the stream
    // never carried a verdict at all and this text is some other utterance.
    throw new Error(
      explicit
        ? `Reviewer returned "${result.decision}" with no findings, feedback or suggestions — treating as a failed review`
        : 'Reviewer output carried no verdict: no JSON result and no explicit decision — '
          + 'the final message was not a review conclusion',
    );
  }

  return result;
}

/** The decision declaration itself, which carries no information beyond the verdict. */
const DECISION_PHRASE =
  /\bdecision\b\s*[:=-]?\s*["'`]?\s*(?:approve[d]?|reject(?:ed)?|revis(?:e|ion)|request[- ]?changes)["'`]?/gi;

/**
 * Did the reviewer say anything beyond the verdict?
 *
 * The two parse paths need different evidence. A JSON verdict carries its findings
 * in dedicated fields, so those are authoritative. The text fallback does not: its
 * `feedback` comes from extractSummary, which quotes the substantial lines up to a
 * length cap — usually starting with the "Decision: revise" line itself — so a
 * populated feedback field there proves nothing. For that path the question is whether the message holds anything
 * once the control tokens and the verdict declaration are removed.
 *
 * Residual prose only counts when the reviewer actually DECLARED a verdict. Without
 * one, "text remains after stripping" is satisfied by any sentence at all — and the
 * sentence a truncated stream leaves behind is the reviewer's opening narration
 * ("I will read the diff first…"), which then shipped as `Decision: REVISE` with the
 * narration as its feedback. Measured 9 consecutive times on `pr review --fresh`
 * where the real conclusion was approve. (INT-3914)
 */
function isSubstantiated(
  result: ReviewResult,
  fromJson: boolean,
  sourceText: string,
  explicit: boolean,
): boolean {
  if ((result.issues ?? []).some(hasSubstance) || (result.suggestions ?? []).some(hasSubstance)) {
    return true;
  }
  if (fromJson) {
    return hasSubstance(result.feedback ?? '');
  }
  return explicit && hasSubstance(sourceText.replace(DECISION_PHRASE, ''));
}
