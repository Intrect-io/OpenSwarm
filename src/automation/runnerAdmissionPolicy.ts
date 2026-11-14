// ============================================
// OpenSwarm — AutonomousRunner admission policy (AGT-4867, slice 1)
// ============================================
//
// Pure rules the runner applies when deciding how many candidates may run and
// how a deferral is described: per-project concurrency, worktree fan-out, the
// decision oversampling budget and the fail-closed conflict fallback. Split out
// of autonomousRunner.ts, which re-exports the public ones so existing imports
// keep working.

import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ScopeConflictReason } from '../orchestration/conflictDetector.js';
import type { AutonomousConfig } from './runnerTypes.js';

const DECISION_SELECTION_OVERSAMPLE = 3;

/** One source of truth for scheduler, heartbeat, and durable admission. */
export function effectiveProjectConcurrency(config: Pick<AutonomousConfig,
  'allowSameProjectConcurrent' | 'worktreeMode' | 'maxConcurrentPerProject' | 'maxConcurrentTasks'
>): number {
  const globalCap = Math.max(1, Math.floor(config.maxConcurrentTasks ?? 1));
  const parallel = worktreeFanoutEnabled(config);
  if (!parallel) return 1;
  // Match `openswarm review`: fill the available global pool. File-scope
  // conflict analysis and durable admission remain the safety boundary; an
  // omitted per-project setting must not impose a hidden throughput cap.
  const requested = Math.floor(config.maxConcurrentPerProject ?? globalCap);
  return Math.max(1, Math.min(requested, globalCap));
}

/** Worktrees isolate filesystem writes; file-scope admission still protects integration. */
export function worktreeFanoutEnabled(config: Pick<AutonomousConfig,
  'allowSameProjectConcurrent' | 'worktreeMode'
>): boolean {
  return (config.allowSameProjectConcurrent ?? true) && (config.worktreeMode ?? false);
}

/** Short, stable label for a task in operator-facing logs. */
export function taskLabel(task: TaskItem): string {
  return task.issueIdentifier || task.id.slice(0, 8);
}

/**
 * One-line cause for a deferral log. Without this the operator only sees that a
 * candidate was deferred, not whether a scope was unknown or which files
 * actually collided — the gap that made AGT-4233 need a ledger dig to diagnose.
 * The file list is capped so one blocked heartbeat cannot flood the log.
 */
export function describeConflictCause(reason: ScopeConflictReason, activeLabel: string): string {
  if (reason.kind === 'unknown-candidate') return 'candidate write scope unknown';
  if (reason.kind === 'unknown-active') return `${activeLabel} write scope unknown`;
  if (reason.shared.length === 0) return `overlaps ${activeLabel}`;
  const shown = reason.shared.slice(0, 3);
  const rest = reason.shared.length - shown.length;
  return `overlaps ${activeLabel} on ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

export type RunnableCandidate = { task: TaskItem; projectPath: string };

/**
 * Conflict analysis is an admission safety check. If it is unavailable, allow
 * only one candidate from that repository so uncertainty cannot turn into
 * concurrent overlapping edits. Input order already reflects decision priority.
 */
export function failClosedConflictFallback(candidates: readonly RunnableCandidate[]): Set<string> {
  return new Set(candidates.length > 0 ? [candidates[0].task.id] : []);
}

export function decisionSelectionBudget(availableSlots: number, candidateCount: number): number {
  const slots = Math.max(0, Math.floor(availableSlots));
  const candidates = Math.max(0, Math.floor(candidateCount));
  if (slots === 0 || candidates === 0) return 0;
  return Math.min(candidates, Math.max(slots, slots * DECISION_SELECTION_OVERSAMPLE));
}
