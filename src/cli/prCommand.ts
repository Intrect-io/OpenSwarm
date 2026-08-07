// ============================================
// OpenSwarm - `openswarm pr status|fix|watch|create` (INT-3282)
// On-demand PR autopilot surface over PRProcessor + commitAndCreatePR.
// ============================================

import { resolve } from 'node:path';
import { PRProcessor, type PRProcessorConfig } from '../automation/prProcessor.js';
import { loadConfig } from '../core/config.js';
import type { DefaultRolesConfig, ConflictResolverConfig } from '../core/types.js';
import { parsePRRef, resolvePR, resolveOriginRepo, toPRInfo, type ResolvePROptions } from './prResolve.js';
import { formatPrStatus, gatherPrStatus, type PrStatusSnapshot } from './prStatus.js';
import { createPrFromCwd, type PrCreateOptions } from './prCreate.js';
import { getOpenPRsOrThrow } from '../github/github.js';

export type PrAction = 'status' | 'fix' | 'review' | 'watch' | 'create';

export interface PrCommandOptions {
  path?: string;
  /** PR number, or owner/repo#n / #n string */
  number?: number | string;
  repo?: string;
  /** watch: max fix passes (default 5) */
  rounds?: number;
  /** fix/watch: pipeline iterations per attempt */
  maxIterations?: number;
  /** fix/watch: CI-retry attempts */
  maxRetries?: number;
  /** create: PR title */
  title?: string;
  /** create: issue id for conventional commit / Closes */
  issue?: string;
  /** create: PR body */
  body?: string;
  /** create: skip local openswarm fix (default: run fix) */
  noFix?: boolean;
  /** create: open as draft */
  draft?: boolean;
  /** fix/watch: disable conflict auto-resolve */
  noConflicts?: boolean;
  /** status/watch: emit JSON */
  json?: boolean;
  /** review: run a brand-new code review of the PR diff instead of addressing existing feedback */
  fresh?: boolean;
  /** review: review every open PR in the repo instead of a single one (current branch's PR or --number) */
  all?: boolean;
}

export interface PrCommandDeps {
  resolve?: (opts: ResolvePROptions) => ReturnType<typeof resolvePR>;
  gatherStatus?: typeof gatherPrStatus;
  fixOne?: (
    pr: { repo: string; number: number; title: string; branch: string; url: string },
    projectPath: string,
    opts: PrCommandOptions,
  ) => Promise<{ success: boolean; error?: string; iterations: number }>;
  reviewOne?: (
    pr: { repo: string; number: number; title: string; branch: string; url: string },
    projectPath: string,
    opts: PrCommandOptions,
  ) => Promise<{ success: boolean; error?: string; iterations: number }>;
  freshReviewOne?: (
    pr: { repo: string; number: number; title: string; branch: string; url: string },
    projectPath: string,
    opts: PrCommandOptions,
  ) => Promise<{ success: boolean; error?: string; iterations: number }>;
  waitCI?: (
    repo: string,
    prNumber: number,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ) => Promise<{ status: string }>;
  create?: (opts: PrCreateOptions) => Promise<{ url: string; message: string }>;
  /** review --all: repo → every open PR. */
  listOpenPRs?: (repo: string) => Promise<Array<{ repo: string; number: number; title: string; branch: string; url: string; isFork?: boolean }>>;
  /** review --all: repo override → cwd's own repo. */
  resolveRepo?: (cwd: string, explicitRepo?: string) => Promise<string>;
  log?: (line: string) => void;
  loadRoles?: () => DefaultRolesConfig | undefined;
}

export function resolveNumber(opts: PrCommandOptions): number | undefined {
  if (opts.number == null) return undefined;
  if (typeof opts.number === 'number') return opts.number;
  return parsePRRef(String(opts.number)).number;
}

export function resolveRepoOverride(opts: PrCommandOptions): string | undefined {
  if (opts.repo) return opts.repo;
  if (typeof opts.number === 'string' && opts.number.includes('#')) {
    return parsePRRef(opts.number).repo;
  }
  return undefined;
}

