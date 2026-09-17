// ============================================
// OpenSwarm - Worker audit log
// ============================================
//
// Every worker run should leave an audit trail on the issue: what it was
// instructed to do (start) and what it actually did (complete). These build the
// comment bodies posted via ITaskSource.addComment, so they work for Linear AND
// the local SQLite task source (which writes addComment → addEvent). See INT-1612.

import type { WorkerResult } from '../agents/agentPair.js';
import { formatAutomationComment, type CommentSection } from '../linear/format.js';

/** Caps so a chatty agent can't post a multi-MB comment. */
const MAX_FILES = 20;
const MAX_COMMANDS = 12;
const SUMMARY_CAP = 600;
const GOAL_CAP = 400;

function cap(s: string | undefined, n: number): string {
  if (!s) return '';
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
}

function inlineCode(s: string): string {
  return `\`${s.replaceAll('`', '\\`')}\``;
}

/** Render a list as inline code, capped, with an "+N more" suffix when truncated. */
function codeList(items: string[] | undefined, max: number): string {
  if (!items || items.length === 0) return '_(none)_';
  const shown = items.slice(0, max).map(inlineCode).join(', ');
  const extra = items.length - max;
  return extra > 0 ? `${shown} _+${extra} more_` : shown;
}

export interface WorkerStartInfo {
  /** 1-based iteration/attempt number. */
  attempt: number;
  maxAttempts?: number;
  taskTitle: string;
  /** Prompt summary — task description or draft intent summary. */
  taskGoal?: string;
  /** Files the worker is expected to touch (from draft analysis / impact). */
  targetFiles?: string[];
  /** Resolved model for this worker run. */
  model?: string;
  /** Max agentic turns (proxy for effort budget). */
  maxTurns?: number;
  /** True when this run follows reviewer/guard feedback (a revision). */
  isRevision?: boolean;
}

/** Comment body posted when a worker run starts (the instruction). */
export function buildWorkerStartComment(info: WorkerStartInfo): string {
  const attemptLabel = info.maxAttempts
    ? `attempt #${info.attempt}/${info.maxAttempts}`
    : `attempt #${info.attempt}`;
  const heading = info.isRevision ? 'Worker revision' : 'Worker instruction';

  const sections: CommentSection[] = [{ label: 'Task', body: cap(info.taskTitle, 200) }];
  if (info.taskGoal) sections.push({ label: 'Goal', body: cap(info.taskGoal, GOAL_CAP) });
  if (info.targetFiles && info.targetFiles.length > 0) {
    sections.push({ label: 'Target files', body: codeList(info.targetFiles, MAX_FILES) });
  }

  return formatAutomationComment({
    heading: `${heading} (${attemptLabel})`,
    sections,
    meta: { Model: info.model, 'Max turns': info.maxTurns ? info.maxTurns : 'unbounded' },
    attribution: 'Worker audit log',
  });
}

export interface WorkerCompleteInfo {
  attempt: number;
  maxAttempts?: number;
  result: WorkerResult;
  /** Worker run duration in seconds. */
  durationSec?: number;
}

/** Comment body posted when a worker run completes (the actions taken). */
export function buildWorkerCompleteComment(info: WorkerCompleteInfo): string {
  const { result } = info;
  const attemptLabel = info.maxAttempts
    ? `attempt #${info.attempt}/${info.maxAttempts}`
    : `attempt #${info.attempt}`;
  const verdict = result.haltReason ? 'Halted' : result.success ? 'Done' : 'Failed';

  const files = result.filesChanged ?? [];
  const commands = result.commands ?? [];

  const sections: CommentSection[] = [
    { label: `Files changed (${files.length})`, body: codeList(files, MAX_FILES) },
  ];
  if (commands.length > 0) {
    sections.push({ label: `Commands (${commands.length})`, body: codeList(commands, MAX_COMMANDS) });
  }
  if (result.haltReason) sections.push({ label: 'Halt reason', body: cap(result.haltReason, GOAL_CAP) });
  if (result.error) sections.push({ label: 'Error', body: cap(result.error, GOAL_CAP) });

  const duration = info.durationSec != null
    ? (info.durationSec < 60 ? `${info.durationSec}s` : `${Math.floor(info.durationSec / 60)}m ${info.durationSec % 60}s`)
    : undefined;

  return formatAutomationComment({
    heading: `Worker actions — ${verdict} (${attemptLabel})`,
    summary: result.summary ? cap(result.summary, SUMMARY_CAP) : undefined,
    sections,
    meta: {
      Confidence: result.confidencePercent != null ? `${result.confidencePercent}%` : undefined,
      Duration: duration,
    },
    attribution: 'Worker audit log',
  });
}
