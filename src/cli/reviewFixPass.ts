// ============================================
// OpenSwarm - `openswarm review --max --fix` fix → verify loop (INT-2249 / INT-2443)
// ============================================
//
// Split out of reviewAudit.ts, which had grown to hold two separate jobs: the
// read-only codebase audit (partition → fan out → aggregate → report) and this,
// the pass that acts on the audit's findings. They share the AuditRun shape and
// nothing else. Pure move — behavior is unchanged.

import type { ReviewResult } from '../agents/agentPair.js';
import type { AdapterName } from '../adapters/types.js';
import { runPool } from '../support/concurrencyPool.js';
import {
  planFixUnits,
  workerContextForFixUnit,
  type FixRepositoryContext,
  type FixUnit,
} from './fixPlanning.js';
import { runIsolatedFixBatch } from './fixSandbox.js';
import type { SecurityFinding } from '../verify/securityAudit.js';
import {
  SECURITY_AUDIT_AREA,
  aggregateAuditResults,
  mergeSecurityAuditFindings,
  runMaxReview,
  type AuditAreaResult,
  type AuditProgress,
  type AuditRun,
  type RunMaxReviewDeps,
  type RunMaxReviewOptions,
} from './reviewAudit.js';

// ── Fix pass (--fix) ─────────────────────────────────────────────────────────

/** Outcome of applying a reviewer's findings to one area. */
export interface FixAreaResult {
  label: string;
  /** Every original audit area covered by this dependency-aware fix unit. */
  targetLabels: string[];
  /** true when the worker ran and reported success. */
  applied: boolean;
  filesChanged: string[];
  error?: string;
}

/** Live fix-pass progress — mirrors AuditProgress for the same board/logging. */
export type FixProgress =
  | { type: 'start'; label: string; done: number; total: number }
  | { type: 'log'; label: string; line: string }
  /** Batch-level note that belongs to no single area (e.g. baseline exclusions). */
  | { type: 'notice'; line: string }
  | { type: 'done'; label: string; filesChanged: number; done: number; total: number }
  | { type: 'error'; label: string; error: string; done: number; total: number };

export interface RunAreaFixesOptions {
  concurrency: number;
  adapter?: AdapterName;
  timeoutMs?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  repositoryContext?: FixRepositoryContext;
}

export interface RunAreaFixesDeps {
  /** Apply one dependency-aware fix unit. Default uses an isolated sandbox. */
  fix?: (unit: FixUnit, onLog: (line: string) => void) => Promise<{ success: boolean; filesChanged: string[]; error?: string }>;
  /** Injectable sandbox worker for integration tests; scope/promotion stay real. */
  worker?: (unit: FixUnit, sandbox: string, onLog: (line: string) => void) => Promise<{ success: boolean; error?: string }>;
  onProgress?: (e: FixProgress) => void;
}

/** Only areas the reviewer did not approve are worth a fix pass. */
export function fixTargets(run: AuditRun): AuditAreaResult[] {
  return run.results.filter(
    (r): r is AuditAreaResult & { review: ReviewResult } =>
      !!r.review && r.review.decision !== 'approve',
  );
}

