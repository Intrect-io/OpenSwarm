// OpenSwarm - one `git worktree add` at a time per repository
//
// The lifecycle lock is per issue, so issues of one repository can run
// `git worktree add` together. On a loaded CI runner two concurrent adds of one
// repository failed inside git with "fatal: gitfile does not point to a valid
// repository: <new worktree>/.git" (PR #929 CI, 2026-11-20), and AGT-4469
// recorded the same shape on cgf-portal as `.git/config` lock failures. The add
// itself takes well under a second, so queueing it per repository costs little
// and removes the race inside this process. Separate daemons on one checkout are
// not covered (they also share the durable run ledger, which keeps them off the
// same issues).

import { resolve } from 'node:path';

const tails = new Map<string, Promise<unknown>>();

/** Run `operation` after every earlier one queued for the same repository has settled. */
export function serializePerRepository<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  tails.set(key, settled);
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return run;
}
