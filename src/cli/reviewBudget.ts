/**
 * Reviewer turn/time budgets, shared by `openswarm review` (one reviewer over
 * the diff) and `openswarm review --max` (one reviewer per audit area).
 *
 * `openswarm review` had no way to raise the reviewer's turn/time budget, so it
 * inherited the agentic loop's hardcoded defaults (20 turns, 5 min) regardless
 * of diff size — a 29-file/+2200-line diff hit the turn ceiling deterministically
 * on two separate runs, salvaged an empty or truncated verdict, and a third run
 * (raised nothing, same defaults) got cut by the 5-minute wall clock mid-analysis,
 * having already found the real defects. Small diffs are unaffected (thresholds
 * below the current defaults are no-ops); large ones now get proportionally more
 * room, and `--max-turns`/`--timeout` remain available to override either.
 * Unvalidated heuristic, not a measured optimum — widen the caps if it's still
 * not enough for some diff shape.
 *
 * Lives in its own module so `reviewAudit.ts` (the `--max` fan-out) can use the
 * same policy without importing the whole review command. `--max` used to
 * forward an undefined timeout, so every area fell back to the reviewer's flat
 * 300 s default: on a 2026-09-15 OpenRouter audit at concurrency 16, two of 17
 * areas died at exactly `openrouter timeout after 300000ms`. (AGT-4313)
 */
const REVIEW_BUDGET_FREE_FILES = 10;
const REVIEW_BUDGET_MAX_TURNS_CAP = 60;

const REVIEW_BUDGET_TIMEOUT_BASE_MS = 300_000; // 5 min
const REVIEW_BUDGET_TIMEOUT_PER_FILE_MS = 15_000;
const REVIEW_BUDGET_TIMEOUT_CAP_MS = 900_000; // 15 min

/**
 * OpenRouter reviewers run the agentic loop in-process against a remote API:
 * every tool round trip is a network call, cheap models are slow per token,
 * and at concurrency 16 the calls share one host's connection pool. The same
 * area that a CLI adapter reviews inside 5 minutes was measured at 18–20 API
 * calls and 114k–144k tokens on OpenRouter, so the flat 5-minute wall cut it
 * mid-analysis. A larger floor and cap for that adapter only; everything else
 * keeps the budget it had. (AGT-4313)
 */
const OPENROUTER_REVIEW_TIMEOUT_BASE_MS = 900_000; // 15 min
const OPENROUTER_REVIEW_TIMEOUT_PER_FILE_MS = 20_000;
const OPENROUTER_REVIEW_TIMEOUT_CAP_MS = 1_800_000; // 30 min

export function scaledReviewMaxTurns(changedFileCount: number, base = 20): number {
  if (changedFileCount <= REVIEW_BUDGET_FREE_FILES) return base;
  return Math.min(REVIEW_BUDGET_MAX_TURNS_CAP, base + Math.ceil((changedFileCount - REVIEW_BUDGET_FREE_FILES) / 2));
}

/**
 * Wall-clock budget for one reviewer over `changedFileCount` files.
 *
 * `adapter` is the RESOLVED review adapter name (flag, env or config), not the
 * raw `--adapter` flag — a configured OpenRouter default needs the OpenRouter
 * budget just as much as an explicit flag does. `base`, when given, overrides
 * the adapter's floor (the per-file slope and cap still follow the adapter).
 */
export function scaledReviewTimeoutMs(changedFileCount: number, base?: number, adapter?: string): number {
  const openrouter = (adapter ?? '').toLowerCase() === 'openrouter';
  const floor = base ?? (openrouter ? OPENROUTER_REVIEW_TIMEOUT_BASE_MS : REVIEW_BUDGET_TIMEOUT_BASE_MS);
  const perFile = openrouter ? OPENROUTER_REVIEW_TIMEOUT_PER_FILE_MS : REVIEW_BUDGET_TIMEOUT_PER_FILE_MS;
  const cap = openrouter ? OPENROUTER_REVIEW_TIMEOUT_CAP_MS : REVIEW_BUDGET_TIMEOUT_CAP_MS;
  if (changedFileCount <= REVIEW_BUDGET_FREE_FILES) return floor;
  return Math.max(floor, Math.min(cap, floor + (changedFileCount - REVIEW_BUDGET_FREE_FILES) * perFile));
}
