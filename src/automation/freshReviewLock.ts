import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { withFileLock } from '../support/fileLock.js';

/**
 * One lock file per checkout, so every operation that moves that working tree
 * contends on the same lease. Keyed by the resolved path rather than the project
 * name: two names for one directory must not mint two leases.
 */
export function prLeaseLockPath(projectPath: string): string {
  const key = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 24);
  return join(homedir(), '.openswarm', 'locks', `fresh-review-${key}.lock`);
}

/**
 * Cross-process lock around the git mutations of one checkout.
 *
 * `timeoutMs` is the caller's waiting budget: a fresh review is short work that
 * can legitimately queue behind another, while whole-PR work runs for minutes
 * and is better refused than waited on (see `withPRProcessLease`).
 */
export function withFreshReviewLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
  timeoutMs = 60_000,
): Promise<T> {
  return withFileLock(prLeaseLockPath(projectPath), operation, { timeoutMs });
}
