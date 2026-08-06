// ============================================
// OpenSwarm - `openswarm review` (INT-1955)
// ============================================
//
// Run the reviewer over the working-tree changes from the CLI, print the
// verdict, and (optionally) file its recommendedActions as Linear sub-issues
// under a parent issue — reusing fileReviewerFollowups (INT-1704/INT-1954).
// The formatter and synthetic-WorkerResult builder are pure (unit-tested); the
// command shell wires git + reviewer + Linear.

import type { ReviewResult, WorkerResult } from '../agents/agentPair.js';
import type { ITaskSource } from '../automation/taskSource.js';
import { startReviewProgress } from './reviewProgress.js';
import {
  captureReviewFileHashes,
  dedupeReviewActions,
  loadReviewHistory,
  renderReviewHistoryContext,
  saveReviewHistory,
  type ReviewHistoryRecord,
} from './reviewHistory.js';

/**
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
 */
const REVIEW_BUDGET_FREE_FILES = 10;
const REVIEW_BUDGET_MAX_TURNS_CAP = 60;
const REVIEW_BUDGET_TIMEOUT_CAP_MS = 900_000; // 15 min

export function scaledReviewMaxTurns(changedFileCount: number, base = 20): number {
  if (changedFileCount <= REVIEW_BUDGET_FREE_FILES) return base;
  return Math.min(REVIEW_BUDGET_MAX_TURNS_CAP, base + Math.ceil((changedFileCount - REVIEW_BUDGET_FREE_FILES) / 2));
}

export function scaledReviewTimeoutMs(changedFileCount: number, base = 300_000): number {
  if (changedFileCount <= REVIEW_BUDGET_FREE_FILES) return base;
  return Math.min(REVIEW_BUDGET_TIMEOUT_CAP_MS, base + (changedFileCount - REVIEW_BUDGET_FREE_FILES) * 15_000);
}

/** Synthesize a WorkerResult describing the working-tree changes for the reviewer. */
/**
 * The diff the reviewer will read, when git can produce one.
 *
 * A failure here degrades the review rather than ending it: the reviewer still
 * has the file list and its own read tools. It must not throw, because a gate
 * that cannot produce a diff is still better than no gate — but it also must not
 * pretend, which is why the empty string means "no diff supplied" and the prompt
 * simply omits the section.
 */
async function defaultGetDiff(cwd: string, base?: string): Promise<string> {
  const { getDiffText } = await import('../support/gitTracker.js');
  return getDiffText(cwd, base);
}

export function buildReviewWorkerResult(changedFiles: string[], summary?: string): WorkerResult {
  return {
    success: true,
    summary: summary ?? `Working-tree review of ${changedFiles.length} changed file(s)`,
    filesChanged: changedFiles,
    commands: [],
    output: '',
  };
}

// Minimal ANSI helpers — no extra dep. Wrappers only, so plain substrings
// (e.g. 'Decision: APPROVE') survive for tests/grep. (INT-1966)
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

/**
 * Render a review verdict for the terminal. `color` adds ANSI styling (decision
 * green/yellow/red, bold section headers, dim locations); off → plain text. (INT-1966)
 */
