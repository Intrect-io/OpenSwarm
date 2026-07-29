// ============================================
// OpenSwarm - `openswarm review --max` entry (INT-2006)
// ============================================
//
// CLI shell for the full-codebase, multi-agent audit: collect source → partition
// into areas → cost gate → mount the live ink board → fan reviewer subagents out
// (runMaxReview) → print the aggregate verdict → optionally file per-area Linear
// follow-ups. The orchestration/aggregation lives in reviewAudit.ts (unit-tested
// and ink-free); this file is the effectful boundary.
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  listSourceFiles,
  balanceAreasToConcurrency,
  runMaxReview,
  runFixVerifyLoop,
  fixTargets,
  aggregateAuditResults,
  formatAuditSummary,
  formatAuditReport,
  mergeFallback,
  type AuditArea,
  type FixVerifyRound,
  type FixVerifyResult,
  type FixVerifyStop,
  type FixVerificationStatus,
  type AuditRun,
  type AuditSummary,
} from './reviewAudit.js';
import {
  captureReviewFileHashes,
  dedupeReviewActions,
  loadReviewHistory,
  renderReviewHistoryContext,
  saveReviewHistory,
  type LoadedReviewHistory,
} from './reviewHistory.js';
import { AuditBoard } from '../tui/components/AuditBoard.js';
import { resolveIssueFromBranch, ensureTaskSource, ensureProjectMapping } from './reviewCommand.js';
import { synthesizeAuditIssues } from './auditPM.js';
import { c, status } from '../support/colors.js';
import type { AdapterName } from '../adapters/types.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import { loadConfig } from '../core/config.js';
import type { VerifyConfig } from '../core/types.js';
import { loadTrustedVerifyPlan, runDeterministicTester } from '../agents/deterministicTester.js';
import { buildFixRepositoryContext } from './fixPlanning.js';
import { collectFixRuntimePreflightIssues } from './fixPreflight.js';

/**
 * Best-effort verify config: `review --max` must still run in a repo with no —
 * or an invalid — OpenSwarm config, so fall back to the built-in defaults
 * instead of letting config discovery abort the audit. (INT-2762)
 */
export function loadVerifyConfigBestEffort(): VerifyConfig {
  const defaults: VerifyConfig = { enabled: true, blockOnNewFailures: true, maxCommands: 4 };
  try {
    return loadConfig().autonomous?.verify ?? defaults;
  } catch (err) {
    // Warn so a configured verify policy never vanishes silently (reviewer gate).
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(status.warn(`[Config] Verify policy using built-in defaults — ${reason}`));
    return defaults;
  }
}

export interface ReviewMaxOptions {
  /** Project path (default cwd). */
  path?: string;
  /** Max reviewer subagents in flight (default 4). */
  concurrency?: number;
  /** Files per area before chunking (default 12). */
  maxFilesPerArea?: number;
  /** Adapter override for the reviewers. */
  adapter?: string;
  /** PM-synthesize follow-ups into ≤10 cohesive Linear sub-issues (parent id or branch-inferred). */
  fileIssue?: string | boolean;
  /** Legacy: file one follow-up batch per audit area (the old --issues behavior). (INT-2225) */
  issuesPerArea?: string | boolean;
  /** Skip the interactive cost gate (CI / scripted). */
  yes?: boolean;
  /** Partition only, print the plan, and exit (no subagents spawned). */
  dryRun?: boolean;
  /** Report file path (default: <cwd>/.openswarm/audit/audit-<ts>.md). (INT-2022) */
  out?: string;
  /** Skip creating the default Linear master audit issue. (INT-2022) */
  noLinear?: boolean;
  /** Adapter to retry usage-limited areas on (default claude for codex primary). (INT-2192) */
  fallbackAdapter?: string;
  /** Disable the automatic usage-limit fallback. (INT-2192) */
  noFallback?: boolean;
  /** Apply the reviewer's fixes to each non-approve area. (INT-2249) */
  fix?: boolean;
  /** For --fix: edit the current working tree instead of an isolated audit worktree. (INT-2905) */
  inPlace?: boolean;
  /** For --fix: optional fix → re-review round cap. Unset means continue until clean or blocked. */
  fixRounds?: number;
  /** Record the audit findings into repo knowledge (default true; --no-learn opts out). (INT-2268) */
  learn?: boolean;
}

export interface ReviewMaxCommandResult {
  decision: string;
  /**
   * True when at least one area produced a real reviewer verdict. False means
   * the gate did not run at all (quota exhausted, adapter down) — the caller
   * must exit gate-not-run, never pass. (INT-3100)
   */
  gateRan: boolean;
  /** For --fix, true only when every area has a fresh approve verdict. */
  resolved?: boolean;
  /** For --fix, true only when trusted deterministic verification passed. */
  verified?: boolean;
}

