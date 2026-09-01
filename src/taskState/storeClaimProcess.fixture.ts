import { resetTaskStateStoreForTests, upsertTaskState } from './store.js';
import { reconcileWithLinear } from './reconciler.js'; // assuming reconciler exists

const [stateFile, issueId, delayText = '0'] = process.argv.slice(2);
if (!stateFile || !issueId) throw new Error('state file and issue id are required');
process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
resetTaskStateStoreForTests();
await new Promise((resolve) => setTimeout(resolve, Number(delayText)));

// Simulate concurrent execution state update and reconciliation
await Promise.all([
  upsertTaskState(issueId, { status: 'running' }),
  reconcileWithLinear(issueId, { state: 'inProgress' })
]);

const finalState = upsertTaskState(issueId, { title: issueId });
console.log(`Final state for ${issueId}:`, finalState);
