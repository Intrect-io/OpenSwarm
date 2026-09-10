import { resetTaskStateStoreForTests, upsertTaskState, getTaskState } from './store.js';
import { promises as fs } from 'node:fs';

const [stateFile, issueId, delayText = '0', mode] = process.argv.slice(2);
if (!stateFile || !issueId) throw new Error('state file and issue id are required');
process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
resetTaskStateStoreForTests();
await new Promise((resolve) => setTimeout(resolve, Number(delayText)));
upsertTaskState(issueId, { title: issueId });

// Same-size replacement within one mtime tick (new inode via unlink+write).
// Proves ensureStoreLoaded invalidates when mtime+size alone would match.
if (mode === '--same-size-replace') {
  const warmed = getTaskState(issueId);
  if (warmed?.title !== issueId) throw new Error('expected warm cache before replacement');

  // Keep the JSON byte length identical (e.g. SWAP-SRC → SWAP-DST).
  const swappedTitle = issueId.replace(/SRC$/, 'DST');
  if (swappedTitle === issueId || swappedTitle.length !== issueId.length) {
    throw new Error(`issueId must end with SRC for same-size replace (got ${issueId})`);
  }

  const original = await fs.readFile(stateFile, 'utf8');
  const marker = `"title": ${JSON.stringify(issueId)}`;
  const replacement = `"title": ${JSON.stringify(swappedTitle)}`;
  if (marker.length !== replacement.length) {
    throw new Error(`titles must be same length for same-size replace (${marker.length} vs ${replacement.length})`);
  }
  const replaced = original.replace(marker, replacement);
  if (replaced.length !== original.length) {
    throw new Error(`replacement must keep the same byte length (${original.length} → ${replaced.length})`);
  }

  const stat = await fs.stat(stateFile);
  await fs.unlink(stateFile);
  await fs.writeFile(stateFile, replaced, 'utf8');
  await fs.utimes(stateFile, stat.atime, stat.mtime);

  // Do not reset the cache — invalidation must come from the stamp (incl. ino).
  const after = getTaskState(issueId);
  if (after?.title !== swappedTitle) {
    throw new Error(`cache missed replacement: got ${JSON.stringify(after?.title)}`);
  }
}
