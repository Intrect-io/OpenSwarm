/**
 * Snapshot the worktree before each iteration, and put it back when the loop is
 * demonstrably making no progress.
 *
 * Kept out of pairPipeline.ts, which sits a few lines under the 1500-line
 * ceiling the pre-commit hook enforces.
 */
import { safeConsole } from '../support/safeLog.js';
import {
  captureSnapshot,
  clearSnapshots,
  restoreSnapshot,
  snapshotEnabled,
} from '../support/worktreeSnapshot.js';
import { taskAttributionKey } from '../orchestration/decisionEngine.js';
import { isGitRepo, takeSnapshot } from '../support/gitTracker.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

type SnapshotTask = Pick<TaskItem, 'id' | 'issueId' | 'issueIdentifier'>;

export interface IterationSnapshotState {
  /** Absent when snapshots are switched off — every call then becomes a no-op. */
  runId?: string;
  /** Tree hash captured immediately before iteration N started. */
  byIteration: Map<number, string>;
  /**
   * One rollback per run.
   *
   * If the loop stagnates again after starting from clean ground, the problem
   * is not accumulated bad edits and restoring a second time would only spend
   * another iteration reaching the same place.
   */
  rolledBack: boolean;
}

export function createSnapshotState(task: SnapshotTask): IterationSnapshotState {
  return {
    runId: snapshotEnabled() ? taskAttributionKey(task) : undefined,
    byIteration: new Map(),
    rolledBack: false,
  };
}

/**
 * Record where this iteration starts.
 *
 * Never throws into the loop: a run that cannot snapshot should still do its
 * work, just without the ability to undo it. The failure is said out loud
 * rather than swallowed, because "no rollback happened" and "rollback was never
 * possible" are different things to an operator reading a stuck run.
 */
export interface SnapshotHost {
  projectPath: string;
  currentIteration: number;
  taskPrefix: string;
  snapshots?: IterationSnapshotState;
  /** Git tree the run started from; every worker iteration diffs against it too (AGT-4534). */
  runSnapshotHash?: string;
}

export async function captureBeforeIteration(host: SnapshotHost): Promise<void> {
  await captureRunStart(host);
  const { snapshots: state, projectPath: worktreePath, currentIteration: iteration, taskPrefix: prefix } = host;
  if (!state?.runId) return;
  try {
    const tree = await captureSnapshot(state.runId, worktreePath);
    state.byIteration.set(iteration, tree);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    safeConsole.log(`[${prefix}] Snapshot before iteration ${iteration} failed — this iteration cannot be undone: ${reason}`);
  }
}

export interface RollbackOutcome {
  iteration: number;
  changed: number;
  removed: string[];
}

/**
 * Put the worktree back to where the stagnating iteration found it.
 *
 * Returns undefined when there is nothing to roll back to, when the budget of
 * one rollback per run is spent, or when the restore itself failed — in every
 * one of those the caller falls through to the abort it would have done anyway.
 */
export async function rollbackStagnantIteration(
  host: SnapshotHost,
  progressed: boolean,
): Promise<RollbackOutcome | undefined> {
  const { snapshots: state, projectPath: worktreePath, currentIteration: iteration, taskPrefix: prefix } = host;
  // Only stagnation. A reviewer revise is feedback about work worth keeping,
  // and a spent reflection budget means the loop is ending anyway.
  if (progressed) return undefined;
  if (!state?.runId || state.rolledBack) return undefined;
  const tree = state.byIteration.get(iteration);
  if (!tree) return undefined;

  try {
    const { changed, removed } = await restoreSnapshot(state.runId, worktreePath, tree);
    state.rolledBack = true;
    // "ignored files were not" is not a disclaimer, it is the difference
    // between an operator trusting the worktree and having to check it: the
    // snapshot honours .gitignore, so a build artefact an iteration wrote is
    // still there.
    safeConsole.log(
      `[${prefix}] Rolled back to the start of iteration ${iteration} — `
      + `${changed.length} tracked path(s) restored, ${removed.length} added file(s) removed. `
      + 'Files matched by .gitignore were not snapshotted and are unchanged.',
    );
    return { iteration, changed: changed.length, removed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    safeConsole.log(`[${prefix}] Rollback to iteration ${iteration} failed, continuing without it: ${reason}`);
    return undefined;
  }
}

/** Called when a run reaches a terminal state. Never throws into the caller. */
export async function discardSnapshots(state: IterationSnapshotState | undefined): Promise<void> {
  if (!state?.runId) return;
  await clearSnapshots(state.runId).catch(() => undefined);
}

/**
 * Record, once, the Git tree the run started from.
 *
 * Each worker invocation diffs against its own snapshot, so an iteration that
 * only answers a review (the fix already made by an earlier iteration) looked
 * like it changed nothing and failed the run with accepted work in the tree
 * (AGT-4534). Unlike the rollback snapshots this is the repository's
 * own Git tree, the one the worker's snapshot is compared in. Without it the
 * worker behaves as before.
 */
async function captureRunStart(host: SnapshotHost): Promise<void> {
  if (host.currentIteration !== 1 || host.runSnapshotHash) return;
  try {
    if (await isGitRepo(host.projectPath)) host.runSnapshotHash = await takeSnapshot(host.projectPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    safeConsole.log(`[${host.taskPrefix}] Run-start snapshot failed — later iterations count only their own edits: ${reason}`);
  }
}
