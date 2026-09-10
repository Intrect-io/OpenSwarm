/**
 * Multi-process fixture: concurrent execution-state upsert and Linear
 * reconciliation against the same task-state file.
 *
 * Spawned by store.test.ts — keep imports limited to store.js (no dead
 * reconciler module).
 */
import { resetTaskStateStoreForTests, upsertTaskState, updateTaskLinearState, getTaskState } from './store.js';

const [stateFile, issueId, delayText = '0'] = process.argv.slice(2);
if (!stateFile || !issueId) throw new Error('state file and issue id are required');
process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
resetTaskStateStoreForTests();
await new Promise((resolve) => setTimeout(resolve, Number(delayText)));

// Concurrent execution-state update and Linear reconciliation on the same issue.
// Both paths take the store write lock; neither update may be lost.
await Promise.all([
  upsertTaskState(issueId, {
    title: issueId,
    execution: { status: 'in_progress', retryCount: 0 },
  }),
  updateTaskLinearState(issueId, 'In Progress'),
]);

const verified = getTaskState(issueId);
if (!verified || verified.title !== issueId) {
  throw new Error(`expected title ${issueId}, got ${verified?.title}`);
}
if (verified.linearState !== 'In Progress') {
  throw new Error(`expected linearState In Progress, got ${verified.linearState}`);
}
if (verified.execution.status !== 'in_progress') {
  throw new Error(`expected execution in_progress, got ${verified.execution.status}`);
}
console.log(`Final state for ${issueId}:`, verified.execution.status, verified.linearState);
