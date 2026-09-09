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
import {
  AUDIT_FILES_MAX,
  AUDIT_COMMANDS_MAX,
  AUDIT_SUMMARY_CAP,
  AUDIT_GOAL_CAP,
  capArray,
  codeList,
} from '../support/outputBudget.js';

/** Caps so a chatty agent can't post a multi-MB comment. */
const MAX_FILES = AUDIT_FILES_MAX;
const MAX_COMMANDS = AUDIT_COMMANDS_MAX;
const SUMMARY_CAP = AUDIT_SUMMARY_CAP;
const GOAL_CAP = AUDIT_GOAL_CAP;

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
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  /** The goal the worker was asked to achieve (from the task). */
  goal?: string;
}

/**
 * Build the "worker started" audit comment.
 */
export function buildWorkerStartComment(info: WorkerStartInfo): string {
  const sections: CommentSection[] = [];

  if (info.goal) {
    sections.push({ label: 'Goal', body: cap(info.goal, GOAL_CAP) });
  }

  return formatAutomationComment({
    heading: 'Worker started',
    summary: cap(info.taskTitle, SUMMARY_CAP),
    sections,
    meta: {
      Project: info.projectPath,
    },
    attribution: 'Worker audit log',
  });
}

export interface WorkerCompleteInfo {
  result: WorkerResult;
  /** Seconds the worker ran for. */
  durationSec?: number;
  /** Which attempt number this was (1-based). */
  attempt?: number;
  /** Max attempts allowed. */
  maxAttempts?: number;
}

/**
 * Build the "worker completed" audit comment.
 * Caps individual file and command entries before rendering to prevent oversized comments.
 */
export function buildWorkerCompleteComment(info: WorkerCompleteInfo): string {
  const { result } = info;
  const verdict = result.success ? '✅ Complete' : '❌ Failed';
  const attemptLabel = info.attempt != null && info.maxAttempts != null
    ? `(attempt ${info.attempt}/${info.maxAttempts})`
    : '';

  const sections: CommentSection[] = [];

  // Files changed — capped to prevent oversized comments
  if (result.filesChanged && result.filesChanged.length > 0) {
    const { shown, omitted } = capArray(result.filesChanged, MAX_FILES);
    const filesStr = shown.map(inlineCode).join(', ');
    const body = omitted > 0 ? `${filesStr} _+${omitted} more_` : filesStr;
    sections.push({ label: 'Files changed', body });
  }

  // Commands run — capped to prevent oversized comments
  if (result.commands && result.commands.length > 0) {
    const { shown, omitted } = capArray(result.commands, MAX_COMMANDS);
    const cmdsStr = shown.map(inlineCode).join(', ');
    const body = omitted > 0 ? `${cmdsStr} _+${omitted} more_` : cmdsStr;
    sections.push({ label: 'Commands', body });
  }

  // Error — capped
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