// ============================================
// OpenSwarm — refuse to re-claim already-shipped work (AGT-4177)
// ============================================
//
// Measured on vela: AX-863's PR #179 merged 08-29, Linear went Done 08-30,
// then flapped Todo↔In Progress and burned attempt 37 / 19 in 24h. The daemon
// treated an open Linear card as a retry license. A terminal durable run that
// already published a PR, with no explicit residual delta, must not be
// markReady'd or claimed again.

import type { TaskItem } from '../orchestration/decisionEngine.js';

/** Explicit residual the operator left so a shipped card may reopen. */
const REMAINING_DELTA_RE = /(?:^|\n)\s*(?:remaining work|openswarm-remaining)\s*[:：]\s*\S+/i;

export function hasExplicitRemainingDelta(task: TaskItem): boolean {
  const text = `${task.description ?? ''}\n${task.authoritativeOperatorFeedback ?? ''}`;
  return REMAINING_DELTA_RE.test(text);
}

export interface ShippedClaimSnapshot {
  /** Durable run already published a PR (open or merged). */
  hasPrUrl: boolean;
  /** Durable state is DONE / DECOMPOSED / CANCELLED. */
  shippedTerminal: boolean;
}

/**
 * True when this card must NOT be reopened into READY / claimed.
 * `explicitDispatch` still wins — a person asking for a follow-up.
 */
export function shouldRefuseShippedClaim(
  task: TaskItem,
  snapshot: ShippedClaimSnapshot,
): boolean {
  if (task.explicitDispatch === true) return false;
  if (hasExplicitRemainingDelta(task)) return false;
  if (!snapshot.shippedTerminal) return false;
  // Publication is the ship signal. Local/no-PR completions may still be
  // reopened from Todo for a genuine redo without a residual marker.
  return snapshot.hasPrUrl;
}