/** `--fix` must fail closed on revise/error, not only on an aggregate reject. */
export function reviewMaxResultFailed(result: ReviewMaxCommandResult | null, fix: boolean): boolean {
  if (!result) return false;
  return result.decision === 'reject' || (fix && (result.resolved !== true || result.verified !== true));
}

/**
 * Pick the adapter to retry usage-limited areas on. Explicit --fallback wins;
 * otherwise a codex primary auto-falls back to claude (Claude subscription). (INT-2192)
 */
function resolveFallbackAdapter(opts: ReviewMaxOptions): AdapterName | undefined {
  if (opts.noFallback) return undefined;
  if (opts.fallbackAdapter) return opts.fallbackAdapter as AdapterName;
  const primary = opts.adapter ?? 'codex-responses';
  return primary === 'codex' || primary === 'codex-responses' ? 'claude' : undefined;
}

function positiveIntegerOption(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/** Apply repository review history to each area, then rebuild the aggregate. */
export function dedupeAuditRunHistory(
  run: AuditRun,
  loaded: LoadedReviewHistory,
  currentHashes: Record<string, string>,
): { run: AuditRun; removed: number } {
  let removed = 0;
  const results = run.results.map((result) => {
    if (!result.review) return result;
    const history = renderReviewHistoryContext(loaded, result.area.files, currentHashes);
    const deduped = dedupeReviewActions(result.review, history.matchingRecords, currentHashes);
    removed += deduped.removed;
    return { ...result, review: deduped.review };
  });
  return {
    run: { ...run, results, summary: aggregateAuditResults(results) },
    removed,
  };
}

/** Interactive cost gate. Non-TTY always proceeds (scripted runs). */
async function confirmCost(areas: number, files: number, concurrency: number): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) =>
    rl.question(
      `Audit ${files} file(s) across ${areas} area(s) with ${concurrency} concurrent reviewer subagents ` +
        `(~${areas} agent runs). Continue? [y/N] `,
      res,
    ),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Isolated audit worktree (INT-2905)
//
// `--fix` used to accumulate its edits in the caller's working tree, so an audit
// run mixed itself into whatever a daemon worker (or the user) was doing on that
// branch. It now forks the caller's HEAD into `<repo>/worktree/audit-<ts>` on a
// `swarm/audit-<ts>` branch, works there, and ships the result as a PR.

/** The Linear issue the audit PR points at. */
export interface AuditIssueParent {
  /** Internal issue id (or the `--issues <id>` value) — for commenting. */
  id?: string;
  /** Human identifier (INT-123) — for the PR body reference. */
  identifier?: string;
  /** True when this run created the issue, so its PR may close it. */
  created?: boolean;
}

export interface AuditWorktree {
  info: WorktreeInfo;
  /** Commit the worktree forked from — commits past it are the audit's own. */
  baseSha: string;
  /** Branch the audit forked from (empty when HEAD was detached) — the PR base. */
  forkedFromBranch: string;
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Fork the caller's HEAD into a dedicated audit worktree. Throws (with the
 *  `--in-place` escape hatch named) rather than silently editing their branch. */
