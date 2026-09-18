// ============================================
// OpenSwarm — one wall-clock budget, shared by the watchdog and the loop (AGT-4430)
// ============================================
//
// cgf-portal AX-1556, 2026-09-18: the pipeline was given a 5-iteration budget
// and a 60-minute scheduler watchdog. Four iterations cost 3,539 s, so the
// watchdog fired mid-iteration-4 and the run ended `Pipeline cancelled` /
// `PR not created`, stranding 1,320 lines of finished work on a branch. The
// two numbers were set independently and could not both be true.
//
// They now come from one place. The watchdog is derived from the budget it
// guards and clamped, so a single task cannot hold a slot forever; the loop
// reads the same number and stops itself before the watchdog can fire, which
// turns "killed with no PR" into an operator park that publishes a draft.

/**
 * Time kept in reserve after the last worker iteration for the work that
 * follows it: guards, tester, publication, the fresh review.
 */
export const TASK_BUDGET_WRAPUP_RESERVE_MS = 8 * 60_000;

/** Fixed slice for draft analysis, worktree setup and the final sync. */
export const TASK_BUDGET_SETUP_OVERHEAD_MS = 4 * 60_000;

/**
 * The most wall clock one task may hold its slot for. The iteration budget can
 * ask for more than this (5 x 26 min = 130 min); it is clamped, and the loop
 * then parks with the reason instead of pretending the extra attempts exist.
 */
export const TASK_BUDGET_CEILING_MS = 90 * 60_000;

/** Park code for a run that stopped because its wall-clock budget is spent. */
export const ITERATION_BUDGET_PARK_REASON = 'iteration_budget_spent';

export interface HardTaskTimeoutInput {
  /** Explicit operations/test override. Honoured as given. */
  configuredMs?: number;
  maxIterations: number;
  /** Resolved worker stage ceiling (stageTimeoutMs('worker', …)). */
  workerTimeoutMs: number;
  /** Resolved ceilings of the other enabled stages, per iteration. */
  otherStagesTimeoutMs?: number;
}

/**
 * The wall-clock budget for one task: what its iteration budget needs, capped.
 * An explicit `configuredMs` wins — operations and tests set it deliberately.
 */
export function resolveHardTaskTimeoutMs(input: HardTaskTimeoutInput): number {
  if (typeof input.configuredMs === 'number' && input.configuredMs > 0) return input.configuredMs;
  const perIteration = Math.max(0, input.workerTimeoutMs) + Math.max(0, input.otherStagesTimeoutMs ?? 0);
  const needed = Math.max(1, input.maxIterations) * perIteration
    + TASK_BUDGET_SETUP_OVERHEAD_MS
    + TASK_BUDGET_WRAPUP_RESERVE_MS;
  return Math.min(needed, TASK_BUDGET_CEILING_MS);
}

export interface IterationBudgetInput {
  elapsedMs: number;
  /** The same number the watchdog uses (resolveHardTaskTimeoutMs). */
  budgetMs: number;
  iterationsUsed: number;
  maxIterations: number;
  /** Longest iteration observed in this run; 0 before one completes. */
  longestIterationMs: number;
  /** What an unobserved iteration may cost at most. */
  workerTimeoutMs: number;
}

export interface IterationBudgetVerdict {
  start: boolean;
  /** Present when `start` is false: what stopped it, in numbers. */
  reason?: string;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}min`;
}

/**
 * Whether another iteration may start. The first one always may — a task has
 * to get one attempt. After that, an iteration is only started when the
 * longest one observed so far still fits in what is left of the budget.
 */
export function canStartAnotherIteration(input: IterationBudgetInput): IterationBudgetVerdict {
  if (input.iterationsUsed <= 0) return { start: true };
  if (input.iterationsUsed >= input.maxIterations) {
    return { start: false, reason: `iteration budget spent: ${input.iterationsUsed}/${input.maxIterations} used` };
  }
  if (!(input.budgetMs > 0)) return { start: true };
  const expected = input.longestIterationMs > 0 ? input.longestIterationMs : Math.max(0, input.workerTimeoutMs);
  const remaining = input.budgetMs - input.elapsedMs - TASK_BUDGET_WRAPUP_RESERVE_MS;
  if (remaining >= expected) return { start: true };
  return {
    start: false,
    reason: `wall-clock budget spent: ${minutes(input.elapsedMs)} of ${minutes(input.budgetMs)} used after `
      + `${input.iterationsUsed}/${input.maxIterations} iterations, and the next one needs about `
      + `${minutes(expected)} with ${minutes(Math.max(0, remaining))} left after the wrap-up reserve`,
  };
}
