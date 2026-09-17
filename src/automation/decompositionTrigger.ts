// ============================================
// OpenSwarm — when a task gets split instead of retried whole (AGT-4287)
// ============================================
//
// vela 24h: 2,797 attempts for 275 runs, 23.7% of them in runs that finished;
// the three worst runs burned 252 attempts between them. Decomposition is the
// only lever that turns the wrong task into the right ones, and none of those
// runs reached it: the check ran once, before the first attempt, on a duration
// guess made from the issue text — and every retry that resumed a preserved
// worktree skipped it entirely. Repeated failure is the one piece of evidence
// the estimate never had, and the resume path is exactly where it lives.

export interface DecompositionTriggerInput {
  /** Operator switch; off means never, whatever the failure count. */
  enableDecomposition: boolean;
  /** This attempt resumes a preserved worktree (a retry with prior work). */
  resumesPreservedWork: boolean;
  /** Failed attempts recorded for this issue before this one. */
  priorFailures: number;
  /** Failures after which a split is forced; 0 or less never forces. */
  decomposeAfterFailures: number;
  /** The text-only duration heuristic, consulted only when nothing forces. */
  heuristicNeedsDecomposition: () => boolean;
}

export interface DecompositionTrigger {
  /** Whether the planner runs at all. */
  checked: boolean;
  /** The failure budget is spent: the heuristic is skipped and the planner's "no split" is not honoured. */
  forced: boolean;
}

export function evaluateDecompositionTrigger(input: DecompositionTriggerInput): DecompositionTrigger {
  if (!input.enableDecomposition) return { checked: false, forced: false };
  const budget = input.decomposeAfterFailures;
  if (budget > 0 && input.priorFailures >= budget) return { checked: true, forced: true };
  // A resume with prior work is the same task, still small enough by the same
  // estimate — the planner call is not paid again until failures say otherwise.
  if (input.resumesPreservedWork) return { checked: false, forced: false };
  return { checked: input.heuristicNeedsDecomposition(), forced: false };
}