export async function createAuditWorktree(cwd: string, ts: string): Promise<AuditWorktree> {
  const { createWorktree } = await import('../support/worktreeManager.js');
  try {
    const baseSha = gitOut(cwd, 'rev-parse', 'HEAD');
    const head = gitOut(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    const id = `audit-${ts}`;
    const info = await createWorktree(cwd, id, `swarm/${id}`, baseSha);
    return { info, baseSha, forkedFromBranch: head === 'HEAD' ? '' : head };
  } catch (e) {
    throw new Error(
      `Could not create the audit worktree: ${e instanceof Error ? e.message : String(e)}\n` +
        'Fix the repository state, or pass --in-place to fix the current working tree directly.',
    );
  }
}

/**
 * Ship the audit worktree only after review + deterministic verification pass:
 * commit the fixes, push the branch, open a PR, and
 * note the PR on the Linear audit issue. A run that changed nothing leaves no
 * branch behind — the worktree is removed. Never throws: the audit report and
 * the Linear issues are already persisted, so a git/gh failure must not turn a
 * completed audit into a crash (the worktree is kept for manual recovery).
 */
export async function shipAuditWorktree(
  audit: AuditWorktree,
  summary: AuditSummary,
  ts: string,
  linear: {
    issueId?: string;
    identifier?: string;
    closes: boolean;
    fixResult: Pick<FixVerifyResult, 'resolved' | 'verified' | 'verificationStatus'>;
  },
): Promise<string | null> {
  const { commitAndCreateAuditPR, removeWorktree, preserveWorktree } = await import('../support/worktreeManager.js');
  const gatePassed =
    linear.fixResult.resolved &&
    linear.fixResult.verified &&
    linear.fixResult.verificationStatus === 'passed';
  if (!gatePassed || summary.decision !== 'approve') {
    const reason =
      `audit publication blocked: verdict=${summary.decision}, resolved=${linear.fixResult.resolved}, ` +
      `verification=${linear.fixResult.verificationStatus}`;
    const preserved = await preserveWorktree(audit.info, reason);
    console.warn(
      status.warn(
        preserved
          ? `Audit PR blocked by fail-closed gate; candidate work preserved at ${audit.info.worktreePath}.`
          : 'Audit PR blocked by fail-closed gate; no candidate changes were present.',
      ),
    );
    return null;
  }
  const ref = linear.identifier ? `${linear.closes ? 'Closes' : 'Refs'} ${linear.identifier}` : '';
  const title = `fix(audit): codebase audit ${ts.slice(0, 10)} — review --max --fix`;
  const body = [
    '## Summary',
    `Automated fixes from \`openswarm review --max --fix\` (${summary.areas.length} area(s), ` +
      `${summary.recommendedActions.length} follow-up(s) recorded).`,
    '',
    'Every change here was produced by fix workers and re-reviewed by the audit loop — read the diff before merging.',
    ...(ref ? ['', '## Linear', ref] : []),
    '',
    '---',
    '🤖 Generated with [OpenSwarm](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  let url: string | null = null;
  try {
    url = await commitAndCreateAuditPR(audit.info, {
      title,
      body,
      commitMessage: `fix(audit): apply review --max findings (${ts.slice(0, 10)})`,
      forkedFromBranch: audit.forkedFromBranch,
      baseSha: audit.baseSha,
    });
  } catch (e) {
    console.warn(status.err(`Could not open the audit PR: ${e instanceof Error ? e.message : String(e)}`));
    console.warn(`  Fixes are committed on ${c.cyan(audit.info.branchName)} at ${audit.info.worktreePath}`);
    return null;
  }

  if (!url) {
    console.log(status.info('--fix changed nothing — discarding the audit worktree.'));
    await removeWorktree(audit.info).catch(() => {});
    return null;
  }

  console.log(`\n${status.ok('Audit PR')} ${c.cyan(url)}  ${c.dim(`(branch ${audit.info.branchName})`)}`);
  console.log(c.dim(`Worktree kept at ${audit.info.worktreePath} — remove it after the PR merges.`));
  if (linear.issueId) {
    try {
      const source = await ensureTaskSource();
      await source?.addComment(linear.issueId, `Audit fixes opened as a PR: ${url}\n\nBranch: \`${audit.info.branchName}\``);
    } catch (e) {
      console.warn(`Could not comment the PR link on Linear: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return url;
}

/** File each area's recommendedActions as Linear follow-ups, one call per area (avoids the 10-action cap). */
export async function filePerAreaFollowups(cwd: string, fileIssue: string | boolean, run: AuditRun): Promise<void> {
  const withActions = run.results.filter((r) => r.review?.recommendedActions?.length);
  if (!withActions.length) {
    console.log('No follow-ups to file.');
    return;
  }
  const source = await ensureTaskSource();
  if (!source) {
    console.log(
      'Could not file follow-ups: Linear not connected. Run `openswarm auth login --provider linear` (or set linearApiKey).',
    );
    return;
  }

  let parent = typeof fileIssue === 'string' ? fileIssue : undefined;
  if (!parent) {
    const branch = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        return '';
      }
    })();
    parent = resolveIssueFromBranch(branch);
    if (parent) console.log(`Filing follow-ups under ${parent} (inferred from branch "${branch}").`);
  }

  const mapping = await ensureProjectMapping(cwd, parent);
  if (mapping.abort) {
    console.log('Skipped filing follow-ups — map this repo to a Linear project first, then re-run.');
    return;
  }

  const { fileReviewerFollowups } = await import('../automation/runnerExecution.js');
  let filed = 0;
  for (const r of withActions) {
    filed += await fileReviewerFollowups(source, parent, r.review!, {
      autoFile: true,
      projectId: mapping.projectId,
      requireApprove: false,
    });
  }
  console.log(
    filed > 0
      ? parent
        ? `Filed ${filed} follow-up sub-issue(s) under ${parent}.`
        : `Filed ${filed} standalone follow-up issue(s) (pass \`--issues <id>\` to nest them).`
      : 'Could not file follow-ups (0 created).',
  );
}

/**
 * Run the full-codebase multi-agent audit. Returns the aggregate verdict (or
 * null when there's nothing to audit / the user declined). exit code is set to 1
 * by the caller on a reject verdict.
 */
export async function runReviewMaxCommand(opts: ReviewMaxOptions = {}): Promise<ReviewMaxCommandResult | null> {
  const cwd = opts.path ?? process.cwd();
  const concurrency = positiveIntegerOption(opts.concurrency, 4, '--concurrency');
  const maxFilesPerArea = positiveIntegerOption(opts.maxFilesPerArea, 12, '--max-files-per-area');

  let files: string[];
  try {
    files = listSourceFiles(cwd);
  } catch (cause) {
    // Not a "nothing to audit" no-op: in CI this is a wrong path or a missing
    // checkout step, and returning null would exit 0 — a silent pass. Throw so
    // the CLI reports gate-not-run (exit 2). (INT-3100)
    throw new Error(`Not a git repository (or git unavailable): ${cwd}`, { cause });
  }
  if (!files.length) {
    console.log('No production source files to audit.');
    return null;
  }
  // Split down to fill the reviewer pool: fewer areas than `concurrency` would
  // leave subagents idle, so the fastest audit maximizes parallel spread. (INT-2249)
  let areas: AuditArea[] = balanceAreasToConcurrency(files, concurrency, maxFilesPerArea);

  if (opts.dryRun) {
    console.log(`Audit plan — ${files.length} file(s) across ${areas.length} area(s):`);
    areas.forEach((a) => console.log(`  · ${a.label}  (${a.files.length} file(s))`));
    return null;
  }

  if (!opts.yes && !(await confirmCost(areas.length, files.length, concurrency))) {
    console.log('Aborted.');
    return null;
  }

  // Timestamp identifies this run everywhere: worktree/branch, report file, issue.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // `--fix` works in its own worktree forked from HEAD so the edits never land on
  // the branch a worker (or the user) is on. Reports, repo knowledge and Linear
  // mapping keep using the original repo path. (INT-2905)
  let audit: AuditWorktree | null = null;
  let workCwd = cwd;
  if (opts.fix && !opts.inPlace) {
    audit = await createAuditWorktree(cwd, ts);
    workCwd = audit.info.worktreePath;
    console.log(
      `${status.info('Audit worktree')} ${c.cyan(audit.info.branchName)} ${c.dim(`at ${workCwd}`)}\n` +
        c.dim('  Fixes are isolated here — the current working tree is left untouched.'),
    );
    // Cosmetic note only — never let a git hiccup here abort the audit.
    const uncommitted = (() => { try { return gitOut(cwd, 'status', '--porcelain'); } catch { return ''; } })();
    if (uncommitted) {
      console.log(c.dim(`  Note: ${uncommitted.split('\n').length} uncommitted change(s) in ${cwd} are NOT part of this audit.`));
    }
    // Re-partition from the worktree so the areas match the files actually there
    // (the caller's index may hold staged-but-uncommitted additions).
    files = listSourceFiles(workCwd);
    areas = balanceAreasToConcurrency(files, concurrency, maxFilesPerArea);
    if (!areas.length) {
      console.log('No production source files to audit at HEAD.');
      const { removeWorktree } = await import('../support/worktreeManager.js');
      await removeWorktree(audit.info).catch(() => {});
      return null;
    }
  }

  // Repeated audits should start with the repository's own review record. The
  // original checkout owns the history; an isolated --fix worktree supplies the
  // bytes being reviewed. History is advisory and best-effort, never a reason
  // to abort a current review.
  let loadedHistory: LoadedReviewHistory = { records: [], legacyExcerpts: [] };
  try {
    loadedHistory = await loadReviewHistory(cwd);
  } catch (error) {
    console.warn(status.warn(`Could not read prior review logs: ${error instanceof Error ? error.message : String(error)}`));
  }

  let currentReviewHashes: Record<string, string> = {};
  try {
    currentReviewHashes = await captureReviewFileHashes(workCwd, files);
  } catch (error) {
    console.warn(status.warn(`Could not fingerprint the current review scope: ${error instanceof Error ? error.message : String(error)}`));
  }

  const priorReviewContextByArea: Record<string, string> = {};
  for (const area of areas) {
    const rendered = renderReviewHistoryContext(loadedHistory, area.files, currentReviewHashes);
    if (rendered.context) priorReviewContextByArea[area.label] = rendered.context;
  }
  const areasWithHistory = Object.keys(priorReviewContextByArea).length;
  if (areasWithHistory > 0) {
    console.log(status.info(`Loaded prior review log context for ${areasWithHistory}/${areas.length} audit area(s).`));
  }

  const applyHistoryDedupe = async (candidate: AuditRun): Promise<AuditRun> => {
    try {
      currentReviewHashes = await captureReviewFileHashes(workCwd, candidate.results.flatMap((result) => result.area.files));
      const deduped = dedupeAuditRunHistory(candidate, loadedHistory, currentReviewHashes);
      if (deduped.removed > 0) {
        console.log(`Suppressed ${deduped.removed} duplicate follow-up(s) already recorded for unchanged code.`);
      }
      return deduped.run;
    } catch (error) {
      console.warn(status.warn(`Could not deduplicate review history: ${error instanceof Error ? error.message : String(error)}`));
      return candidate;
    }
  };

  // Capture deterministic commands and npm script contents before any fix worker
  // can edit them. LLM approval alone is not completion evidence: the fix must
  // also leave the repository's real checks without new failures.
  const verifyConfig = loadVerifyConfigBestEffort();
  const trustedVerifyPlan = opts.fix ? await loadTrustedVerifyPlan(workCwd, verifyConfig) : undefined;

  // Live board → stderr so the final report on stdout stays pipe-clean.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const board = render(<AuditBoard areas={areas} concurrency={concurrency} events={events} />, {
    stdout: process.stderr as unknown as NodeJS.WriteStream,
  });

  let run: AuditRun;
  let fixResolved: boolean | undefined;
  let fixVerified: boolean | undefined;
  let fixVerificationStatus: FixVerificationStatus | undefined;
  let fixResult: Pick<FixVerifyResult, 'resolved' | 'verified' | 'verificationStatus'> | undefined;
  try {
    run = await runMaxReview(
      areas,
      workCwd,
      {
        concurrency,
        adapter: opts.adapter as AdapterName | undefined,
        priorReviewContextByArea,
      },
      { onProgress: (e) => events.emit('progress', e) },
    );
  } finally {
    board.unmount();
  }

  // Auto-fallback: a codex usage-limit aborted the run early → retry the failed/
  // skipped areas on the fallback adapter (default claude → Claude subscription). (INT-2192)
  if (run.rateLimit) {
    const fallback = resolveFallbackAdapter(opts);
    if (fallback) {
      const pending = areas.filter((_, i) => run.results[i]?.error);
      console.warn(`\n${status.warn(`Codex usage limit hit — falling back to "${fallback}" for ${pending.length} remaining area(s)...`)}`);
      const fbRun = await runMaxReview(
        pending,
        workCwd,
        { concurrency, adapter: fallback, priorReviewContextByArea },
        {
          onProgress: (e) => {
            if (e.type === 'done') console.error(`  [${fallback}] ${e.label}: ${e.decision}`);
            else if (e.type === 'error') console.error(`  [${fallback}] ${e.label}: failed`);
          },
        },
      );
      run = mergeFallback(run, fbRun);
    }
  }

  run = await applyHistoryDedupe(run);

  console.log(formatAuditSummary(run.summary));

  // If a usage-limit is still unresolved (fallback also exhausted, or no fallback),
  // surface the reset time. (INT-2192)
  if (run.rateLimit) {
    const skipped = run.summary.areas.filter((a) => a.decision === 'error').length;
    const when = run.rateLimit.resetsAt ? new Date(run.rateLimit.resetsAt * 1000).toLocaleString() : 'an unknown time';
    console.warn(`\n${status.warn(`Usage limit unresolved — ${skipped} area(s) still incomplete. ${run.rateLimit.message}`)}`);
    console.warn(`  Retry after ${when}${resolveFallbackAdapter(opts) ? ' (fallback adapter also exhausted)' : ', or set `--fallback <adapter>`'}.`);
  }

  // (3.5) --fix: iterate fix → re-review until every flagged area approves or an
  //       explicitly requested --fix-rounds budget runs out. Each round fixes the
  //       currently-flagged areas, then re-reviews the full audit surface for a
  //       fresh verdict. Edits accumulate in the working tree — no commit —
  //       so the user reviews the diff first. (INT-2249 / INT-2443)
  if (opts.fix) {
    const targets = fixTargets(run);
    if (!targets.length) console.log('\n--fix: no reviewer edits requested; running the deterministic publication gate.');
    try {
      const maxRounds = opts.fixRounds === undefined
        ? undefined
        : positiveIntegerOption(opts.fixRounds, opts.fixRounds, '--fix-rounds');
      const roundBudget = maxRounds === undefined
        ? 'until every area approves'
        : `up to ${c.yellow(String(maxRounds))} round(s)`;
      console.log(
        `\n${status.running('Fix → verify loop')} ${roundBudget}, ` +
          `${c.yellow(String(targets.length))} area(s) flagged, ${concurrency} concurrent worker(s).`,
      );
      const repositoryContext = await buildFixRepositoryContext(
        workCwd,
        trustedVerifyPlan,
        [
          ...run.summary.issues,
          ...run.summary.recommendedActions.map((action) => `${action.title} ${action.location ?? ''}`),
        ].join('\n'),
      );
      if (targets.length > 0) {
        repositoryContext.preflight.issues.push(
          ...await collectFixRuntimePreflightIssues(workCwd, verifyConfig, trustedVerifyPlan),
        );
        repositoryContext.preflight.ready = repositoryContext.preflight.issues.length === 0;
      }
      const loop = await runFixVerifyLoop(
        run,
        workCwd,
        // 15 min per area: the adapter default (5 min) SIGKILLs fix workers on
        // issue-heavy areas mid-edit.
        {
          concurrency,
          adapter: opts.adapter as AdapterName | undefined,
          fixTimeoutMs: 900_000,
          maxRounds,
          maxDurationMs: 2 * 60 * 60 * 1000,
          repositoryContext,
          priorReviewContextByArea,
        },
        {
          verify: async () => {
              if (!trustedVerifyPlan || trustedVerifyPlan.commands.length === 0) return null;
                const result = await runDeterministicTester(
                  workCwd,
                  verifyConfig,
                  trustedVerifyPlan.commands,
                  trustedVerifyPlan.packageJsonByDirectory,
                );
                return result && {
                  success: result.success,
                  output: result.output,
                  failedTests: result.failedTests,
                };
              },
          onRoundStart: (round, flagged) =>
            console.log(`\n${c.bold(`Round ${round}${maxRounds === undefined ? '' : `/${maxRounds}`}`)} — fixing ${flagged} area(s)...`),
          onFixProgress: (e) => {
            if (e.type === 'done') console.log(`  ${status.ok(`${e.label} — ${e.filesChanged} file(s) changed`)}`);
            else if (e.type === 'error') console.log(`  ${status.err(`${e.label} — ${e.error}`)}`);
            else if (e.type === 'notice') console.log(`  ${c.dim(e.line)}`);
          },
          onReviewProgress: (e) => {
            if (e.type === 'done') console.log(`  ${status.info(`re-review ${e.label} — ${e.decision}`)}`);
            else if (e.type === 'error') console.log(`  ${status.err(`re-review ${e.label} — failed`)}`);
          },
          onRoundEnd: (r: FixVerifyRound) =>
            console.log(
              `  ${c.dim(`Round ${r.round}: ${r.edited} area(s) edited, ${r.resolved} resolved, ${r.remaining} still flagged.`)}`,
            ),
        },
      );
      // The loop's re-review carries the fresh verdicts — report/persist on those,
      // not the stale first-pass run.
      run = await applyHistoryDedupe(loop.finalRun);
      fixResolved = loop.resolved;
      fixVerified = loop.verified;
      fixVerificationStatus = loop.verificationStatus;
      fixResult = loop;
      const stopLabel: Record<FixVerifyStop, string> = {
        'all-approved': 'all findings cleared',
        'max-rounds': 'round budget spent',
        'no-progress': 'workers made no edits',
        'rate-limit': 'usage limit hit',
        'time-budget': 'two-hour safety budget spent',
        'dependency-preflight': 'repository dependencies unavailable',
      };
      // Count "not approved" (includes errored/rate-limited areas), matching
      // loop.resolved — fixTargets would undercount an errored area.
      const still = run.results.filter((r) => r.review?.decision !== 'approve').length;
      const headline = loop.resolved
        ? status.ok(`--fix: resolved every flagged area in ${loop.rounds.length} round(s)`)
        : status.warn(
            `--fix: ${still} area(s) still flagged after ${loop.rounds.length} round(s) (${stopLabel[loop.stopReason]})`,
          );
      console.log(`\n${headline} · ${c.yellow(`${loop.filesChanged.length} file(s) touched`)}`);
      if (!loop.verified) {
        console.log(status.warn(`Publication gate: deterministic verification ${loop.verificationStatus}${loop.verificationError ? ` — ${loop.verificationError}` : ''}.`));
      }
      console.log(
        c.dim(
          audit
            ? `Changes are in the audit worktree (${audit.info.branchName}) — publication follows only if every safety gate passes.`
            : 'Changes are in the working tree — review the diff before committing.',
        ),
      );
    } catch (error) {
      // Infrastructure failure in the fix phase (sandbox, git, adapter) must not
      // throw away a completed audit. Fall through with the pre-fix verdicts so
      // the report, review history and follow-ups below are still persisted;
      // fixResult stays undefined, which keeps the publication gate closed.
      console.warn(`\n${status.err(`--fix aborted: ${error instanceof Error ? error.message : String(error)}`)}`);
      console.warn(status.warn('Review findings kept — nothing was fixed or published.'));
    }
  }

  // (3.6) Persist a markdown report so the result isn't lost to the scrollback.
  //       Built here (after --fix) so it reflects the verified post-fix verdicts —
  //       and so the Linear master issue below embeds the same final state. (INT-2022 / INT-2443)
  const report = formatAuditReport(run.summary, basename(cwd) || cwd, ts);
  const outPath = opts.out ?? join(cwd, '.openswarm', 'audit', `audit-${ts}.md`);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, report, 'utf8');
    console.log(`\nReport saved: ${outPath}`);
  } catch (e) {
    console.warn(`Could not save report: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await saveReviewHistory(cwd, {
      kind: 'max',
      files,
      hashProjectPath: workCwd,
      areas: run.results.map((result) => ({
        label: result.area.label,
        files: result.area.files,
        review: result.review,
        error: result.error,
      })),
    });
  } catch (error) {
    console.warn(`Could not save review history: ${error instanceof Error ? error.message : String(error)}`);
  }

  // (4) Linear: PM synthesis is the DEFAULT — a master parent + ≤10 cohesive
  //     sub-issues. `--issues <id>` overrides the parent with an existing issue;
  //     `--issues-per-area` keeps the legacy per-area fan-out; `--no-linear`
  //     skips Linear entirely (report only). (INT-2022 / INT-2225)
  let parent: AuditIssueParent = {};
  // Post-verdict side-effect: a Linear/network failure here must not change the
  // exit code — the verdict exists, so this is a warning, not gate-not-run. (INT-3100)
  try {
    if (opts.issuesPerArea) {
      await filePerAreaFollowups(cwd, opts.issuesPerArea, run);
    } else if (!opts.noLinear && run.summary.recommendedActions.length) {
      parent = await filePmSynthesizedIssues(cwd, opts, run.summary, report, ts);
    } else if (run.summary.recommendedActions.length) {
      console.log(`\n${run.summary.recommendedActions.length} follow-up(s) — captured in the report (--no-linear).`);
    }
  } catch (error) {
    console.warn(`Could not file follow-ups (report saved to file): ${error instanceof Error ? error.message : String(error)}`);
  }

  // (4.5) Ship the isolated worktree: commit → push → PR, linked to the audit
  //       issue. Only the issue we created ourselves may be auto-closed by the
  //       PR — an explicit `--issues <id>` parent belongs to the user. (INT-2905)
  if (audit) {
    await shipAuditWorktree(audit, run.summary, ts, {
      issueId: parent.id,
      identifier: parent.identifier,
      closes: parent.created === true,
      fixResult: fixResult ?? { resolved: false, verified: false, verificationStatus: 'not-run' },
    });
  }

  // (5) Learn: record the audit's top findings as one repo constraint so the
  // next worker/reviewer knows this repo's known pitfalls. One memory (capped),
  // not one-per-finding. (INT-2268)
  if (opts.learn !== false && run.summary.recommendedActions.length) {
    try {
      const { recordAuditFindings } = await import('../memory/repoKnowledge.js');
      await recordAuditFindings(cwd, { decision: run.summary.decision, recommendedActions: run.summary.recommendedActions });
    } catch {
      // recordAuditFindings is already non-throwing.
    }
  }

  return {
    decision: run.summary.decision,
    gateRan: run.summary.completed > 0,
    resolved: opts.fix ? fixResolved ?? run.results.every((result) => result.review?.decision === 'approve') : undefined,
    verified: opts.fix ? fixVerified ?? fixVerificationStatus === 'passed' : undefined,
  };
}

/**
 * Create one master audit issue holding the full report (default Linear
 * behavior). Returns the created issue's internal id (usable as a sub-issue
 * parent) or null on failure. (INT-2022 / INT-2225)
 */
export async function createMasterAuditIssue(
  summary: AuditSummary,
  report: string,
  ts: string,
  projectId: string | undefined,
): Promise<{ id: string; identifier: string } | null> {
  const source = await ensureTaskSource();
  if (!source) {
    console.log(status.warn('Linear not connected — report saved to file only. `openswarm auth login --provider linear` to enable.'));
    return null;
  }
  const title = `chore(audit): codebase audit ${ts.slice(0, 10)} — review --max (${summary.recommendedActions.length} follow-ups)`;
  try {
    const res = await source.createTask(title, report, projectId);
    if ('identifier' in res) {
      console.log(`${status.ok('Linear master audit issue')} ${c.cyan(res.identifier)}`);
      return { id: res.id, identifier: res.identifier };
    }
    console.warn(`Could not create Linear issue (report saved to file): ${res.error}`);
    return null;
  } catch (e) {
    console.warn(`Could not create Linear issue (report saved to file): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * PM layer for `--issues`: synthesize the deduped follow-ups into ≤10 cohesive
 * issues and file them as sub-issues. The parent is the explicit `--issues <id>`
 * when given, otherwise a freshly created master audit issue (which also holds
 * the full report). Falls back gracefully — if synthesis yields nothing (too few
 * follow-ups, or the LLM output couldn't be parsed), the master issue alone still
 * captures everything. (INT-2225)
 */
export async function filePmSynthesizedIssues(
  cwd: string,
  opts: ReviewMaxOptions,
  summary: AuditSummary,
  report: string,
  ts: string,
): Promise<AuditIssueParent> {
  const actions = summary.recommendedActions;
  if (!actions.length) {
    console.log(status.info('No follow-ups to file.'));
    return {};
  }
  const source = await ensureTaskSource();
  if (!source) {
    console.log(
      status.warn('Could not file follow-ups: Linear not connected. Run `openswarm auth login --provider linear` (or set linearApiKey).'),
    );
    return {};
  }
  // Resolve the parent: explicit --issues <id>, else create the master report issue.
  const explicitParentId: string | undefined =
    typeof opts.fileIssue === 'string' && opts.fileIssue ? opts.fileIssue : undefined;

  // No <repo>/openswarm.json mapping and no explicit parent to inherit a project
  // from → map this repo now (interactive) or bail rather than file an orphan
  // (no project) issue. (INT-2239 / INT-2599)
  const mapping = await ensureProjectMapping(cwd, explicitParentId, { log: (l) => console.log(status.info(l)) });
  if (mapping.abort) {
    console.log(status.warn('Skipped filing follow-ups — map this repo to a Linear project first, then re-run.'));
    return {};
  }
  const projectId = mapping.projectId;

  // Track which issue the audit PR should reference, and whether we own it —
  // only an issue we created may be auto-closed by that PR. (INT-2905)
  const parent: AuditIssueParent = explicitParentId
    ? { id: explicitParentId, identifier: /^[A-Za-z]+-\d+$/.test(explicitParentId) ? explicitParentId : undefined, created: false }
    : {};
  if (!parent.id && !opts.noLinear) {
    const master = await createMasterAuditIssue(summary, report, ts, projectId);
    if (master) Object.assign(parent, { id: master.id, identifier: master.identifier, created: true });
  }
  const parentId = parent.id;

  console.log(`${status.running('PM synthesis')} ${c.yellow(`${actions.length} follow-up(s)`)} ${c.dim('into cohesive issues')}`);
  const issues = await synthesizeAuditIssues(actions, {
    adapter: opts.adapter,
    cwd,
    repoName: basename(cwd) || cwd,
    onLog: (l) => console.error(`  · ${l}`),
  });

  if (!issues.length) {
    console.log(
      status.warn(
        parentId
          ? 'PM synthesis produced no grouped issues — the master audit issue captures all follow-ups.'
          : 'PM synthesis produced no grouped issues — follow-ups are captured in the saved report.',
      ),
    );
    return parent;
  }

  let filed = 0;
  for (const issue of issues) {
    try {
      const res = parentId
        ? await source.createSubIssue(parentId, issue.title, issue.description, {
            priority: issue.priority,
            projectId,
          })
        : await source.createTask(issue.title, issue.description, projectId);
      if ('identifier' in res) {
        filed++;
        console.log(`  ${status.ok(`${res.identifier}  ${issue.title}  (${issue.items.length} follow-up(s))`)}`);
      } else {
        console.warn(`  ${status.err(`Could not create issue "${issue.title}": ${res.error}`)}`);
      }
    } catch (e) {
      console.warn(`  ${status.err(`Could not create issue "${issue.title}": ${e instanceof Error ? e.message : String(e)}`)}`);
    }
  }

  console.log(
    filed > 0
      ? parentId
        ? `Filed ${filed} synthesized sub-issue(s) under the master audit issue.`
        : `Filed ${filed} synthesized issue(s).`
      : 'Could not file synthesized issues (0 created).',
  );
  return parent;
}
