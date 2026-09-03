// ============================================
// OpenSwarm — Linear output formatter
// ============================================
//
// Writes Linear comments/issues the way an engineer would: a plain-language lead,
// short facts kept inline, lists only where they help, and a quiet sign-off — not
// a telemetry dump. Still scannable (conclusion first, code refs, absolute dates),
// just without the robotic feel.
//
// Pure string builders: no I/O, no side effects, so the style lives in one place
// and stays unit-testable.

import { sanitizeAgentDisplayName } from '../coordination/agentNames.js';

/** Absolute date `YYYY-MM-DD` — bodies never use relative or full-ISO dates. */
export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** A `file:line` code reference (or just the path when no line is given). */
export function codeRef(file: string, line?: number): string {
  return line != null ? `${file}:${line}` : file;
}

const BULLET = '- ';

export interface CommentSection {
  /** Short label, e.g. "Reviewer". */
  label: string;
  /** A one-liner (kept inline), a multi-line note, or a list (rendered as bullets). */
  body: string | string[];
}

/**
 * Render a section the way someone would jot it down: a short single-line fact
 * goes inline (`**Label:** value`); a list or a multi-line note gets its own block.
 */
function renderSection(section: CommentSection): string {
  if (Array.isArray(section.body)) {
    const items = section.body.filter((line) => line && line.trim());
    return items.length ? `**${section.label}:**\n${items.map((l) => `${BULLET}${l}`).join('\n')}` : '';
  }
  const text = section.body.trim();
  if (!text) return '';
  return text.includes('\n')
    ? `**${section.label}:**\n${text}`
    : `**${section.label}:** ${text}`;
}

/** Per-agent usage the transcript attributes to each speaker. */
export interface SpeakerUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** The slice of pair-completion stats the dialogue transcript reads. */
export interface PairDialogueStats {
  workerSummary?: string;
  workerName?: string;
  workerUsage?: SpeakerUsage;
  reviewerFeedback?: string;
  reviewerDecision?: string;
  reviewerName?: string;
  reviewerUsage?: SpeakerUsage;
}

function compactTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One muted line of who ran on what and what it cost, under each utterance. */
function speakerUsageLine(usage: SpeakerUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  const tin = compactTokens(usage.inputTokens);
  const tout = compactTokens(usage.outputTokens);
  if (tin !== undefined || tout !== undefined) parts.push(`${tin ?? '?'} in / ${tout ?? '?'} out tok`);
  if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (usage.durationMs !== undefined) parts.push(`${(usage.durationMs / 1000).toFixed(0)}s`);
  return parts.length > 0 ? `_${parts.join(' · ')}_` : undefined;
}

function speakerTag(role: string, usage: SpeakerUsage | undefined, verdict?: string): string {
  const bits = [role, usage?.model, verdict].filter(Boolean);
  return ` (${bits.join(' · ')})`;
}

/**
 * Render the worker/reviewer exchange as a conversation, the way the operator
 * reads it — named speakers saying what they did and what they judged —
 * instead of a machine dump (AGT-4019). The worker's `Codename:` introduction
 * line is its name, not part of what it said, so it is lifted out of the body.
 * Names are model-supplied, so they are sanitized here at the sink — the board
 * registry's cleaning does not protect this path.
 */