/** Turn a dependency-aware fix unit into a repository-grounded worker task. */
export function buildFixTaskDescription(unit: FixUnit, context: FixRepositoryContext): string {
  const issues = unit.targets.flatMap((target) =>
    (target.review.issues ?? []).map((issue) => `- [${target.area.label}] ${issue}`));
  const actions = unit.targets.flatMap((target) =>
    (target.review.recommendedActions ?? []).map(
      (action) => `- [${action.type}] ${action.title}${action.location ? ` (${action.location})` : ''}`,
    ));
  return [
    `A code review of ${unit.targetLabels.join(', ')} found issues. Apply the MINIMAL root-cause edits needed to resolve them.`,
    '',
    'Primary review files:',
    ...unit.primaryFiles.map((file) => `- ${file}`),
    unit.dependencyFiles.length ? `\nKnown imports/callers in the dependency closure:\n${unit.dependencyFiles.map((file) => `- ${file}`).join('\n')}` : '',
    unit.testFiles.length ? `\nRelated tests:\n${unit.testFiles.map((file) => `- ${file}`).join('\n')}` : '',
    unit.manifestFiles.length ? `\nRelevant manifests/lockfiles:\n${unit.manifestFiles.map((file) => `- ${file}`).join('\n')}` : '',
    '',
    issues.length ? `Issues to fix:\n${issues.join('\n')}` : '',
    actions.length ? `\nRecommended actions:\n${actions.join('\n')}` : '',
    '',
    `Repository package manager: ${context.packageManager ?? 'not detected'}.`,
    context.verificationCommands.length
      ? `Required verification:\n${context.verificationCommands.map((command) => `- ${command}`).join('\n')}`
      : 'No deterministic verification command was discovered; report this limitation and do not invent one.',
    '',
    unit.dependencyGraphBacked
      ? 'The supporting scope above comes from the repository dependency graph. Inspect callers/contracts before editing.'
      : 'The dependency graph is unavailable or incomplete for these targets. This is one repository-wide serial fix unit; inspect real imports/callers before editing.',
    'Supporting edits to listed callers, shared contracts, tests, and manifests are allowed when required by the root cause. Do not change unrelated code.',
    'Do not replace a missing dependency with a stub, copied package, or locally invented API. Report an environment blocker instead.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Default fix applier: spawn a worker subagent that edits the area in place. */
async function defaultFixUnit(
  unit: FixUnit,
  context: FixRepositoryContext,
  cwd: string,
  opts: RunAreaFixesOptions,
  onLog: (line: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const { runWorker, resolveWorkerBashTimeout } = await import('../agents/worker.js');
  const result = await runWorker({
    taskTitle: `Apply review fixes: ${unit.label}`,
    taskDescription: buildFixTaskDescription(unit, context),
    projectPath: cwd,
    adapterName: opts.adapter,
    timeoutMs: opts.timeoutMs,
    reasoningEffort: opts.reasoningEffort,
    bashTimeoutMs: await resolveWorkerBashTimeout(cwd, opts.reasoningEffort),
    nudgeMaxOnNoEdit: 1,
    fileScope: unit.allowedPaths,
    workerContext: workerContextForFixUnit(unit, context),
    signal: opts.signal,
    onLog,
    suppressStatusLogs: true,
  });
  return { success: result.success, error: result.error ?? result.haltReason };
}

/**
 * Apply reviewer-recommended fixes as dependency-aware units. Independent units
 * run in isolated sandboxes and only disjoint, in-scope diffs are promoted into
 * the audit worktree. Never throws on a single unit: a failed fix lands as an
 * error in its result. (INT-2249 / INT-2920)
 */
export async function runAreaFixes(
  run: AuditRun,
  cwd: string,
  opts: RunAreaFixesOptions,
  deps: RunAreaFixesDeps = {},
): Promise<FixAreaResult[]> {
  const targets = fixTargets(run);
  const context = opts.repositoryContext ?? {
    canonicalRoot: cwd, workspaces: [], manifests: [], verificationCommands: [], sharedPaths: [], repoMemories: [],
    dependencyGraphAvailable: false, dependencyMap: {}, preflight: { ready: true, issues: [] },
  } satisfies FixRepositoryContext;
  const units = planFixUnits(targets.map((target) => ({ area: target.area, review: target.review! })), context);
  const total = units.length;
  let done = 0;
  // Without a dependency graph we cannot prove that two areas are independent;
  // use a conservative serial fallback. Isolated sandboxes still protect scope.
  const concurrency = context.dependencyGraphAvailable ? opts.concurrency : 1;
  const onResult = (unit: FixUnit, result: { success: boolean; filesChanged: string[]; error?: string }) => {
    done++;
    if (result.success) deps.onProgress?.({ type: 'done', label: unit.label, filesChanged: result.filesChanged.length, done, total });
    else deps.onProgress?.({ type: 'error', label: unit.label, error: result.error ?? 'worker failed', done, total });
  };

  if (deps.fix) {
    const settled = await runPool(
      units,
      concurrency,
      async (unit) => {
        deps.onProgress?.({ type: 'start', label: unit.label, done, total });
        return deps.fix!(unit, (line) => deps.onProgress?.({ type: 'log', label: unit.label, line }));
      },
      (entry) => {
        const unit = units[entry.index];
        const value = entry.value ?? { success: false, filesChanged: [], error: entry.error ? String(entry.error) : 'no result' };
        onResult(unit, value);
      },
    );
    return settled.map((entry, index) => {
      const unit = units[index];
      const value = entry.value;
      return {
        label: unit.label, targetLabels: unit.targetLabels,
        applied: value?.success === true, filesChanged: value?.filesChanged ?? [],
        error: value?.error ?? (entry.error ? String(entry.error) : undefined),
      };
    });
  }

  const isolated = await runIsolatedFixBatch({
    projectPath: cwd,
    items: units,
    concurrency,
    signal: opts.signal,
    run: async (unit, sandbox, onLog) => {
      deps.onProgress?.({ type: 'start', label: unit.label, done, total });
      return deps.worker
        ? deps.worker(unit, sandbox, onLog)
        : defaultFixUnit(unit, context, sandbox, opts, onLog);
    },
    onLog: (unit, line) => deps.onProgress?.({ type: 'log', label: unit.label, line }),
    onNotice: (line) => deps.onProgress?.({ type: 'notice', line }),
  });
  return isolated.map((result) => {
    onResult(result.item, result);
    return {
      label: result.item.label,
      targetLabels: result.item.targetLabels,
      applied: result.success,
      filesChanged: result.filesChanged,
      error: result.error,
    };
  });
}

// ── Fix → verify loop (--fix-rounds) ─────────────────────────────────────────

/** What one fix → re-review round did. */
export interface FixVerifyRound {
  round: number;
  /** Areas flagged (non-approve) at the start of the round. */
  flagged: number;
  /** Areas the fix workers actually edited. */
  edited: number;
  filesChanged: string[];
  /** Previously flagged areas that the fresh whole-audit now approves. */
  resolved: number;
  /** Areas still flagged across the whole run after the re-review. */
  remaining: number;
}

/** Why the loop stopped. */
export type FixVerifyStop = 'all-approved' | 'max-rounds' | 'no-progress' | 'rate-limit' | 'time-budget' | 'dependency-preflight';
export type FixVerificationStatus = 'not-run' | 'passed' | 'failed' | 'unavailable' | 'infra';

export interface FixVerifyResult {
  rounds: FixVerifyRound[];
  /** The run carrying the latest per-area verdicts. */
  finalRun: AuditRun;
  /** True when no area is flagged at the end. */
  resolved: boolean;
  /** Automatic publication requires deterministic verification to pass. */
  verified: boolean;
  verificationStatus: FixVerificationStatus;
  verificationError?: string;
  stopReason: FixVerifyStop;
  /** Union of every file touched across all rounds. */
  filesChanged: string[];
}

export interface RunFixVerifyLoopOptions {
  concurrency: number;
  adapter?: AdapterName;
  /** Per-area reviewer turn ceiling for each fresh whole-audit pass. */
  reviewMaxTurns?: number;
  /** Per-area reviewer wall-clock budget for each fresh whole-audit pass. */
  reviewTimeoutMs?: number;
  /** Per-area fix-worker timeout (caller sets the long default). */
  fixTimeoutMs?: number;
  /** Optional hard cap on fix → re-review rounds. Unset means run until clean or blocked. */
  maxRounds?: number;
  /** Whole-loop wall-clock budget. Defaults to two hours. */
  maxDurationMs?: number;
  signal?: AbortSignal;
  repositoryContext?: FixRepositoryContext;
  /** Prior repository review logs forwarded to each full re-review. */
  priorReviewContextByArea?: Readonly<Record<string, string>>;
}

export interface RunFixVerifyLoopDeps {
  review?: RunMaxReviewDeps['review'];
  fix?: RunAreaFixesDeps['fix'];
  /** Test seam that preserves the production isolated-sandbox path. */
  fixWorker?: RunAreaFixesDeps['worker'];
  /** Start of each round: (round, flaggedCount). */
  onRoundStart?: (round: number, flagged: number) => void;
  /** Fix-phase progress. */
  onFixProgress?: (e: FixProgress) => void;
  /** Re-review-phase progress. */
  onReviewProgress?: (e: AuditProgress) => void;
  /** End of each round: its record. */
  onRoundEnd?: (r: FixVerifyRound) => void;
  /** Injectable clock for deterministic wall-clock budget tests. */
  now?: () => number;
  /** Deterministic repository verification captured before workers edit files. */
  verify?: () => Promise<{ success: boolean; output?: string; failedTests?: string[] } | null>;
  /** Fresh CodeQL evidence injected before fixing and after every re-review. */
  refreshSecurityAudit?: () => Promise<SecurityFinding[]>;
}

class FixLoopTimeBudgetError extends Error {
  constructor() {
    super('fix/review loop time budget exhausted');
    this.name = 'FixLoopTimeBudgetError';
  }
}

/** Reject promptly when the whole-loop budget expires; the same signal aborts in-flight agents. */
async function withinFixLoopBudget<T>(work: Promise<T>, budgetSignal: AbortSignal): Promise<T> {
  if (budgetSignal.aborted) throw new FixLoopTimeBudgetError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new FixLoopTimeBudgetError());
    budgetSignal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        budgetSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        budgetSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Overlay fresh re-review verdicts onto a base run: any area the re-review
 * actually re-verdicted takes the new result, the rest keep theirs. (mergeFallback
 * only fills *errored* base areas, so it can't downgrade an already-reviewed area
 * from reject→approve — this can.)
 *
 * Only areas with a real verdict (`r.review`) overlay. A fresh result that errored
 * (subagent crash / rate limit) carries no verdict — keep the prior findings, so a
 * failed re-review can't silently erase a still-unresolved area's issues and
 * follow-ups (which then vanish from the report and Linear filing). (INT-2443)
 */
export function mergeReReview(base: AuditRun, reReview: AuditRun): AuditRun {
  const fresh = new Map(reReview.results.filter((r) => r.review).map((r) => [r.area.label, r]));
  const results = base.results.map((r) => fresh.get(r.area.label) ?? r);
  // A re-review that gave up on the adapter carries that forward; the base's own
  // give-up only still stands if areas remain unreviewed. (AGT-3990)
  const infraAbort = reReview.infraAbort ?? (results.some((r) => r.error) ? base.infraAbort : undefined);
  return {
    summary: aggregateAuditResults(results),
    results,
    rateLimit: reReview.rateLimit ?? base.rateLimit,
    infraAbort,
  };
}

/**
 * Iterate fix → re-review until every area approves or an explicit round budget
 * runs out. Without a budget, continue until clean, no-progress, or rate-limit.
 * Each round applies the reviewer's fixes to the currently-flagged areas,
 * then re-reviews the whole audit surface so cross-area regressions are detected
 * immediately. Stops early
 * when a round edits nothing (workers can't progress) or a re-review hits a
 * usage limit, so it never spins. Edits accumulate in the working tree — no
 * commit — so the user reviews the diff before committing. (INT-2443)
 */
export async function runFixVerifyLoop(
  initial: AuditRun,
  cwd: string,
  opts: RunFixVerifyLoopOptions,
  deps: RunFixVerifyLoopDeps = {},
): Promise<FixVerifyResult> {
  const maxRounds = opts.maxRounds && opts.maxRounds > 0 ? opts.maxRounds : Number.POSITIVE_INFINITY;
  const maxDurationMs = opts.maxDurationMs && opts.maxDurationMs > 0 ? opts.maxDurationMs : 2 * 60 * 60 * 1000;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetSignal = AbortSignal.timeout(maxDurationMs);
  const phaseSignal = opts.signal ? AbortSignal.any([opts.signal, budgetSignal]) : budgetSignal;
  const reviewOpts: RunMaxReviewOptions = {
    concurrency: opts.concurrency,
    adapter: opts.adapter,
    maxTurns: opts.reviewMaxTurns,
    timeoutMs: opts.reviewTimeoutMs,
    signal: phaseSignal,
    priorReviewContextByArea: opts.priorReviewContextByArea,
  };
  const fixOpts: RunAreaFixesOptions = {
    concurrency: opts.concurrency,
    adapter: opts.adapter,
    timeoutMs: opts.fixTimeoutMs,
    reasoningEffort: 'high',
    signal: phaseSignal,
    repositoryContext: opts.repositoryContext,
  };
  const reviewDeps: RunMaxReviewDeps = { review: deps.review, onProgress: deps.onReviewProgress };
  const fixDeps: RunAreaFixesDeps = { fix: deps.fix, worker: deps.fixWorker, onProgress: deps.onFixProgress };
  const allAreas = initial.results.filter((result) => result.area.label !== SECURITY_AUDIT_AREA).map((result) => result.area);

  let run = initial;
  const rounds: FixVerifyRound[] = [];
  const allFiles = new Set<string>();
  let stopReason: FixVerifyStop = 'all-approved';
  const verificationState: { status: FixVerificationStatus; error?: string } = {
    status: deps.verify ? 'not-run' : 'unavailable',
  };
  // "Unresolved" = not approved, which includes errored areas (a re-review that
  // crashed is NOT resolved) — unlike fixTargets, which only counts non-approve
  // areas that still carry review findings worth another fix pass.
  const unresolved = (r: AuditRun): number => r.results.filter((x) => x.review?.decision !== 'approve').length;
  const findingSignature = (r: AuditRun): string => JSON.stringify(r.results.map((result) => ({
    label: result.area.label,
    decision: result.review?.decision ?? 'error',
    issues: result.review?.issues ?? [],
    actions: result.review?.recommendedActions ?? [],
  })));
  const applyVerificationGate = async (current: AuditRun, targetLabels: Set<string>): Promise<AuditRun> => {
    if (unresolved(current) !== 0) return current;
    if (!deps.verify) {
      verificationState.status = 'unavailable';
      return current;
    }
    let verification: { success: boolean; output?: string; failedTests?: string[] } | null;
    try {
      verification = await withinFixLoopBudget(deps.verify(), budgetSignal);
    } catch (error) {
      if (error instanceof FixLoopTimeBudgetError) throw error;
      verificationState.status = 'infra';
      verificationState.error = error instanceof Error ? error.message : String(error);
      return current;
    }
    if (!verification) {
      verificationState.status = 'unavailable';
      return current;
    }
    if (verification.success) {
      verificationState.status = 'passed';
      verificationState.error = undefined;
      return current;
    }
    verificationState.status = 'failed';

    const issue = [
      `Deterministic verification failed: ${(verification.failedTests ?? []).join(', ') || 'repository checks'}`,
      verification.output?.trim(),
    ].filter(Boolean).join('\n');
    const fallbackLabel = current.results[0]?.area.label;
    const labels = targetLabels.size > 0 ? targetLabels : new Set(fallbackLabel ? [fallbackLabel] : []);
    const results = current.results.map((result) => labels.has(result.area.label)
      ? {
          ...result,
          review: {
            decision: 'revise' as const,
            feedback: 'LLM review approved, but deterministic verification still fails.',
            issues: [issue],
            recommendedActions: [{ type: 'fix', title: 'Make deterministic repository checks pass', location: result.area.dir }],
          },
        }
      : result);
    return { ...current, results, summary: aggregateAuditResults(results) };
  };
  const refreshSecurityGate = async (current: AuditRun): Promise<AuditRun> => {
    if (!deps.refreshSecurityAudit) return current;
    return mergeSecurityAuditFindings(current, await withinFixLoopBudget(deps.refreshSecurityAudit(), budgetSignal));
  };

  if (opts.repositoryContext && !opts.repositoryContext.preflight.ready) {
    return {
      rounds,
      finalRun: run,
      resolved: false,
      verified: false,
      verificationStatus: verificationState.status,
      verificationError: opts.repositoryContext.preflight.issues.join('\n'),
      stopReason: 'dependency-preflight',
      filesChanged: [],
    };
  }

  try {
    run = await refreshSecurityGate(run);
  } catch (error) {
    if (error instanceof FixLoopTimeBudgetError) {
      return { rounds, finalRun: run, resolved: false, verified: false, verificationStatus: verificationState.status, stopReason: 'time-budget', filesChanged: [] };
    }
    throw error;
  }

  for (let round = 1; round <= maxRounds; round++) {
    let targets = fixTargets(run);
    if (!targets.length) {
      try {
        run = await applyVerificationGate(run, new Set());
      } catch (error) {
        if (error instanceof FixLoopTimeBudgetError) {
          stopReason = 'time-budget';
          break;
        }
        throw error;
      }
      targets = fixTargets(run);
    }
    if (!targets.length) {
      // Nothing left to fix. Clean if every area approves; otherwise the leftover
      // is an errored/unfixable area, not a success.
      stopReason = unresolved(run) === 0 ? 'all-approved' : 'no-progress';
      break;
    }
    if (now() - startedAt >= maxDurationMs) {
      stopReason = 'time-budget';
      break;
    }
    deps.onRoundStart?.(round, targets.length);

    let fixes: FixAreaResult[];
    try {
      fixes = await withinFixLoopBudget(runAreaFixes(run, cwd, fixOpts, fixDeps), budgetSignal);
    } catch (error) {
      if (error instanceof FixLoopTimeBudgetError) {
        stopReason = 'time-budget';
        break;
      }
      throw error;
    }
    const edited = fixes.filter((f) => f.applied && f.filesChanged.length);
    for (const f of edited) for (const p of f.filesChanged) allFiles.add(p);

    if (!edited.length) {
      // A no-edit worker report is not proof that the finding is unfixable. The
      // finding may already have been resolved by another area's overlapping
      // change, or a fresh reviewer may provide a more actionable diagnosis.
      // Re-review the whole surface once before declaring no progress.
      const before = findingSignature(run);
      let reReview: AuditRun;
      try {
        reReview = await withinFixLoopBudget(runMaxReview(allAreas, cwd, reviewOpts, reviewDeps), budgetSignal);
      } catch (error) {
        if (error instanceof FixLoopTimeBudgetError) {
          stopReason = 'time-budget';
          break;
        }
        throw error;
      }
      run = mergeReReview(run, reReview);
      try {
        run = await refreshSecurityGate(run);
      } catch (error) {
        if (error instanceof FixLoopTimeBudgetError) {
          stopReason = 'time-budget';
          break;
        }
        throw error;
      }
      try {
        run = await applyVerificationGate(run, new Set(targets.map((target) => target.area.label)));
      } catch (error) {
        if (error instanceof FixLoopTimeBudgetError) {
          stopReason = 'time-budget';
          break;
        }
        throw error;
      }
      const remaining = unresolved(run);
      const gatedByLabel = new Map(run.results.map((result) => [result.area.label, result]));
      const rec: FixVerifyRound = {
        round,
        flagged: targets.length,
        edited: 0,
        filesChanged: [],
        resolved: targets.filter((target) => gatedByLabel.get(target.area.label)?.review?.decision === 'approve').length,
        remaining,
      };
      rounds.push(rec);
      deps.onRoundEnd?.(rec);
      if (reReview.rateLimit) { stopReason = 'rate-limit'; break; }
      if (!remaining) { stopReason = 'all-approved'; break; }
      if (findingSignature(run) === before) { stopReason = 'no-progress'; break; }
      if (round === maxRounds) { stopReason = 'max-rounds'; break; }
      continue;
    }

    // Re-review the entire surface. Fixes are scoped by directory but can still
    // affect callers and shared contracts elsewhere, so a targeted review cannot
    // prove that the repository is fully clean.
    let reReview: AuditRun;
    try {
      reReview = await withinFixLoopBudget(runMaxReview(allAreas, cwd, reviewOpts, reviewDeps), budgetSignal);
    } catch (error) {
      if (error instanceof FixLoopTimeBudgetError) {
        stopReason = 'time-budget';
        break;
      }
      throw error;
    }
    run = mergeReReview(run, reReview);
    try {
      run = await refreshSecurityGate(run);
    } catch (error) {
      if (error instanceof FixLoopTimeBudgetError) {
        stopReason = 'time-budget';
        break;
      }
      throw error;
    }
    try {
      run = await applyVerificationGate(run, new Set(edited.flatMap((fix) => fix.targetLabels)));
    } catch (error) {
      if (error instanceof FixLoopTimeBudgetError) {
        stopReason = 'time-budget';
        break;
      }
      throw error;
    }

    const remaining = unresolved(run);
    const gatedByLabel = new Map(run.results.map((result) => [result.area.label, result]));

    const rec: FixVerifyRound = {
      round,
      flagged: targets.length,
      edited: edited.length,
      filesChanged: edited.flatMap((f) => f.filesChanged),
      resolved: targets.filter((target) => gatedByLabel.get(target.area.label)?.review?.decision === 'approve').length,
      remaining,
    };
    rounds.push(rec);
    deps.onRoundEnd?.(rec);

    if (reReview.rateLimit) { stopReason = 'rate-limit'; break; }
    if (!remaining) { stopReason = 'all-approved'; break; }
    if (round === maxRounds) { stopReason = 'max-rounds'; break; }
  }

  return {
    rounds,
    finalRun: run,
    resolved: unresolved(run) === 0,
    verified: verificationState.status === 'passed',
    verificationStatus: verificationState.status,
    verificationError: verificationState.error,
    stopReason,
    filesChanged: [...allFiles],
  };
}
