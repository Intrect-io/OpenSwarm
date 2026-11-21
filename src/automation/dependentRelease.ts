// Created: 2026-11-21
// Purpose: Release the tasks that waited on a finished issue and push each one to Todo in the tracker (AGT-4817 B).
// Dependencies: taskState/store (releaseDependentTasks, buildTaskStateSyncComment), trackerTransition, taskSource (lookup type)
// Test Status: covered by dependentRelease.test.ts, autonomousRunner.decompose.test.ts and runnerExecution tests

/**
 * A decomposed child that waits on another issue is created in Backlog. Releasing it locally
 * (`releaseDependentTasks`) is not enough: the readiness gate reads the tracker's state, so the
 * child must also be moved to Todo there, or it waits for a person forever. Both completion paths
 * call this: a published task (`reconcileCompletionState`) and a decomposed parent that closes
 * once every child has merged (`completeParentIfChildrenMerged`).
 *
 * The tracker move is fail closed (AGT-4784): only a daemon-decomposed child (local
 * `parentIssueId`) whose live tracker state is still Backlog is moved. A person's issue can carry
 * dependencies too, and the daemon never lifts a person's Backlog issue; a missing or failed
 * lookup skips the move.
 *
 * A failed push is logged and left to the next completion or a person; the local release keeps
 * its marker, so fetch-sync does not revert the local Todo meanwhile (store.ts).
 */
import { buildTaskStateSyncComment, getTaskState, releaseDependentTasks, type OpenSwarmTaskState } from '../taskState/store.js';
import type { ITaskSource } from './taskSource.js';
import { transitionWithReason, type TransitionSource } from './trackerTransition.js';

export type DependentReleaseSource = TransitionSource<'Todo'> & {
  lookupIssueState?: ITaskSource['lookupIssueState'];
};

/** Why the tracker move is skipped, or null when the child may go to Todo. */
async function trackerReleaseBlocker(source: DependentReleaseSource, child: OpenSwarmTaskState): Promise<string | null> {
  if (!child.parentIssueId) return 'it has no decomposition parent (not a daemon-created child)';
  // A person's issue the daemon later decomposed also carries parentIssueId; only the parent's child list proves ownership.
  if (!getTaskState(child.parentIssueId)?.childIssueIds.includes(child.issueId)) return 'its parent does not list it as a daemon-created child';
  if (!source.lookupIssueState) return 'the task source cannot look up its live state';
  const lookup = await source.lookupIssueState(child.issueId);
  if (!lookup.ok) return `the live state lookup failed: ${lookup.error}`;
  if (!lookup.issue) return 'the issue was not found in the tracker';
  const { state, stateType } = lookup.issue;
  const isBacklog = state.trim().toLowerCase() === 'backlog' || stateType?.trim().toLowerCase() === 'backlog';
  return isBacklog ? null : `its live state is ${state}, not Backlog`;
}

export async function releaseDependentsInTracker(
  source: DependentReleaseSource | null | undefined,
  completedIssueId: string,
): Promise<OpenSwarmTaskState[]> {
  const released = releaseDependentTasks(completedIssueId);
  if (!source) return released;
  for (const child of released) {
    try {
      const blocker = await trackerReleaseBlocker(source, child);
      if (blocker) {
        console.warn(`[AutonomousRunner] Not moving released dependent ${child.issueId} to Todo: ${blocker}`);
        continue;
      }
      const accepted = await transitionWithReason(source, child.issueId, 'Todo', buildTaskStateSyncComment(child, 'Task unblocked and ready'));
      if (!accepted) console.warn(`[AutonomousRunner] Tracker refused Todo for released dependent ${child.issueId}`);
    } catch (err) {
      console.warn(`[AutonomousRunner] Failed to release dependent task ${child.issueId}:`, err);
    }
  }
  return released;
}