export function loadRolesBestEffort(): DefaultRolesConfig | undefined {
  try {
    return loadConfig().autonomous?.defaultRoles;
  } catch {
    return undefined;
  }
}

export function buildProcessorConfig(opts: PrCommandOptions, roles?: DefaultRolesConfig): PRProcessorConfig {
  const conflictResolver: ConflictResolverConfig | undefined = opts.noConflicts
    ? undefined
    : {
        enabled: true,
        // CLI targets a PR the operator explicitly chose — allow any ownership.
        ownershipMode: 'all',
        maxResolutionAttempts: 3,
        cascadeCheck: false,
      };

  return {
    repos: [],
    schedule: '0 0 1 1 *', // unused for one-shot
    cooldownHours: 0,
    maxIterations: opts.maxIterations ?? 3,
    maxRetries: opts.maxRetries ?? 3,
    roles,
    conflictResolver,
  };
}

async function defaultFixOne(
  pr: { repo: string; number: number; title: string; branch: string; url: string },
  projectPath: string,
  opts: PrCommandOptions,
  loadRoles: () => DefaultRolesConfig | undefined,
): Promise<{ success: boolean; error?: string; iterations: number }> {
  const roles = loadRoles();
  const processor = new PRProcessor(buildProcessorConfig(opts, roles));
  return processor.fixOne(toPRInfo({ ...pr, author: undefined }), projectPath);
}

async function defaultReviewOne(
  pr: { repo: string; number: number; title: string; branch: string; url: string },
  projectPath: string,
  opts: PrCommandOptions,
  loadRoles: () => DefaultRolesConfig | undefined,
): Promise<{ success: boolean; error?: string; iterations: number }> {
  const roles = loadRoles();
  // review-only: conflictResolver is built but unused — processReviewFeedback
  // never touches conflicts — maxIterations/maxRetries still apply to the
  // pipeline run it fires for each round of feedback.
  const processor = new PRProcessor(buildProcessorConfig(opts, roles));
  return processor.reviewOne(toPRInfo({ ...pr, author: undefined }), projectPath);
}

async function defaultFreshReviewOne(
  pr: { repo: string; number: number; title: string; branch: string; url: string },
  projectPath: string,
  opts: PrCommandOptions,
  loadRoles: () => DefaultRolesConfig | undefined,
): Promise<{ success: boolean; error?: string; iterations: number }> {
  const roles = loadRoles();
  const processor = new PRProcessor(buildProcessorConfig(opts, roles));
  return processor.freshReview(toPRInfo({ ...pr, author: undefined }), projectPath);
}

