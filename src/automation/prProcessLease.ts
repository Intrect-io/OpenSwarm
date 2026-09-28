import { prLeaseLockPath, withFreshReviewLock } from './freshReviewLock.js';

export { prLeaseLockPath };

/**
 * The cross-process lease every whole-PR one-shot command takes on a checkout.
 *
 * `processPR` and `processReviewFeedback` move the SAME working tree — stash,
 * checkout `pr.branch`, commit, push — so two of them racing (a `pr fix` and the
 * cron scan, or two CLI invocations) interleave those steps: one stashes the
 * other's in-progress work, or a commit that was never tested on the tree it was
 * based on gets pushed. (AGT-3468)
 *
 * Routed through `withFreshReviewLock` — the same lease the cron scan and
 * `freshReview` already take for this checkout — rather than a second lock
 * mechanism, so every path contends on one lock and none can bypass another.
 *
 * The wait budget is short because the holder runs for minutes (a pipeline plus
 * a CI wait). Waiting on it is time the caller loses anyway, so contention is
 * reported as a refusal the caller can print and retry.
 */
export async function withPRProcessLease<T>(
  projectPath: string,
  key: string,
  operation: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T | { success: false; error: string; iterations: 0 }> {
  try {
    return await withFreshReviewLock(projectPath, operation, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Timed out waiting for file lock')) throw error;
    console.log(`[PRProcessor] ${key}: another process owns the PR processing lease`);
    return { success: false, error: 'Another process owns the PR processing lease', iterations: 0 };
  }
}
