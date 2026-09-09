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
    // Require an explicit boolean for success — malformed or absent values
    // must not be treated as a successful run.
    if (typeof parsed.success !== 'boolean') return null;
    return {
      success: parsed.success,
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
    return {
      decision: String(parsed.decision ?? ''),
      feedback: parsed.feedback || '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      output: text,
      recommendedActions: parseRecommendedActions(parsed.recommendedActions),
    };
  } catch {
    return null;
  }
}

function parseRecommendedActions(raw: unknown): ReviewResult['recommendedActions'] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return { file: '', action: '' };
    const obj = item as Record<string, unknown>;
    return {
      file: String(obj.file ?? ''),
      action: String(obj.action ?? ''),
    };
  });
}

/** Text fallback when no JSON reviewer result is present. */
function extractReviewerFromText(text: string): ReviewResult {
  const decisionMatch = text.match(/Decision:\s*(APPROVE|REVISE|REQUEST_CHANGES)/i);
  const decision = decisionMatch?.[1]?.toUpperCase() ?? 'REVISE';
  return {
    decision,
    feedback: extractFeedback(text),
    issues: [],
    suggestions: [],
    output: text,
    recommendedActions: [],
  };
}

function extractFeedback(text: string): string {
  const lines = text.split('\n');
  const feedbackStart = lines.findIndex(
    (l) => l.match(/^#{1,3}\s*Feedback/i) || l.match(/^Feedback:/i),
  );
  if (feedbackStart === -1) return text;
  const feedbackLines = lines.slice(feedbackStart + 1);
  const endIdx = feedbackLines.findIndex(
    (l) => l.match(/^#{1,3}\s*(Issues|Suggestions|Recommended Actions)/i),
  );
  return (endIdx === -1 ? feedbackLines : feedbackLines.slice(0, endIdx)).join('\n').trim();
}

function extractBulletsAfter(text: string, heading: RegExp): string[] {
  const lines = text.split('\n');
  const headingIdx = lines.findIndex((l) => heading.test(l));
  if (headingIdx === -1) return [];
  const bullets: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bullets.push(trimmed.replace(/^[-*]\s*/, ''));
    } else if (trimmed === '' && bullets.length > 0) {
      break;
    } else if (!trimmed.startsWith('- ') && !trimmed.startsWith('* ') && bullets.length > 0) {
      break;
    }
  }
  return bullets;
}

/**
 * Find the first JSON object in text that contains the given marker string.
 * This is a heuristic — it scans for `{` and counts braces until it finds
 * the marker. It is NOT a full JSON parser and will fail on nested objects
 * that contain the marker in a string value. For those cases the caller
 * should use a fenced ```json block instead.
 */
function findJsonObject(text: string, marker: string): string | null {
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        if (candidate.includes(marker)) return candidate;
        start = -1;
      }
    }
  }
  return null;
}

function isExplicitFailure(text: string): boolean {
  // Match "FAILED" or "FAILURE" as standalone words, but not "failed" in
  // normal prose like "the failing test" or "error handling".
  return /\b(FAILED|FAILURE)\b/.test(text);
}

function extractSummary(text: string): string {
  const lines = text.split('\n');
  const summaryIdx = lines.findIndex(
    (l) => l.match(/^#{1,3}\s*Summary/i) || l.match(/^Summary:/i),
  );
  if (summaryIdx === -1) {
    // Fallback: first non-empty, non-heading line
    return lines.find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
  }
  const summaryLines = lines.slice(summaryIdx + 1);
  const endIdx = summaryLines.findIndex(
    (l) => l.match(/^#{1,3}\s*(Files Changed|Commands|Error|Changes)/i),
  );
  return (endIdx === -1 ? summaryLines : summaryLines.slice(0, endIdx)).join('\n').trim();
}

function extractErrorMessage(text: string): string {
  const lines = text.split('\n');
  const errorIdx = lines.findIndex(
    (l) => l.match(/^#{1,3}\s*Error/i) || l.match(/^Error:/i),
  );
  if (errorIdx === -1) return '';
  const errorLines = lines.slice(errorIdx + 1);
  const endIdx = errorLines.findIndex(
    (l) => l.match(/^#{1,3}\s*(Summary|Files Changed|Commands)/i),
  );
  return (endIdx === -1 ? errorLines : errorLines.slice(0, endIdx)).join('\n').trim();
}

// ---- Public API -----------------------------------------------------------

/**
 * Parse a worker's output text into a structured WorkerResult.
 *
 * JSON-first: looks for a fenced ```json block, then for a JSON object
 * containing `"success"`, then falls back to text heuristics.
 */
export function parseWorkerResult(text: string): WorkerResult {
  const fromJson = extractWorkerResultJson(text);
  if (fromJson) return fromJson;
  return extractWorkerFromText(text);
}

function hasSubstance(text: string): boolean {
  const cleaned = text
    .replace(/^[-*]\s*/gm, '')
    .replace(/^#+\s*/gm, '')
    .trim();
  return cleaned.length > 20;
}

/**
 * Parse a reviewer's output text into a structured ReviewResult.
 *
 * JSON-first: looks for a fenced ```json block, then for a JSON object
 * containing `"decision"`, then falls back to text heuristics.
 */
export function parseReviewerResult(
  text: string,
  opts: { jsonOnly?: boolean } = {},
): ReviewResult {
  const fromJson = extractReviewerResultJson(text);
  if (fromJson) return fromJson;
  if (opts.jsonOnly) {
    return { decision: 'REVISE', feedback: '', issues: [], suggestions: [], output: text, recommendedActions: [] };
  }
  return extractReviewerFromText(text);
}

/**
 * A reviewer result is "substantiated" if it contains at least one concrete
 * issue or suggestion, or (for JSON results) has substantive feedback.
 *
 * This exists because the model sometimes outputs a decision with only a
 * narration paragraph that reads like a plan for what it will do next
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