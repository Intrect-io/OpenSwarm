// Created: 2026-11-21
// Purpose: Release the tasks that waited on a finished issue and push each one to Todo in the tracker (AGT-4817 B).
// Dependencies: taskState/store (releaseDependentTasks, buildTaskStateSyncComment), trackerTransition
// Test Status: covered by autonomousRunner.decompose.test.ts and runnerExecution tests

/**
 * A decomposed child that waits on another issue is created in Backlog. Releasing it locally
 * (`releaseDependentTasks`) is not enough: the readiness gate reads the tracker's state, so the
 * child must also be moved to Todo there, or it waits for a person forever. Both completion paths
 * call this: a published task (`reconcileCompletionState`) and a decomposed parent that closes
 * once every child has merged (`completeParentIfChildrenMerged`).
 *
 * A failed push is logged and left to the next completion or a person; the local release keeps
 * its marker, so fetch-sync does not revert the local Todo meanwhile (store.ts).
 */
import { buildTaskStateSyncComment, releaseDependentTasks, type OpenSwarmTaskState } from '../taskState/store.js';
import { transitionWithReason, type TransitionSource } from './trackerTransition.js';

export async function releaseDependentsInTracker(
  source: TransitionSource<'Todo'> | null | undefined,
  completedIssueId: string,
): Promise<OpenSwarmTaskState[]> {
  const released = releaseDependentTasks(completedIssueId);
  if (!source) return released;
  for (const child of released) {
    try {
      const accepted = await transitionWithReason(source, child.issueId, 'Todo', buildTaskStateSyncComment(child, 'Task unblocked and ready'));
      if (!accepted) console.warn(`[AutonomousRunner] Tracker refused Todo for released dependent ${child.issueId}`);
    } catch (err) {
      console.warn(`[AutonomousRunner] Failed to release dependent task ${child.issueId}:`, err);
    }
  }
  return released;
}
