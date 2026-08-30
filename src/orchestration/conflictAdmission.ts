// ============================================
// OpenSwarm - Deterministic conflict admission
// ============================================

/**
 * Partition ordered candidates into deterministic pairwise-compatible waves.
 *
 * The caller owns ordering policy. With candidates ordered by priority and a
 * stable input-position tie-break, the first wave is a deterministic greedy
 * maximal independent set: every later candidate conflicts with at least one
 * candidate already admitted to that first wave.
 */
export function buildConflictFreeWaves<T>(
  candidates: readonly T[],
  conflicts: (left: T, right: T) => boolean,
): T[][] {
  const waves: T[][] = [];
  for (const candidate of candidates) {
    const wave = waves.find((peers) => peers.every((peer) => !conflicts(candidate, peer)));
    if (wave) wave.push(candidate);
    else waves.push([candidate]);
  }
  return waves;
}

/** Select the first deterministic conflict-free wave without exposing later waves. */
export function selectGreedyMaximalIndependentSet<T>(
  candidates: readonly T[],
  conflicts: (left: T, right: T) => boolean,
): T[] {
  return buildConflictFreeWaves(candidates, conflicts)[0] ?? [];
}
