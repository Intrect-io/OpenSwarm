import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { withFileLock } from '../support/fileLock.js';

export function withFreshReviewLock<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  const key = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 24);
  const lockPath = join(homedir(), '.openswarm', 'locks', `fresh-review-${key}.lock`);
  return withFileLock(lockPath, operation, { timeoutMs: 60_000 });
}
