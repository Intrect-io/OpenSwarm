// ============================================
// OpenSwarm - Repository Knowledge (repo-scoped memory)
// Created: 2026-06-10
// Purpose: Make repository understanding accumulate across tasks — extract repo
//          knowledge from task outcomes (write) and inject it into the next
//          task's worker prompt (read). Storage reuses the existing memoryCore
//          (LanceDB, repo field) — no new storage layer.
//          vega-agent pattern: relevance-based dynamic injection rather than a
//          fixed persona block.
// ============================================

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { saveMemory, searchMemorySafe } from './memoryCore.js';
import { isTransientReviewerFailure } from './memoryFilters.js';
import type { WorkerResult, RecommendedAction } from '../agents/agentPair.js';
import { readStagedMemories } from '../agents/stagedMemory.js';

/**
 * Normalize a project path into a stable repo key. The LanceDB repo filter is
 * an exact string match, so trailing slashes or symlinked paths to the same
 * repo would otherwise split the knowledge across keys that never match.
 */
export function repoKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved; // path may not exist yet (tests, dry runs) — resolve is enough
  }
  // Per-issue git worktrees live at `<repo>/worktree/<issueId>` (worktreeManager).
  // Normalize them back to the repo so knowledge accumulates per-repo instead of
  // per ephemeral worktree — each worktree is a unique key recall never revisits,
  // which silently broke cross-task accumulation. (INT-1856)
  return real.replace(/\/worktree\/[^/]+\/?$/, '');
}

/** Repo knowledge item injected into the worker prompt (mirrors locale WorkerContext) */
export interface RepoMemoryBrief {
  type: string;     // system_pattern | constraint | fact ...
  title: string;
  content: string;
}

/** Per-memory content cap at injection time — keeps long retros from eating the prompt */
const MAX_CONTENT_CHARS = 400;
const RECALL_LIMIT = 5;

/**
 * Recall repo knowledge relevant to the current task.
 * Always non-blocking — the pipeline runs even if memory is empty or the DB is down.
 */
export async function recallRepoKnowledge(
  projectPath: string,
  taskTitle: string,
  taskDescription: string,
): Promise<RepoMemoryBrief[]> {
  try {
    const query = `${taskTitle}\n${taskDescription}`.slice(0, 500);
    const result = await searchMemorySafe(query, {
      repo: repoKey(projectPath),
      // Include 'belief' — memories from other write paths may have been
      // distilled down to belief and would otherwise be filtered out.
      types: ['system_pattern', 'constraint', 'fact', 'strategy', 'belief'],
      limit: RECALL_LIMIT,
      minSimilarity: 0.35,
    });
    if (!result.success) return [];
    return result.memories.map((m) => ({
      type: m.type,
      title: m.title,
      content: m.content.length > MAX_CONTENT_CHARS
        ? m.content.slice(0, MAX_CONTENT_CHARS) + '…'
        : m.content,
    }));
  } catch {
    return [];
  }
}

/**
 * Free-form, repo-scoped memory search rendered as plain text. Shared by the
 * in-loop `search_memory` tool (tools.ts) and the MCP memory server so both
 * surface identical results. Always non-throwing — returns a human-readable line.
 */