export function formatPairDialogue(stats: PairDialogueStats): string | undefined {
  const workerSaid = stats.workerSummary?.replace(/^\s*Codename:.*$/im, '').trim();
  const lines: string[] = [];
  if (workerSaid) {
    const usage = speakerUsageLine(stats.workerUsage);
    lines.push(
      `**${sanitizeAgentDisplayName(stats.workerName) ?? 'Worker'}**${speakerTag('worker', stats.workerUsage)}: ${workerSaid}`
      + (usage ? `\n${usage}` : ''),
    );
  }
  if (stats.reviewerFeedback?.trim()) {
    const usage = speakerUsageLine(stats.reviewerUsage);
    lines.push(
      `**${sanitizeAgentDisplayName(stats.reviewerName) ?? 'Reviewer'}**${speakerTag('reviewer', stats.reviewerUsage, stats.reviewerDecision)}: ${stats.reviewerFeedback.trim()}`
      + (usage ? `\n${usage}` : ''),
    );
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

export interface AutomationCommentInput {
  /** Short bold lead, e.g. "Task complete". */
  heading: string;
  /** A natural one- or two-line summary in plain language — the voice of the comment. */
  summary?: string;
  /** Supporting details — empty ones are dropped. */
  sections?: CommentSection[];
  /** Trace facts for the quiet sign-off (session, attempts, …). */
  meta?: Record<string, string | number | undefined>;
  /** Sign-off attribution. Default: "via OpenSwarm". */
  attribution?: string;
  /** Sign-off date (absolute). Defaults to today. */
  date?: Date;
}

/**
 * Build a comment that reads like a person wrote it: bold lead, a plain-language
 * summary, a few supporting details, and a single muted (italic) sign-off line
 * carrying just enough trace to find the run later.
 */
export function formatAutomationComment(input: AutomationCommentInput): string {
  const parts: string[] = [`**${input.heading}**`];

  if (input.summary?.trim()) parts.push(input.summary.trim());

  for (const section of input.sections ?? []) {
    const rendered = renderSection(section);
    if (rendered) parts.push(rendered);
  }

  const trace: string[] = [];
  const attribution = input.attribution ?? 'via OpenSwarm';
  if (attribution) trace.push(attribution);
  if (input.meta) {
    for (const [key, value] of Object.entries(input.meta)) {
      if (value !== undefined && value !== '') trace.push(`${key} ${value}`);
    }
  }
  trace.push(isoDate(input.date));

  return `${parts.join('\n\n')}\n\n_${trace.join(' · ')}_`;
}

export interface IssueDescriptionInput {
  problem?: string;
  cause?: string;
  solution?: string;
  verification?: string;
}

/**
 * Build a bug/work issue description in the Problem / Cause / Solution /
 * Verification layout. Empty sections are omitted.
 */
export function formatIssueDescription(input: IssueDescriptionInput): string {
  const order: [keyof IssueDescriptionInput, string][] = [
    ['problem', 'Problem'],
    ['cause', 'Cause'],
    ['solution', 'Solution'],
    ['verification', 'Verification'],
  ];
  return order
    .filter(([key]) => input[key]?.trim())
    .map(([key, label]) => `**${label}** — ${input[key]!.trim()}`)
    .join('\n\n');
}

export interface TaskDescriptionInput {
  /** One-line (or short) summary of the sub-task. */
  summary: string;
  scope?: string[];
  verify?: string[];
  dependsOn?: string[];
  fileScope?: string[];
  estimateMinutes?: number;
  /** Parent title for the auto-decomposition sign-off. */
  parentTitle?: string;
}

/**
 * Build a decomposition sub-issue description: a summary, then scannable
 * Scope / Verify sections and a short facts list (depends-on, file scope,
 * estimate), with a quiet sign-off.
 */
export function formatTaskDescription(input: TaskDescriptionInput): string {
  const parts: string[] = [input.summary.trim()];

  if (input.scope?.length) {
    parts.push(`**Scope:**\n${input.scope.map((s) => `${BULLET}${s}`).join('\n')}`);
  }
  if (input.verify?.length) {
    parts.push(`**Verify:**\n${input.verify.map((s) => `${BULLET}${s}`).join('\n')}`);
  }

  const facts: string[] = [];
  if (input.dependsOn?.length) facts.push(`Depends on: ${input.dependsOn.join(', ')}`);
  if (input.fileScope?.length) facts.push(`File scope: ${input.fileScope.join(', ')}`);
  if (input.estimateMinutes != null) facts.push(`Estimate: ${input.estimateMinutes} min`);
  if (facts.length) parts.push(facts.map((f) => `${BULLET}${f}`).join('\n'));

  let body = parts.join('\n\n');
  if (input.parentTitle) {
    body += `\n\n_Split out from "${input.parentTitle}" during planning._`;
  }
  return body;
}

/** Inverse of formatTaskDescription's "File scope:" fact line, for dedup comparisons (AGT-2908). */
export function parseFileScopeFromDescription(description: string): string[] {
  const match = description.match(/file scope:\s*(.+)/i);
  if (!match) return [];
  return match[1].split(',').map((f) => f.trim()).filter(Boolean);
}