export function formatReviewOutput(review: ReviewResult, color = false): string {
  const c = (code: string, s: string) => (color ? `${code}${s}${ANSI.reset}` : s);
  const header = (s: string) => c(ANSI.bold, s);
  const decisionColor =
    review.decision === 'approve' ? ANSI.green : review.decision === 'reject' ? ANSI.red : ANSI.yellow;

  const lines: string[] = [];
  const mark = review.decision === 'approve' ? '✓' : review.decision === 'reject' ? '✗' : '✎';
  lines.push(c(decisionColor, `${c(ANSI.bold, mark)} Decision: ${review.decision.toUpperCase()}`));
  if (review.feedback) lines.push(`  ${review.feedback}`);
  if (review.issues?.length) {
    lines.push(`  ${header('Issues:')}`);
    review.issues.forEach((i) => lines.push(`    ${c(ANSI.red, '-')} ${i}`));
  }
  if (review.suggestions?.length) {
    lines.push(`  ${header('Suggestions:')}`);
    review.suggestions.forEach((s) => lines.push(`    ${c(ANSI.cyan, '-')} ${s}`));
  }
  if (review.recommendedActions?.length) {
    lines.push(`  ${header('Recommended follow-ups:')}`);
    review.recommendedActions.forEach((a) =>
      lines.push(
        `    - ${c(ANSI.cyan, `[${a.type}]`)} ${a.title}${a.location ? ` ${c(ANSI.dim, `(${a.location})`)}` : ''}`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Extract a Linear-style issue id (e.g. INT-1705) from a git branch name so the
 * user can run `--issues` without typing the id. Returns undefined if none. (INT-1967)
 */
export function resolveIssueFromBranch(branch: string): string | undefined {
  const m = branch.match(/([a-z]{2,}-\d+)/i);
  return m ? m[1].toUpperCase() : undefined;
}

/** Best-effort Linear project id from <repo>/openswarm.json, so standalone follow-ups land in the right project. (INT-1968) */
export async function resolveProjectId(cwd: string): Promise<string | undefined> {
  try {
    const { loadRepoMetadata } = await import('../support/repoMetadata.js');
    const meta = await loadRepoMetadata(cwd);
    return meta?.linear?.projectId;
  } catch {
    return undefined;
  }
}

export interface ProjectMappingResult {
  /** Resolved Linear project id — undefined when none applies (explicit parent) or none is available. */
  projectId: string | undefined;
  /** True when Linear filing should be skipped entirely rather than create a project-less (orphan) issue. */
  abort: boolean;
}

/**
 * Preflight before filing a standalone/master Linear issue (no explicit
 * `--issues <id>` parent to inherit a project from): if this repo has no
 * openswarm.json Linear mapping yet, map it now — interactively on a TTY
 * (writes openswarm.json, same picker as `openswarm add`), or fail closed
 * headless so an unattended run never silently creates an orphan issue. (INT-2599)
 */
export async function ensureProjectMapping(
  cwd: string,
  parentIssueId: string | undefined,
  deps: {
    resolveCredential?: () => Promise<import('../linear/index.js').LinearCredential | null>;
    pickAndSave?: (
      repoPath: string,
      cred: import('../linear/index.js').LinearCredential,
    ) => Promise<import('./linearMapping.js').MappingPickResult>;
    isTTY?: boolean;
    log?: (line: string) => void;
  } = {},
): Promise<ProjectMappingResult> {
  // A sub-issue under an explicit parent inherits that parent's project.
  if (parentIssueId) return { projectId: undefined, abort: false };

  const existing = await resolveProjectId(cwd);
  if (existing) return { projectId: existing, abort: false };

  const log = deps.log ?? ((l: string) => console.log(l));
  const resolveCredential =
    deps.resolveCredential ?? (async () => (await import('./linearMapping.js')).resolveLinearCredential());
  const cred = await resolveCredential();
  if (!cred) return { projectId: undefined, abort: false }; // Linear isn't configured — downstream reports that.

  const isTTY = deps.isTTY ?? !!process.stdin.isTTY;
  if (!isTTY) {
    log(
      `No Linear project mapped for this repo (openswarm.json missing) and no terminal to map it interactively — ` +
        `skipping issue filing to avoid an unassigned (orphan) issue. Run \`openswarm add ${cwd}\` once in a ` +
        `terminal to map it, then re-run.`,
    );
    return { projectId: undefined, abort: true };
  }

  log('This repo is not mapped to a Linear project yet — mapping it now:');
  const pickAndSave =
    deps.pickAndSave ?? (async (p, c) => (await import('./linearMapping.js')).pickAndSaveLinearMapping(p, c));
  try {
    const result = await pickAndSave(cwd, cred);
    if (result.kind === 'saved') return { projectId: result.mapping.projectId, abort: false };
    // 'no-teams' means the Linear lookup itself failed or returned nothing — not a
    // user choice — so fail closed rather than silently file a project-less issue.
    if (result.kind === 'no-teams') return { projectId: undefined, abort: true };
    return { projectId: undefined, abort: false }; // user actively skipped the picker — not a silent gap.
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') return { projectId: undefined, abort: true };
    throw err;
  }
}

/**
 * A Linear-backed task source for the standalone `review` CLI. The daemon
 * registers one at startup, but a bare `openswarm review` does not — so init
 * Linear from config (OAuth profile or apiKey) and build a LinearTaskSource.
 * Returns null when Linear isn't configured. (INT-1969)
 */
export async function ensureTaskSource(): Promise<ITaskSource | null> {
  const { getTaskSource } = await import('../automation/runnerExecution.js');
  const existing = getTaskSource();
  if (existing) return existing;
  try {
    const linear = await import('../linear/linear.js');
    if (!linear.isLinearInitialized()) {
      const { loadConfig } = await import('../core/config.js');
      const config = loadConfig();
      if (config.linearTeamId) {
        const { AuthProfileStore, ensureValidToken } = await import('../auth/index.js');
        const authStore = new AuthProfileStore();
        if (authStore.getProfile('linear:default')) {
          const token = await ensureValidToken(authStore, 'linear:default');
          linear.initLinear(token, config.linearTeamId, true);
        } else if (config.linearApiKey) {
          linear.initLinear(config.linearApiKey, config.linearTeamId);
        }
      }
    }
    if (!linear.isLinearInitialized()) return null;
    const { LinearTaskSource } = await import('../automation/taskSource.js');
    return new LinearTaskSource(async () => []); // fetch unused for filing
  } catch {
    return null;
  }
}

export interface ReviewCommandOptions {
  /** Project path (default cwd). */
  path?: string;
  /**
   * File recommendedActions as Linear sub-issues. A string is the explicit parent
   * id; `true` (bare `--issues`) infers the parent from the git branch. (INT-1967)
   */
  fileIssue?: string | boolean;
  /** Adapter override. */
  adapter?: string;
  /** Verbose logging. */
  debug?: boolean;
  /**
   * Review the committed diff against this ref instead of the working tree
   * (e.g. `origin/main`). For CI: a checked-out PR branch has no dirty
   * working-tree changes to find, only commits ahead of its base. (INT-2552)
   */
  base?: string;
  /**
   * Emit the verdict as JSON on stdout instead of the human report, so a CI step
   * can branch on it without scraping terminal text. Progress and diagnostics
   * stay on stderr, keeping stdout a clean document. (INT-3102)
   */
  json?: boolean;
  /** Write a SARIF 2.1.0 report here for GitHub code scanning. (INT-3102) */
  sarif?: string;
  /**
   * Deny the reviewer every mutating tool, including bash. Required when the
   * diff under review is untrusted — a CI review of a pull request otherwise
   * hands an agent shell access on attacker-authored files with the provider
   * credential in the environment. (INT-3189)
   */
  readOnly?: boolean;
  /** Override the reviewer's agentic-loop turn ceiling (default: scaled by diff size). */
  maxTurns?: number;
  /** Override the reviewer's wall-clock budget in ms (default: scaled by diff size). */
  timeoutMs?: number;
}

/**
 * Run the review flow. Injectable deps keep it testable without git/network.
 */
export async function runReviewCommand(
  opts: ReviewCommandOptions = {},
  deps: {
    getChangedFiles?: (cwd: string) => Promise<string[]>;
    /** The diff text handed to the reviewer; injectable so tests need no git. */
    getDiff?: (cwd: string, base?: string) => Promise<string>;
    review?: (
      wr: WorkerResult,
      cwd: string,
      onLog?: (line: string) => void,
      priorReviewContext?: string,
    ) => Promise<ReviewResult>;
    loadHistory?: (cwd: string, files: string[]) => Promise<{
      context?: string;
      records: ReviewHistoryRecord[];
      currentHashes: Record<string, string>;
    }>;
    saveHistory?: (cwd: string, files: string[], review: ReviewResult, base?: string) => Promise<unknown>;
    fileFollowups?: (parentIssueId: string | undefined, review: ReviewResult) => Promise<number>;
    /** Override the project-mapping preflight (tests stub this to skip the interactive picker). */
    ensureProjectMapping?: (cwd: string, parentIssueId: string | undefined) => Promise<ProjectMappingResult>;
    log?: (line: string) => void;
    /** Override the progress indicator (default: TTY-gated spinner). Tests pass a stub. */
    startProgress?: () => { note: (line: string) => void; stop: () => void } | null;
    /** Current git branch (default: `git rev-parse --abbrev-ref HEAD`). For --issues inference. */
    getBranch?: (cwd: string) => Promise<string>;
  } = {},
): Promise<ReviewResult | null> {
  const cwd = opts.path ?? process.cwd();
  // In --json mode stdout carries one document and nothing else. Everything this
  // command narrates — reviewer progress, history dedup, SARIF path, follow-up
  // filing — goes to stderr instead, so `openswarm review --json | jq` parses.
  // Previously all of it went to console.log alongside the JSON, and in CI
  // (`process.stderr.isTTY` false) the progress lines take the same path.
  const log = deps.log ?? ((l: string) => (opts.json ? console.error(l) : console.log(l)));

  const getChangedFiles = deps.getChangedFiles ?? (async (c) => (await import('../support/gitTracker.js')).getChangedFiles(c, opts.base));
  // Review reports/history are OpenSwarm's own local state. Repositories are
  // expected to ignore `.openswarm/`, but filter it here as well so a repo that
  // has not added the ignore rule cannot make each review trigger another one.
  const changed = (await getChangedFiles(cwd)).filter((file) => !file.replaceAll('\\', '/').split('/').includes('.openswarm'));
  if (!changed.length) {
    log(opts.base ? `No changes vs ${opts.base} to review.` : 'No working-tree changes to review.');
    return null;
  }
  if (opts.debug) log(`Reviewing ${changed.length} changed file(s): ${changed.join(', ')}`);

  const defaultLoadHistory = async (projectPath: string, files: string[]) => {
    const [loaded, currentHashes] = await Promise.all([
      loadReviewHistory(projectPath),
      captureReviewFileHashes(projectPath, files),
    ]);
    const rendered = renderReviewHistoryContext(loaded, files, currentHashes);
    return { context: rendered.context, records: rendered.matchingRecords, currentHashes };
  };
  const loadHistoryForReview = deps.loadHistory
    ?? (deps.review ? async () => ({ context: undefined, records: [], currentHashes: {} }) : defaultLoadHistory);
  const history = await loadHistoryForReview(cwd, changed).catch((error) => {
    if (opts.debug) log(`Could not read prior review logs: ${error instanceof Error ? error.message : String(error)}`);
    return { context: undefined, records: [], currentHashes: {} };
  });
  if (history.context) log(`Loaded prior review log context for ${changed.length} changed file(s).`);

  const review =
    deps.review ??
    (async (wr: WorkerResult, c: string, onLog?: (line: string) => void) => {
      const { runReviewer } = await import('../agents/reviewer.js');
      return runReviewer({
        taskTitle: opts.base ? `CLI committed-diff review (vs ${opts.base})` : 'CLI working-tree review',
        taskDescription: opts.base
          ? `Review the committed changes against ${opts.base} for correctness, bugs, and follow-ups.`
          : 'Review the current working-tree changes for correctness, bugs, and follow-ups.',
        workerResult: wr,
        projectPath: c,
        adapterName: opts.adapter as never,
        mode: 'direct',
        priorReviewContext: history.context,
        readOnly: opts.readOnly,
        maxTurns: opts.maxTurns ?? scaledReviewMaxTurns(changed.length),
        timeoutMs: opts.timeoutMs ?? scaledReviewTimeoutMs(changed.length),
        diff: await deps.getDiff?.(c, opts.base) ?? await defaultGetDiff(c, opts.base),
        onLog,
      });
    });

  // Live "still working" feedback so a multi-second review doesn't look frozen.
  // On a TTY, a spinner heartbeat; otherwise each tool line is printed. (INT-1963)
  const startProgress = deps.startProgress ?? (() => (process.stderr.isTTY ? startReviewProgress() : null));
  const progress = startProgress();
  const onLog = (line: string) => {
    if (progress) progress.note(line);
    else log(`  · ${line}`);
  };

  let result: ReviewResult;
  try {
    result = await review(buildReviewWorkerResult(changed), cwd, onLog, history.context);
  } finally {
    progress?.stop();
  }
  const deduped = dedupeReviewActions(result, history.records, history.currentHashes);
  result = deduped.review;
  if (deduped.removed > 0) log(`Suppressed ${deduped.removed} duplicate follow-up(s) already recorded for unchanged code.`);

  // --json replaces the human report rather than adding to it: mixing prose into
  // stdout would break `openswarm review --json | jq`. Everything else this
  // command says already goes through `log`, which callers route to stderr in
  // that mode. (INT-3102)
  if (opts.json) {
    const { toReviewJson } = await import('./reviewOutput.js');
    process.stdout.write(`${JSON.stringify(toReviewJson(result), null, 2)}\n`);
  } else {
    log(formatReviewOutput(result, !!process.stdout.isTTY));
  }

  if (opts.sarif) {
    const { toSarif, packageVersion } = await import('./reviewOutput.js');
    const { writeFile: writeSarif } = await import('node:fs/promises');
    try {
      await writeSarif(opts.sarif, `${JSON.stringify(toSarif(result, await packageVersion()), null, 2)}\n`);
      log(`SARIF report written to ${opts.sarif}`);
    } catch (error) {
      // A report we could not write is a warning, not a failed gate: the verdict
      // already exists and must still decide the exit code. (INT-3100)
      log(`Could not write SARIF report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const saveHistoryForReview = deps.saveHistory
    ?? (deps.review
      ? async () => undefined
      : async (projectPath: string, files: string[], reviewResult: ReviewResult, base?: string) =>
        saveReviewHistory(projectPath, { kind: 'direct', base, files, review: reviewResult }));
  await saveHistoryForReview(
    cwd,
    changed,
    result,
    opts.base,
  ).catch((error) => {
    log(`Could not save review history: ${error instanceof Error ? error.message : String(error)}`);
  });

  const followups = result.recommendedActions?.length ?? 0;
  // Post-verdict side-effects must not change the exit code: a verdict exists,
  // so a Linear/network failure here is a warning, not gate-not-run. A rethrow
  // would turn a completed (even rejecting) review into exit 2. (INT-3100)
  try {
    await fileFollowupsBestEffort();
  } catch (error) {
    log(`Could not file follow-ups: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;

  async function fileFollowupsBestEffort(): Promise<void> {
    if (opts.fileIssue && followups) {
      // Resolve the parent issue: explicit id, else inferred from the git branch. (INT-1967)
      let parent = typeof opts.fileIssue === 'string' ? opts.fileIssue : undefined;
      if (!parent) {
        const getBranch =
          deps.getBranch ??
          (async (c: string) => {
            const { execFileSync } = await import('node:child_process');
            return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: c,
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .toString()
              .trim();
          });
        const branch = await getBranch(cwd).catch(() => '');
        parent = resolveIssueFromBranch(branch);
        if (parent) log(`Filing follow-ups under ${parent} (inferred from branch "${branch}").`);
      }
      // No parent → create top-level (standalone) issues rather than refusing. (INT-1968)
      // Before that, make sure this repo actually has a Linear project to land
      // in — map it now (interactive) or bail rather than file an orphan. (INT-2599)
      const mapping = await (deps.ensureProjectMapping ?? (async (c, p) => ensureProjectMapping(c, p, { log })))(cwd, parent);
      if (mapping.abort) {
        log('Skipped filing follow-ups — map this repo to a Linear project first (see above), then re-run.');
      } else {
        // Default path initializes a Linear task source itself (the daemon isn't
        // running here), and files regardless of decision. (INT-1969)
        const fileFollowups =
          deps.fileFollowups ??
          (async (p: string | undefined, r: ReviewResult) => {
            const { fileReviewerFollowups } = await import('../automation/runnerExecution.js');
            const source = await ensureTaskSource();
            if (!source) return 0;
            return fileReviewerFollowups(source, p, r, { autoFile: true, projectId: mapping.projectId, requireApprove: false });
          });
        const filed = await fileFollowups(parent, result);
        if (filed > 0) {
          log(
            parent
              ? `Filed ${filed} follow-up sub-issue(s) under ${parent}.`
              : `Filed ${filed} standalone follow-up issue(s) (pass \`--issues <id>\` to nest them under an issue).`,
          );
        } else {
          log(
            `Could not file follow-ups (0 created). Is Linear connected? Run \`openswarm auth login --provider linear\` (or set linearApiKey in config).`,
          );
        }
      }
    } else if (followups) {
      // Suggestions were made but nothing was filed — make the flag discoverable. (INT-1966/1967)
      log(`\n${followups} follow-up(s) suggested. Re-run with \`--issues\` to create them as Linear sub-issues (parent inferred from the branch, or pass \`--issues <id>\`).`);
    }
  }
}
