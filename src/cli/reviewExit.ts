// ============================================
// OpenSwarm - `openswarm review` exit-code contract (INT-3100)
// ============================================
//
// `review` is used as a CI merge gate, and CI reads nothing but the exit code.
// The dangerous failure mode is a quota-exhausted or infra-broken run that
// reviews nothing and still exits 0 — a silent pass. The contract below makes
// "the gate did not run" its own outcome, distinct from "the gate ran and
// rejected":
//
//   0  the gate ran and did not reject (approve/revise), or there was nothing
//      to review
//   1  the gate ran and the verdict is reject (or --fix left areas
//      unresolved/unverified)
//   2  the gate did NOT run — no verdict was produced (usage limit, adapter
//      infra failure, unparseable reviewer output, bad invocation)
//
// CI must treat any non-zero as a failed check; the 1/2 split exists so a
// workflow can retry or alert differently on "gate didn't run".

import { RateLimitError } from '../adapters/rateLimitError.js';

export const REVIEW_EXIT_OK = 0;
export const REVIEW_EXIT_REJECT = 1;
export const REVIEW_EXIT_GATE_NOT_RUN = 2;

/**
 * Describe a thrown review-command error for stderr. Every throw means no
 * verdict was produced, so the caller pairs this with REVIEW_EXIT_GATE_NOT_RUN;
 * a usage-limit error additionally carries its reset time.
 */
export function describeReviewGateFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RateLimitError) {
    const resetsAt = error.resetsAt ? ` Retry after ${new Date(error.resetsAt * 1000).toLocaleString()}.` : '';
    return `Review gate did NOT run — usage limit: ${message}.${resetsAt}`;
  }
  return `Review gate did NOT run: ${message}`;
}
