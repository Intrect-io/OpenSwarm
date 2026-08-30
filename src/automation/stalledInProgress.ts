import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { TaskState } from './taskSource.js';

export interface StalledInProgressCandidate {
  task: TaskItem;
  targetState: Extract<TaskState, 'Backlog' | 'In Review'>;
}

export interface StalledInProgressContext {
  now: number;
  staleAfterMs: number;
  /** Current canonical OpenSwarm claim; never retire a human/foreign claim. */
  hasOpenSwarmClaim: (issueId: string) => boolean;
  isSchedulerOwned: (issueId: string) => boolean;
  hasLiveLease: (issueId: string) => boolean;
  hasPublishedArtifact: (issueId: string) => boolean;
}

/**
 * Find tracker claims that no longer describe real execution.
 *
 * This uses the issue tracker timestamp, not the local ledger timestamp:
 * Linear is the operator-facing source whose state must remain trustworthy.
 * Invalid or missing timestamps fail closed and are left untouched.
 */
export function planStalledInProgress(
  tasks: readonly TaskItem[],
  context: StalledInProgressContext,
): StalledInProgressCandidate[] {
  if (!Number.isFinite(context.now) || !Number.isFinite(context.staleAfterMs) || context.staleAfterMs <= 0) {
    return [];
  }

  return tasks.flatMap((task) => {
    if (task.linearState !== 'In Progress') return [];
    const issueId = task.issueId || task.id;
    const updatedAt = task.trackerUpdatedAt;
    if (!Number.isFinite(updatedAt) || updatedAt! > context.now) return [];
    if (context.now - updatedAt! < context.staleAfterMs) return [];
    if (!context.hasOpenSwarmClaim(issueId)) return [];
    if (context.isSchedulerOwned(issueId) || context.hasLiveLease(issueId)) return [];
    return [{
      task,
      targetState: context.hasPublishedArtifact(issueId) ? 'In Review' : 'Backlog',
    }];
  });
}
