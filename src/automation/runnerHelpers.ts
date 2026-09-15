import { TaskItem } from '../orchestration/decisionEngine.js';
import { OPERATOR_PARK_REASON } from '../coordination/operatorAnswers.js';
// ExecutorResult used via execution.reportExecutionResult
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { upsertTaskState } from '../taskState/store.js';
import { removePreservedWorktreeAt } from '../support/worktreeManager.js';
import { publishStuckWork } from './publishOnPark.js';
import { type ScopeConflictReason } from '../orchestration/conflictDetector.js';
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

export type CachedDraftScope = {
  fingerprint: string;
  fileScope: string[];
  draft: NonNullable<TaskItem['preAdmissionDraft']>;
  description?: string;
  executionCommentsLoaded?: boolean;
};

// The completion/cancellation effect payload contract (and its delivery) lives
// in trackerEffects.ts, shared with the `openswarm work` CLI so the marker
// format cannot drift between the two outbox writers. (INT-3387)

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

/**
 * Record, or retire, the stand-in park signal for a task whose park cannot be
 * carried by the run ledger.
 *
 * Best effort in both directions, and deliberately so. Failing to record leaves
 * the task on its backoff, which is only a delay. Failing to retire costs at
 * most one early retry, still capped by MAX_RETRY_COUNT — whereas refusing to
 * admit the task until the write succeeds could stall it for good.
 */
export function setOperatorPark(issueId: string, parked: boolean): void {
  try {
    upsertTaskState(issueId, {
      execution: { blockedReason: parked ? OPERATOR_PARK_REASON : undefined },
    } as Parameters<typeof upsertTaskState>[1]);
  } catch (error) { // cxt-ignore: error_swallow — the backoff is the fallback
    console.warn(`[AutonomousRunner] Could not record the operator park for ${issueId}:`, error);
  }
}

export function setSandboxOutcomePark(issueId: string, parked: boolean): void {
  try {
    upsertTaskState(issueId, {
      execution: { blockedReason: parked ? SANDBOX_OUTCOME_UNKNOWN_PARK_REASON : undefined },
    } as Parameters<typeof upsertTaskState>[1]);
  } catch (error) {
    console.warn(`[AutonomousRunner] Could not record sandbox outcome quarantine for ${issueId}:`, error);
  }
}

/**
 * Terminal park: publish the work before freeing the disk.
 *
 * All three terminal parks (sandbox infeasibility, the rejection limit, retry
 * exhaustion) used to commit the partial work to a local branch and delete the
 * worktree, leaving the commits unpushed and invisible. Reaching one of them is
 * the run having built as far as it can and hit the point where the operator
 * has to look, which is exactly when the work should be reviewable.
 *
 * Publication is a hook of the cleanup rather than a call before it so it runs
 * under the same worktree lifecycle lock, after the ownership re-check has
 * proven no resumed worker is still editing the tree, and after the pre-cleanup
 * WIP commit that captures the last of the work.
 *
 * That lock is NOT the durable publication fence, though: it proves no worker
 * is still editing this tree, not that this executor still owns the run. Those
 * are different guarantees, and pushing needs the second one. `ownsRun` carries
 * it — see the call sites, where it is the result of the durable park. Cleanup
 * still runs when it is false; only the push is withheld.
 */
export async function publishAndCleanupStuckWorktree(
  task: TaskItem,
  projectPath: string,
  parkReason: string,
  ownsRun: boolean,
): Promise<string | undefined> {
  let prUrl: string | undefined;
  await removePreservedWorktreeAt(
    projectPath,
    ownsRun
      ? async (ctx) => { prUrl = await publishStuckWork(ctx, task, parkReason); }
      : undefined,
  ).catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
  return prUrl;
}

/**
 * Park the run durably and report whether this executor was the one entitled to.
 *
 * `markNeedsHuman` refuses a row that is in a non-parkable state or still
 * carries an owner or lease, so a `true` here is exactly the proof the
 * publication fence gives the reviewed path: this run is ours, durably parked,
 * and unowned. A stale executor whose claim already ended gets `false` and must
 * not push. With no ledger authority (`mode` off or shadow) there is no durable
 * claim to speak of, and behaviour is what it was before publication existed.
 */
export function parkRunForHuman(
  durableRuns: { isPrimary: boolean; markNeedsHuman(issueId: string, reason: string): boolean },
  issueId: string,
  reason: string,
): boolean {
  if (!durableRuns.isPrimary) return true;
  const parked = durableRuns.markNeedsHuman(issueId, reason);
  if (!parked) {
    console.warn(`[Runner] ${issueId}: durable park refused — not publishing work this executor no longer owns`);
  }
  return parked;
}

/** Tracker-comment section pointing the operator at the published draft. */
export function stuckPullRequestSection(prUrl: string | undefined): string {
  return prUrl
    ? `\n\n**Draft PR with the work so far:** ${prUrl}`
    : '';
}
