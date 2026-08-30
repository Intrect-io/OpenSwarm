// ============================================
// OpenSwarm - decomposition admission limits
// Pure: does this plan fit the operator's caps?
// ============================================

export interface DecompositionScope {
  /** Sub-issues the parent already has. */
  existingChildren: number;
  /**
   * Whether this run is resuming an interrupted decomposition. Its plan
   * re-proposes children that already exist, and both the creation path and the
   * daily counter dedupe them, so the two must not be summed.
   */
  recovering: boolean;
  /** Sub-issues this plan proposes. */
  plannedChildren: number;
}

/**
 * How many issues this plan will actually bring into being.
 *
 * A recovering plan re-proposes children that already exist, and
 * createSubIssuesWithDependencies dedupes them by idempotencyId, so only the
 * surplus is new work — mirroring registerDecomposition's own accounting, which
 * adds `newlyRegistered` rather than the whole plan.
 */
export function plannedNewChildren(scope: DecompositionScope): number {
  return scope.recovering
    ? Math.max(0, scope.plannedChildren - scope.existingChildren)
    : scope.plannedChildren;
}

/**
 * Why this plan must not proceed under the per-parent cap, or `null` to admit.
 *
 * The cap is checked against what the run will actually *leave behind*, not what
 * it asks for. The pre-check upstream asks a weaker question — "has this parent
 * already hit the cap?" — and lets a plan through that then overshoots.
 * Measured: a configured cap of 3 produced 9 children. (AGT-4122)
 *
 * Children are only ever added, never removed, so a recovery whose parent
 * already sits over the cap must still refuse: re-proposing fewer children than
 * exist does not delete the surplus.
 *
 * The caller refuses rather than truncates. Taking the first N would leave the
 * parent looking decomposed with scope the planner judged necessary silently
 * dropped; falling through to direct execution loses nothing.
 */
export function refuseForChildCap(scope: DecompositionScope, maxChildren: number): string | null {
  const projected = scope.existingChildren + plannedNewChildren(scope);
  if (projected <= maxChildren) return null;
  return `would leave ${projected} sub-issues`
    + ` (${scope.existingChildren} existing + ${plannedNewChildren(scope)} new), over the ${maxChildren} cap`;
}