export async function searchRepoMemoryText(
  projectPath: string,
  query: string,
  limit = 5,
): Promise<string> {
  const q = (query ?? '').trim();
  if (!q) return 'A non-empty query is required.';
  const res = await searchMemorySafe(q, {
    repo: repoKey(projectPath),
    types: ['system_pattern', 'constraint', 'fact', 'strategy', 'belief'],
    limit: Math.min(Math.max(limit, 1), 10),
    minSimilarity: 0.3,
  });
  if (!res.success) return `Memory unavailable (${res.errorCode ?? 'unknown'}); proceed without it.`;
  if (res.memories.length === 0) return 'No matching repo knowledge yet for this query.';
  const formatted = res.memories
    .map((m) => `- [${m.type}] ${m.title}\n  ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return `Repository knowledge (${res.memories.length}):\n${formatted}`;
}

export interface TaskOutcomeInput {
  taskTitle: string;
  /** Provenance tracker, e.g. Linear issue ID */
  derivedFrom?: string;
  workerResult?: Pick<WorkerResult, 'filesChanged' | 'commands' | 'summary'> | null;
  /** Reviewer rejection reason — stored as a constraint (pitfall) when present */
  rejectionFeedback?: string;
  /** Pipeline iteration count (1 = passed on the first attempt) */
  iterations?: number;
}

/**
 * Extract and store repo knowledge from a task outcome.
 * - Success: which files changed and how it passed → system_pattern (a shortcut
 *   for the next similar task)
 * - Rejection: the pitfall the reviewer flagged → constraint (blocks repeating
 *   the same mistake)
 * skipDistillation: this is already structured knowledge — distillation would
 * downgrade the type to 'belief' and drop it from type-filtered recall.
 */
export async function recordTaskOutcome(
  projectPath: string,
  outcome: TaskOutcomeInput,
): Promise<void> {
  try {
    const repo = repoKey(projectPath);
    if (outcome.rejectionFeedback) {
      if (isTransientReviewerFailure(outcome.rejectionFeedback)) {
        console.log('[RepoKnowledge] skipped transient reviewer failure memory');
        return;
      }

      const feedback = outcome.rejectionFeedback.slice(0, 600);
      await saveMemory(
        'constraint',
        repo,
        `Review rejection: ${outcome.taskTitle.slice(0, 80)}`,
        `Task "${outcome.taskTitle}" was rejected by the reviewer.\n` +
        `Actionable reviewer feedback: ${feedback}`,
        {
          derivedFrom: outcome.derivedFrom,
          confidence: 0.82,
          importance: 0.82,
          skipDistillation: true,
          metadata: {
            kind: 'review_rejection',
            transient: false,
            actionable: true,
            taskTitle: outcome.taskTitle,
            feedback,
          },
        },
      );
      return;
    }

    const files = outcome.workerResult?.filesChanged ?? [];
    if (files.length === 0) return; // nothing to learn from a task that changed no files

    const parts = [
      `Task "${outcome.taskTitle}" completed successfully.`,
      `Files changed: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` (+${files.length - 10} more)` : ''}.`,
    ];
    if (outcome.workerResult?.summary) {
      parts.push(`Approach: ${outcome.workerResult.summary.slice(0, 400)}`);
    }
    if (outcome.iterations && outcome.iterations > 1) {
      parts.push(`Took ${outcome.iterations} iterations before passing review.`);
    }
    await saveMemory(
      'system_pattern',
      repo,
      `Solved: ${outcome.taskTitle.slice(0, 80)}`,
      parts.join('\n'),
      {
        derivedFrom: outcome.derivedFrom,
        confidence: 0.82,
        importance: outcome.iterations && outcome.iterations > 1 ? 0.78 : 0.74,
        skipDistillation: true,
        metadata: {
          kind: 'task_success',
          filesChanged: files.slice(0, 20),
          iterations: outcome.iterations ?? 1,
        },
      },
    );
  } catch (err) {
    // Memory write failures must never stop the pipeline
    console.warn('[RepoKnowledge] recordTaskOutcome failed (non-critical):', err);
  }
}

/** Promote only the lessons staged by a green run; failures never call this. */
export async function promoteStagedMemories(
  projectPath: string,
  runId: string,
  provenance: { attempt: number; taskId: string },
): Promise<number> {
  const entries = await readStagedMemories(runId);
  for (const entry of entries) {
    await saveMemory(entry.kind === 'pattern' ? 'system_pattern' : 'constraint', repoKey(projectPath), entry.title.slice(0, 120), entry.content, {
      derivedFrom: entry.taskId,
      confidence: 0.78,
      importance: 0.72,
      skipDistillation: true,
      metadata: { kind: 'agent_remember', taskId: provenance.taskId, attempt: provenance.attempt, iteration: entry.iteration },
    });
  }
  return entries.length;
}

/**
 * Record the outcome of a `review --max` audit as ONE repo constraint — the
 * verdict plus the top follow-ups, so the next worker/reviewer knows this repo's
 * known pitfalls. Capped at 10 actions on purpose: an audit can surface hundreds
 * of findings and storing each would flood the repo memory. Non-critical.
 * (INT-2268)
 */
export async function recordAuditFindings(
  projectPath: string,
  summary: { decision: string; recommendedActions: RecommendedAction[] },
  stamp?: string,
): Promise<void> {
  try {
    if (!summary.recommendedActions.length) return;
    const repo = repoKey(projectPath);
    const top = summary.recommendedActions.slice(0, 10);
    const when = stamp ?? new Date().toISOString().slice(0, 10);
    const body = [
      `Codebase audit verdict: ${summary.decision.toUpperCase()} (${when}).`,
      `Known issues / follow-ups to be aware of in this repo:`,
      ...top.map((a) => `- [${a.type}] ${a.title}${a.location ? ` (${a.location})` : ''}`),
      summary.recommendedActions.length > top.length ? `(+${summary.recommendedActions.length - top.length} more — see the audit report)` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const decision = summary.decision.toLowerCase();
    const importance = decision === 'reject'
      ? 0.9
      : decision === 'revise'
        ? 0.84
        : 0.68;
    await saveMemory('constraint', repo, `Audit findings (${when})`, body, {
      derivedFrom: 'cli:review-max',
      importance,
      confidence: 0.86,
      skipDistillation: true,
      metadata: {
        kind: 'audit_findings',
        decision: summary.decision,
        actionCount: summary.recommendedActions.length,
        topActions: top.map(a => ({
          type: a.type,
          title: a.title,
          location: a.location,
        })),
      },
    });
  } catch (err) {
    console.warn('[RepoKnowledge] recordAuditFindings failed (non-critical):', err);
  }
}
