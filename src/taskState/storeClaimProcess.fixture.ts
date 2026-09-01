import { resetTaskStateStoreForTests, upsertTaskState, getTaskState } from './store.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const [stateFile, issueId, delayText = '0'] = process.argv.slice(2);
if (!stateFile || !issueId) throw new Error('state file and issue id are required');
process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
resetTaskStateStoreForTests();
await new Promise((resolve) => setTimeout(resolve, Number(delayText)));
upsertTaskState(issueId, { title: issueId });

// Regression test: same-size replacement within one mtime tick
if (process.argv.includes('--test-replace')) {
  const content1 = JSON.stringify(getTaskState(issueId), null, 2);
  const content2 = JSON.stringify({ ...getTaskState(issueId), title: issueId + '-modified' }, null, 2);
  if (content1.length === content2.length) {
    await fs.writeFile(stateFile, content2);
    // Preserve mtime
    const stat = await fs.stat(stateFile);
    await fs.utimes(stateFile, stat.atime, stat.mtime);
  }
}