/** Route a `pr` subcommand. Returns the message to print. Sets exit semantics via result.exitCode. */
export async function runPrCommand(
  action: string,
  opts: PrCommandOptions = {},
  deps: PrCommandDeps = {},
): Promise<{ message: string; exitCode: number; status?: PrStatusSnapshot }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const cwd = resolve(opts.path ?? process.cwd());
  const loadRoles = deps.loadRoles ?? loadRolesBestEffort;

  switch (action) {
    case 'status': {
      const resolved = await (deps.resolve ?? resolvePR)({
        path: cwd,
        number: resolveNumber(opts),
        repo: resolveRepoOverride(opts),
      });
      const status = await (deps.gatherStatus ?? gatherPrStatus)(resolved);
      if (opts.json) {
        return {
          message: JSON.stringify(status, null, 2),
          exitCode: status.mergeReady ? 0 : 1,
          status,
        };
      }
      return {
        message: formatPrStatus(status),
        exitCode: status.mergeReady ? 0 : 1,
        status,
      };
    }

    case 'fix': {
      const resolved = await (deps.resolve ?? resolvePR)({
        path: cwd,
        number: resolveNumber(opts),
        repo: resolveRepoOverride(opts),
      });
      log(`Fixing ${resolved.repo}#${resolved.number} (${resolved.title})…`);
      const fix =
        deps.fixOne ??
        ((pr, path, o) => defaultFixOne(pr, path, o, loadRoles));
      const result = await fix(resolved, cwd, opts);
      if (result.success) {
        return {
          message: `PR ${resolved.repo}#${resolved.number} fix completed (${result.iterations} iteration(s)).\n${resolved.url}`,
          exitCode: 0,
        };
      }
      return {
        message: `PR ${resolved.repo}#${resolved.number} fix failed: ${result.error ?? 'unknown'}\n${resolved.url}`,
        exitCode: 1,
      };
    }

    case 'review': {
      if (opts.all) {
        const resolveRepo = deps.resolveRepo ?? resolveOriginRepo;
        const repoOverride = resolveRepoOverride(opts);
        // Resolved from `cwd` alone (no explicit arg) so this is always the
        // repo this checkout's `origin` actually points at, never an
        // unvalidated echo of --repo — reviewOne/fixOne fetch `origin
        // <pr.branch>` straight out of `cwd`, so if --repo named a different
        // repository, that fetch would still read from the wrong remote
        // entirely (INT-3282 review finding).
        const cwdRepo = await resolveRepo(cwd);
        if (repoOverride && repoOverride !== cwdRepo) {
          throw new Error(
            `--repo ${repoOverride} does not match this checkout's own repo (${cwdRepo}) — ` +
            `'pr review --all' reviews PRs by fetching into this checkout's local git state, ` +
            `so --repo must match the repo ${cwd} is actually cloned from.`
          );
        }
        const repo = repoOverride ?? cwdRepo;
        const prs = await (deps.listOpenPRs ?? getOpenPRsOrThrow)(repo);
        if (!prs.length) {
          return { message: `No open PRs in ${repo}.`, exitCode: 0 };
        }
        log(`Reviewing ${prs.length} open PR(s) in ${repo}…`);
        const review =
          deps.reviewOne ??
          ((pr, path, o) => defaultReviewOne(pr, path, o, loadRoles));
        const freshReview =
          deps.freshReviewOne ??
          ((pr, path, o) => defaultFreshReviewOne(pr, path, o, loadRoles));
        const run = opts.fresh ? freshReview : review;

        const lines: string[] = [];
        let failures = 0;
        let skipped = 0;
        // Sequential, not Promise.all: reviewOne/fixOne check out pr.branch
        // in projectPath itself (only freshReview's scratch worktree is
        // concurrency-safe), so overlapping PRs would fight over the same
        // working tree.
        for (const pr of prs) {
          // Non-fresh review re-application fetches `origin <pr.branch>`
          // directly, which does not exist under `origin` for a fork PR —
          // silently trying and counting it as a failure would misreport
          // "every open PR reviewed" when fork PRs were never reachable in
          // the first place. --fresh fetches `pull/<n>/head` instead, which
          // works for forks too.
          if (!opts.fresh && pr.isFork) {
            skipped++;
            lines.push(`⚠ #${pr.number} (${pr.title}): skipped — fork PR, not supported by feedback re-application (use --fresh)`);
            continue;
          }
          const result = await run(pr, cwd, opts);
          if (!result.success) failures++;
          const verdict = opts.fresh
            ? (result.success ? 'approved' : (result.error ?? 'changes requested'))
            : (result.success ? `feedback addressed (${result.iterations} iteration(s))` : (result.error ?? 'failed'));
          lines.push(`${result.success ? '✓' : '✗'} #${pr.number} (${pr.title}): ${verdict}`);
        }
        const reviewed = prs.length - skipped;
        lines.push('', `${reviewed - failures}/${reviewed} succeeded${skipped ? ` (${skipped} fork PR(s) skipped)` : ''}.`);
        return { message: lines.join('\n'), exitCode: failures > 0 ? 1 : 0 };
      }

      const resolved = await (deps.resolve ?? resolvePR)({
        path: cwd,
        number: resolveNumber(opts),
        repo: resolveRepoOverride(opts),
      });
      if (opts.fresh) {
        log(`Running a fresh code review of ${resolved.repo}#${resolved.number} (${resolved.title})…`);
        const freshReview =
          deps.freshReviewOne ??
          ((pr, path, o) => defaultFreshReviewOne(pr, path, o, loadRoles));
        const result = await freshReview(resolved, cwd, opts);
        if (result.success) {
          return {
            message: `PR ${resolved.repo}#${resolved.number} fresh review: approved.\n${resolved.url}`,
            exitCode: 0,
          };
        }
        return {
          message: `PR ${resolved.repo}#${resolved.number} fresh review: ${result.error ?? 'changes requested'}\n${resolved.url}`,
          exitCode: 1,
        };
      }
      log(`Checking review feedback on ${resolved.repo}#${resolved.number} (${resolved.title})…`);
      const review =
        deps.reviewOne ??
        ((pr, path, o) => defaultReviewOne(pr, path, o, loadRoles));
      const result = await review(resolved, cwd, opts);
      if (result.success) {
        return {
          message: `PR ${resolved.repo}#${resolved.number} review feedback addressed (${result.iterations} iteration(s)).\n${resolved.url}`,
          exitCode: 0,
        };
      }
      return {
        message: `PR ${resolved.repo}#${resolved.number} review feedback failed: ${result.error ?? 'unknown'}\n${resolved.url}`,
        exitCode: 1,
      };
    }

    case 'watch': {
      const maxRounds = Math.max(1, opts.rounds ?? 5);
      const resolved = await (deps.resolve ?? resolvePR)({
        path: cwd,
        number: resolveNumber(opts),
        repo: resolveRepoOverride(opts),
      });
      const gather = deps.gatherStatus ?? gatherPrStatus;
      const fix =
        deps.fixOne ??
        ((pr, path, o) => defaultFixOne(pr, path, o, loadRoles));
      const waitCI =
        deps.waitCI ??
        (async (repo, n, options) => {
          const { waitForCICompletion } = await import('../github/github.js');
          return waitForCICompletion(repo, n, options);
        });

      for (let round = 1; round <= maxRounds; round++) {
        log(`── watch round ${round}/${maxRounds} ──`);
        const status = await gather(resolved);
        log(formatPrStatus(status));

        if (status.mergeReady) {
          return {
            message: `Merge-ready: ${resolved.repo}#${resolved.number}\n${resolved.url}`,
            exitCode: 0,
            status,
          };
        }

        if (status.blocker === 'pending_ci') {
          log('CI still running — waiting…');
          await waitCI(resolved.repo, resolved.number, {
            timeoutMs: 600_000,
            pollIntervalMs: 30_000,
          });
          continue;
        }

        // conflicts / comments / ci → one fix pass
        const result = await fix(resolved, cwd, opts);
        if (!result.success) {
          return {
            message: `Blocked on round ${round}: ${result.error ?? 'fix failed'}\n${resolved.url}`,
            exitCode: 1,
            status,
          };
        }

        log('Fix pushed — waiting for CI…');
        await waitCI(resolved.repo, resolved.number, {
          timeoutMs: 600_000,
          pollIntervalMs: 30_000,
        });
      }

      const finalStatus = await gather(resolved);
      return {
        message: finalStatus.mergeReady
          ? `Merge-ready: ${resolved.repo}#${resolved.number}\n${resolved.url}`
          : `Gave up after ${maxRounds} round(s). Last blocker: ${finalStatus.blocker}\n${resolved.url}`,
        exitCode: finalStatus.mergeReady ? 0 : 1,
        status: finalStatus,
      };
    }

    case 'create': {
      const create = deps.create ?? createPrFromCwd;
      const result = await create({
        path: cwd,
        title: opts.title,
        issue: opts.issue,
        body: opts.body,
        fix: !opts.noFix,
        draft: opts.draft,
      });
      return { message: result.message, exitCode: 0 };
    }

    default:
      throw new Error(
        `Unknown pr action "${action}" (use status|fix|review|watch|create)`,
      );
  }
}
