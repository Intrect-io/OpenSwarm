// Deterministic duplicate-sibling detection for decomposition drafts (AGT-2908).
//
// The LLM-based draft gate (draftGrooming.ts) compares top-level tasks against
// each other before a decomposition run starts; it never sees the sub-issues a
// decomposition is about to create. AGT-2908's real incident was two different
// top-level parents each independently decomposing the same work into a
// `schema` / `persist` / `test` triad, five times over — every duplicate card
// shared an *identical* File scope block and differed only in a title prefix
// (`[Backend]` vs `[API Schema]` vs `[API Contract]`). File scope is therefore
// the load-bearing signal here, not title wording alone: two sub-tasks that
// touch the same files are duplicates far more reliably than two that merely
// share vocabulary (`fix(auth): ...` siblings routinely share words).

export interface DuplicateCandidate {
  title: string;
  fileScope: string[];
}

export interface ExistingSibling extends DuplicateCandidate {
  id: string;
  identifier: string;
}

export interface DuplicateMatch {
  sibling: ExistingSibling;
  titleScore: number;
  fileScopeScore: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'is', 'are', 'be', 'this', 'that', 'via',
]);

/** Strips a leading `[Bracket]`, `fix(scope):`, or `word:` prefix before tokenizing. */
const PREFIX_PATTERN = /^\s*(\[[^\]]+\]|[a-z][\w-]*\([\w./-]+\):|[a-z]+:)\s*/i;

export function normalizeTitleTokens(title: string): Set<string> {
  const stripped = title.replace(PREFIX_PATTERN, '');
  const tokens = stripped
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(normalizeTitleTokens(a), normalizeTitleTokens(b));
}

function normalizeFileScope(paths: readonly string[]): Set<string> {
  return new Set(paths.map((p) => p.trim().toLowerCase()).filter(Boolean));
}

function fileScopeIntersectionCount(a: readonly string[], b: readonly string[]): number {
  const setB = normalizeFileScope(b);
  let count = 0;
  for (const item of normalizeFileScope(a)) if (setB.has(item)) count += 1;
  return count;
}

export function fileScopeOverlap(a: readonly string[], b: readonly string[]): number {
  return jaccard(normalizeFileScope(a), normalizeFileScope(b));
}

/**
 * Best-matching existing sibling this candidate duplicates, or null.
 *
 * A candidate with no file scope at all is never flagged — there is nothing
 * to anchor the comparison, and title similarity alone is too easy to
 * false-positive on. Two gates, either of which is enough on its own:
 *
 *  1. At least 2 shared files — a strong, hard-to-hit-by-accident signal on
 *     its own, regardless of how differently the two titles are phrased
 *     (this is exactly the AGT-2908 shape: identical multi-file scope).
 *  2. Exactly 1 shared file that is the *entirety* of both candidates' scope,
 *     plus a real title-token overlap — catches single-file sub-tasks about
 *     the same file with similar intent, without flagging two unrelated
 *     single-file tasks that happen to share one trivial file (e.g. both
 *     touching `package.json`).
 */
export function findDuplicateSibling(
  candidate: DuplicateCandidate,
  existing: readonly ExistingSibling[],
  minTitleSimilarity = 0.2,
): DuplicateMatch | null {
  if (candidate.fileScope.length === 0) return null;
  let best: DuplicateMatch | null = null;
  for (const sibling of existing) {
    if (sibling.fileScope.length === 0) continue;
    const shared = fileScopeIntersectionCount(candidate.fileScope, sibling.fileScope);
    if (shared === 0) continue;
    const fileScopeScore = fileScopeOverlap(candidate.fileScope, sibling.fileScope);
    const titleScore = titleSimilarity(candidate.title, sibling.title);
    const isDuplicate = shared >= 2
      || (shared === 1 && fileScopeScore === 1 && titleScore >= minTitleSimilarity);
    if (!isDuplicate) continue;
    if (!best || fileScopeScore + titleScore > best.fileScopeScore + best.titleScore) {
      best = { sibling, titleScore, fileScopeScore };
    }
  }
  return best;
}
