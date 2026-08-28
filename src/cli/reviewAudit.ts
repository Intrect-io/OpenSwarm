// ============================================
// OpenSwarm - `openswarm review --max` codebase audit (INT-2006)
// ============================================
//
// Full-codebase, multi-agent audit. Partition the tracked source into
// directory-shaped "areas", fan a reviewer subagent out over each area with a
// concurrency cap, then aggregate the verdicts. The pure pieces (filter /
// partition / aggregate) are unit-tested; the orchestration shell wires
// git + runReviewer + the live board + Linear.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { ReviewResult, RecommendedAction } from '../agents/agentPair.js';
import type { ReviewerOptions } from '../agents/reviewer.js';
import type { AdapterName } from '../adapters/types.js';
import { runPool } from '../support/concurrencyPool.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import { c, status } from '../support/colors.js';
import { sanitizeTerminalText } from '../tui/sanitize.js';
import type { SecurityFinding } from '../verify/securityAudit.js';

/** Synthetic area label carrying deterministic CodeQL findings into a review run. */
export const SECURITY_AUDIT_AREA = '.openswarm/codeql-security';

/** Add deterministic CodeQL findings as a fixable, synthetic review area. */
export function mergeSecurityAuditFindings(run: AuditRun, findings: readonly SecurityFinding[]): AuditRun {
  const results = run.results.filter((result) => result.area.label !== SECURITY_AUDIT_AREA);
  if (findings.length === 0) return { ...run, results, summary: aggregateAuditResults(results) };
  const files = [...new Set(findings.map((finding) => finding.filePath).filter((file): file is string => Boolean(file)))].sort();
  const issues = findings.map((finding) => {
    const location = finding.filePath ? `${finding.filePath}${finding.line ? `:${finding.line}` : ''}` : 'repository';
    return `CodeQL ${finding.ruleId} (${location}): ${finding.message}`;
  });
  const decision: ReviewResult['decision'] = findings.some((finding) => finding.level === 'error') ? 'reject' : 'revise';
  results.push({
    area: { label: SECURITY_AUDIT_AREA, dir: '.', files },
    review: {
      decision,
      feedback: `Deterministic CodeQL findings must be fixed before approval:\n${issues.join('\n')}`,
      issues,
      recommendedActions: findings.map((finding) => ({
        type: 'security',
        title: `Fix CodeQL ${finding.ruleId}${finding.filePath ? ` at ${finding.filePath}${finding.line ? `:${finding.line}` : ''}` : ''}`,
      })),
    },
  });
  return { ...run, results, summary: aggregateAuditResults(results) };
}

// Source extensions and test patterns mirror src/knowledge/scanner.ts. Kept
// local (not imported) because those are unexported module consts; the audit
// only needs the stable subset and drift here is low-risk.
// Language-agnostic: the reviewer is an LLM, so collect source across languages.
// Data/config/docs (.json/.toml/.yaml/.md/…) are intentionally NOT source.
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', // JS/TS
  '.py', '.pyw', // Python
  '.rs', '.go', // Rust / Go
  '.java', '.kt', '.kts', '.scala', '.groovy', // JVM
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.cs', // C / C++ / C#
  '.rb', '.php', '.swift', '.m', '.mm', // Ruby / PHP / Swift / Obj-C
  '.ex', '.exs', '.clj', '.cljs', '.ml', '.mli', '.hs', '.dart', '.lua', '.jl', '.zig', '.nim', // others
]);
const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, // JS/TS
  /_test\.py$/, /test_.*\.py$/, /\.test\.py$/, // Python
  /_test\.go$/, // Go
  /Tests?\.java$/, /Tests?\.kt$/, // JVM
  /_spec\.rb$/, /_test\.rb$/, // Ruby
  // Rust uses inline #[cfg(test)] — no file-level test split; reviewer sees it inline.
];
// Belt-and-suspenders: git ls-files already honors .gitignore, but tracked
// junk dirs (snapshots, coverage) shouldn't be audited as if they were source.
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'trash', '.openswarm', 'htmlcov', 'coverage', 'vendor',
  'target', '__pycache__', 'bin', 'obj', // Rust/JVM build, Python cache, .NET output
]);

/** One reviewer-subagent unit of work: a directory (or a chunk of a big one). */
export interface AuditArea {
  /** Human label, e.g. `src/tui/panels` or `src/agents (2/3)`. */
  label: string;
  /** The directory this area covers (repo-relative). */
  dir: string;
  /** Source files in this area (repo-relative, sorted). */
  files: string[];
}

/** Result of reviewing one area: a verdict, or an error if the subagent failed. */
export interface AuditAreaResult {
  area: AuditArea;
  review?: ReviewResult;
  error?: string;
}

/** Per-area summary row for the aggregate report. */
export interface AuditAreaSummary {
  label: string;
  decision: ReviewResult['decision'] | 'error';
  issueCount: number;
  actionCount: number;
  /**
   * Why this area failed, when `decision` is 'error'. Carried through to the
   * console summary and the markdown report: a bare "(subagent failed)" left the
   * operator with no way to tell a hung MCP server from an exhausted quota, and
   * the string was already in hand. (AGT-3990)
   */
  error?: string;
}

export interface AuditSummary {
  /** Rolled-up verdict: reject if any area rejects, else revise if any revises, else approve. */
  decision: ReviewResult['decision'];
  totalAreas: number;
  completed: number;
  failed: number;
  areas: AuditAreaSummary[];
  /** All issues, each prefixed with its area label. */
  issues: string[];
  /** All recommended follow-ups, with the area folded into `location`. */
  recommendedActions: RecommendedAction[];
}

/** Drop non-source, test, and junk-dir files. Pure. */
export function filterSourceFiles(files: string[]): string[] {
  return files.filter((f) => {
    const ext = f.slice(f.lastIndexOf('.'));
    if (!SOURCE_EXTENSIONS.has(ext)) return false;
    if (TEST_PATTERNS.some((re) => re.test(f))) return false;
    if (f.split('/').some((seg) => SKIP_DIR_SEGMENTS.has(seg))) return false;
    return true;
  });
}

/**
 * Prefer a conventional production-source root: if any `src/` files exist, audit
 * only those (drops benchmarks/scripts/config at the repo root); otherwise fall
 * back to the full source set. Pure. (extend the prefix list if a repo uses
 * lib/ or packages/ instead.)
 */
export function preferSrcRoot(files: string[]): string[] {
  const src = files.filter((f) => f.startsWith('src/'));
  return src.length ? src : files;
}

/**
 * List the repo's tracked source files via `git ls-files` (honors .gitignore),
 * keep production source, and prefer the src/ root. Throws if `cwd` isn't a git
 * repo.
 */
export function listSourceFiles(cwd: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = filterSourceFiles(out.split('\n').map((l) => l.trim()).filter(Boolean));
  return preferSrcRoot(all);
}

/**
 * Partition source files into areas. Each directory becomes one area; a
 * directory with more than `maxFilesPerArea` files is split into numbered
 * chunks so a single reviewer subagent never gets an unreadable pile. Pure and
 * deterministic (dirs and files sorted). (INT-2006)
 */
export function partitionIntoAreas(files: string[], maxFilesPerArea = 12): AuditArea[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }

  const areas: AuditArea[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const dirFiles = byDir.get(dir)!.sort();
    if (dirFiles.length <= maxFilesPerArea) {
      areas.push({ label: dir, dir, files: dirFiles });
      continue;
    }
    // Split oversized directories into evenly numbered chunks.
    const chunks = Math.ceil(dirFiles.length / maxFilesPerArea);
    for (let i = 0; i < chunks; i++) {
      const slice = dirFiles.slice(i * maxFilesPerArea, (i + 1) * maxFilesPerArea);
      areas.push({ label: `${dir} (${i + 1}/${chunks})`, dir, files: slice });
    }
  }
  return areas;
}

/**
 * Partition, then shrink the per-area cap until the fan-out can saturate the
 * reviewer pool. The plain directory partition can yield far fewer areas than
 * `concurrency` (e.g. two dirs, concurrency 8 → 2 subagents, 6 idle), so when
 * we're under the pool size we re-partition with a smaller cap — more, smaller
 * areas finish sooner in parallel. Monotonic (smaller cap ⇒ ≥ areas), so it
 * converges; it stops as soon as areas ≥ concurrency or the cap bottoms out at
 * one file per area. No-op when the directory partition already fills the pool.
 * (INT-2249)
 */
export function balanceAreasToConcurrency(
  files: string[],
  concurrency: number,
  maxFilesPerArea = 12,
): AuditArea[] {
  let areas = partitionIntoAreas(files, maxFilesPerArea);
  if (concurrency <= 1) return areas;
  for (let cap = maxFilesPerArea - 1; areas.length < concurrency && cap >= 1; cap--) {
    areas = partitionIntoAreas(files, cap);
  }
  return areas;
}

/**
 * Roll N per-area results into one verdict + merged issues/actions. The worst
 * decision wins (reject > revise > approve); errored areas make the aggregate
 * reject so incomplete codebase audits cannot silently approve. Pure.
 */
export function aggregateAuditResults(results: AuditAreaResult[]): AuditSummary {
  const areas: AuditAreaSummary[] = [];
  const issues: string[] = [];
  const recommendedActions: RecommendedAction[] = [];
  let worst: ReviewResult['decision'] = 'approve';
  let completed = 0;
  let failed = 0;
  // Cross-area dedup: a fan-out reviewer often flags a shared file it imported,
  // so the same finding shows up under several areas. Keep the first. (INT-2022)
  const seen = new Set<string>();

  const rank = (d: ReviewResult['decision']): number => (d === 'reject' ? 2 : d === 'revise' ? 1 : 0);

  // True when a follow-up's location points at a file this area actually owns.
  // Reviewers may read imports to understand them, but a finding outside the area
  // is audited by its own area — dropping it here removes the fan-out duplicate. (INT-2022)
  const inArea = (location: string | undefined, area: AuditArea): boolean => {
    if (!location) return true; // area-level note, keep
    const path = location.split(':')[0].trim();
    return area.files.includes(path) || path === area.dir || path.startsWith(area.dir + '/');
  };

  for (const { area, review, error } of results) {
    if (error || !review) {
      failed++;
      areas.push({ label: area.label, decision: 'error', issueCount: 0, actionCount: 0, error: error ?? 'no result' });
      continue;
    }
    completed++;
    if (rank(review.decision) > rank(worst)) worst = review.decision;

    const reviewIssues = review.issues ?? [];
    reviewIssues.forEach((i) => issues.push(`[${area.label}] ${i}`));

    let kept = 0;
    for (const a of review.recommendedActions ?? []) {
      // (B) area isolation — drop findings outside this area (audited elsewhere).
      if (!inArea(a.location, area)) continue;
      // (A) dedup by type + file:line across all areas.
      const key = `${a.type}|${a.location ?? a.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recommendedActions.push({
        ...a,
        // Fold the area into the location so the merged list stays traceable.
        location: a.location ? `${area.label}: ${a.location}` : area.label,
      });
      kept++;
    }

    areas.push({
      label: area.label,
      decision: review.decision,
      issueCount: reviewIssues.length,
      actionCount: kept,
    });
  }

  return { decision: failed ? 'reject' : worst, totalAreas: results.length, completed, failed, areas, issues, recommendedActions };
}

/**
 * Render the audit as a persistable markdown report. Pure — timestamp is injected
 * (no Date.now() inside) so it's deterministic and testable. (INT-2022)
 */
/**
 * Collapse a thrown error into one report-safe line. Adapter errors arrive with
 * stacks and embedded stderr, and a multi-line string breaks both the markdown
 * bullet list and the terminal's one-row-per-area layout. (AGT-3990)
 */
export function oneLineError(error: string | undefined, max = 300): string {
  const flat = sanitizeTerminalText(error ?? 'no result').replace(/\s+/g, ' ').trim();
  if (!flat) return 'no result';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatAuditReport(summary: AuditSummary, repoName: string, timestamp: string): string {
  const mark = (d: AuditAreaSummary['decision']) =>
    d === 'approve' ? '✓' : d === 'revise' ? '✎' : d === 'reject' ? '✗' : '⚠';
  const approved = summary.areas.filter((a) => a.decision === 'approve').length;
  const revised = summary.areas.filter((a) => a.decision === 'revise').length;
  const rejected = summary.areas.filter((a) => a.decision === 'reject').length;

  const lines: string[] = [];
  lines.push(`# Codebase audit — ${repoName}`);
  lines.push('');
  lines.push(`\`openswarm review --max\` · ${timestamp}`);
  lines.push('');
  lines.push(
    `**${summary.totalAreas} area(s)** — ${summary.completed} reviewed, ${summary.failed} failed · ` +
      `${approved} ✓ / ${revised} ✎ / ${rejected} ✗ · **Verdict: ${summary.decision.toUpperCase()}**`,
  );
  lines.push('');

  const failedAreas = summary.areas.filter((a) => a.decision === 'error');
  if (failedAreas.length) {
    lines.push(`## ⚠ Reviewer failures (${failedAreas.length})`);
    lines.push('These areas were NOT audited (subagent error). Re-run to cover them.');
    failedAreas.forEach((a) => lines.push(`- ${a.label} — \`${oneLineError(a.error)}\``));
    lines.push('');
  }

  lines.push('## Areas');
  lines.push('| area | verdict | issues | follow-ups |');
  lines.push('|---|---|---|---|');
  summary.areas.forEach((a) => lines.push(`| ${a.label} | ${mark(a.decision)} | ${a.issueCount} | ${a.actionCount} |`));
  lines.push('');

  if (summary.recommendedActions.length) {
    lines.push(`## Recommended follow-ups (${summary.recommendedActions.length}, deduped)`);
    const byType = new Map<string, RecommendedAction[]>();
    for (const a of summary.recommendedActions) {
      (byType.get(a.type) ?? byType.set(a.type, []).get(a.type)!).push(a);
    }
    for (const [type, actions] of [...byType.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push('');
      lines.push(`### ${type} (${actions.length})`);
      actions.forEach((a) => lines.push(`- ${a.title}${a.location ? ` — \`${a.location}\`` : ''}`));
    }
    lines.push('');
  }

  if (summary.issues.length) {
    lines.push(`## Issues (${summary.issues.length})`);
    summary.issues.forEach((i) => lines.push(`- ${i}`));
  }

  return lines.join('\n');
}

/**
 * Render the aggregate audit verdict for the terminal. Glyphs + colors come from
 * the shared status vocabulary (support/colors `status`), matching the AuditBoard
 * — color is a no-op under NO_COLOR / non-TTY so the text stays clean. (INT-2260)
 */
export function formatAuditSummary(summary: AuditSummary): string {
  // decision → shared status glyph (colored): approve ✓, revise ✎, reject ✗, error ⚠.
  const mark = (d: AuditAreaSummary['decision']) =>
    d === 'approve' ? status.glyph('ok') : d === 'revise' ? status.glyph('revise') : d === 'reject' ? status.glyph('err') : status.glyph('warn');
  const lines: string[] = [];

  const approved = summary.areas.filter((a) => a.decision === 'approve').length;
  const revised = summary.areas.filter((a) => a.decision === 'revise').length;
  const rejected = summary.areas.filter((a) => a.decision === 'reject').length;
  lines.push(
    `Codebase audit — ${summary.totalAreas} area(s): ${approved} ${status.glyph('ok')}, ${revised} ${status.glyph('revise')} revise, ${rejected} ${status.glyph('err')} reject` +
      (summary.failed ? `  [${summary.failed} failed]` : ''),
  );
  const verdictPaint = summary.decision === 'reject' ? c.red : summary.decision === 'revise' ? c.yellow : c.green;
  lines.push(verdictPaint(`Verdict: ${summary.decision.toUpperCase()}`));
  lines.push('');

  for (const a of summary.areas) {
    const counts =
      a.decision === 'error'
        ? `(subagent failed: ${oneLineError(a.error, 160)})`
        : `${a.issueCount} issue(s), ${a.actionCount} follow-up(s)`;
    lines.push(`  ${mark(a.decision)} ${a.label}  ${counts}`);
  }

  if (summary.issues.length) {
    lines.push('', c.bold(c.yellow(`Issues (${summary.issues.length}):`)));
    summary.issues.forEach((issue) => {
      const parsed = parseAreaPrefixedIssue(issue);
      if (parsed) {
        lines.push(`  ${status.glyph('warn')} ${c.cyan(parsed.area)}`);
        pushWrapped(lines, parsed.text, '    ', '    ');
      } else {
        pushWrapped(lines, issue, `  ${status.glyph('warn')} `, '    ');
      }
    });
  }
  if (summary.recommendedActions.length) {
    lines.push('', c.bold(c.magenta(`Recommended follow-ups (${summary.recommendedActions.length}):`)));
    summary.recommendedActions.forEach((a) => {
      pushWrapped(lines, a.title, `  ${status.glyph('revise')} ${c.magenta(`[${a.type}]`)} `, '    ');
      if (a.location) lines.push(`    ${c.gray('loc:')} ${c.cyan(a.location)}`);
    });
  }
  return lines.join('\n');
}

function parseAreaPrefixedIssue(issue: string): { area: string; text: string } | null {
  const match = issue.match(/^\[([^\]]+)]\s*(.+)$/);
  return match ? { area: match[1], text: match[2] } : null;
}

function pushWrapped(lines: string[], text: string, firstPrefix: string, nextPrefix: string): void {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 120));
  const firstWidth = Math.max(20, width - firstPrefix.length);
  const nextWidth = Math.max(20, width - nextPrefix.length);
  const wrapped = wrapPlainText(text, firstWidth, nextWidth);
  if (wrapped.length === 0) {
    lines.push(firstPrefix.trimEnd());
    return;
  }
  lines.push(`${firstPrefix}${wrapped[0]}`);
  wrapped.slice(1).forEach((line) => lines.push(`${nextPrefix}${line}`));
}

function wrapPlainText(text: string, firstWidth: number, nextWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let width = firstWidth;
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
      width = nextWidth;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Live fan-out progress events — consumed by the ink board (or any listener). */
export type AuditProgress =
  | { type: 'start'; label: string; done: number; total: number }
  | { type: 'log'; label: string; line: string }
  | { type: 'done'; label: string; decision: ReviewResult['decision']; done: number; total: number }
  | { type: 'error'; label: string; error: string; done: number; total: number }
  /** Batch-level note that belongs to no single area (e.g. the give-up decision). */
  | { type: 'notice'; line: string };

export interface RunMaxReviewOptions {
  /** Max reviewer subagents in flight at once. */
  concurrency: number;
  /** Adapter override for the reviewers. */
  adapter?: AdapterName;
  /** Per-area reviewer agentic-loop turn ceiling. */
  maxTurns?: number;
  /** Per-area reviewer wall-clock budget in milliseconds. */
  timeoutMs?: number;
  /** Abort the whole audit (Ctrl+C) — propagated to every subagent. */
  signal?: AbortSignal;
  /** Repository-local prior review log context, keyed by deterministic area label. */
  priorReviewContextByArea?: Readonly<Record<string, string>>;
}

export interface RunMaxReviewDeps {
  /** Review one area → verdict. Default spawns a real reviewer subagent. Injectable for tests. */
  review?: (area: AuditArea, onLog: (line: string) => void) => Promise<ReviewResult>;
  /** Live progress sink (the ink board). */
  onProgress?: (e: AuditProgress) => void;
}

/** Aggregate verdict plus the per-area results (kept for area-by-area Linear filing). */
export interface AuditRun {
  summary: AuditSummary;
  results: AuditAreaResult[];
  /** Set when a codex usage-limit aborted the run early (remaining areas skipped). (INT-2192) */
  rateLimit?: RateLimitError;
  /**
   * Set when the adapter never once produced a verdict and the run gave up early.
   * Holds the first infra error, which is the one worth reporting. (AGT-3990)
   */
  infraAbort?: string;
}

/**
 * Consecutive adapter-level failures, with no area having succeeded, that mean
 * the adapter itself is broken rather than one area being unlucky. A hung MCP
 * server in the user's `~/.codex/config.toml` took every area to its 5-minute
 * timeout; there is nothing to learn from spending that budget N more times.
 *
 * Reaching it withholds new launches only. Reviews already running are never
 * cancelled: at concurrency > 1 the failures report first precisely because they
 * are fast, so a healthy review is often still in flight when the streak lands.
 * (AGT-3990)
 */
const INFRA_ABORT_THRESHOLD = 3;

/** Default area reviewer: spawn an independent reviewer subagent over the area's files. */
export function buildAuditReviewerOptions(
  area: AuditArea,
  cwd: string,
  opts: RunMaxReviewOptions,
  onLog: (line: string) => void,
): ReviewerOptions {
  return {
    mode: 'audit',
    taskTitle: `Codebase audit: ${area.label}`,
    taskDescription:
      `Audit the ${area.files.length} existing source file(s) under ${area.label} for correctness bugs, ` +
      `security issues, resource leaks, and quality problems.`,
    workerResult: buildAuditWorkerResult(area),
    projectPath: cwd,
    adapterName: opts.adapter,
    maxTurns: opts.maxTurns,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    priorReviewContext: opts.priorReviewContextByArea?.[area.label],
    onLog,
  };
}

function buildAuditWorkerResult(area: AuditArea) {
  return {
    success: true,
    summary: `Codebase audit of ${area.label}`,
    filesChanged: area.files,
    commands: [],
    output: '',
  };
}

async function defaultReviewArea(
  area: AuditArea,
  cwd: string,
  opts: RunMaxReviewOptions,
  onLog: (line: string) => void,
): Promise<ReviewResult> {
  const { runReviewer } = await import('../agents/reviewer.js');
  return runReviewer(buildAuditReviewerOptions(area, cwd, opts, onLog));
}

/**
 * Fan a reviewer subagent out over each area with a concurrency cap, then
 * aggregate. Areas are partitioned by the caller (so the board can show them
 * up-front and the cost gate can count them). Never throws on a single area
 * failure — that area lands as an error in the summary. (INT-2006)
 */
export async function runMaxReview(
  areas: AuditArea[],
  cwd: string,
  opts: RunMaxReviewOptions,
  deps: RunMaxReviewDeps = {},
): Promise<AuditRun> {
  const review = deps.review ?? ((area, onLog) => defaultReviewArea(area, cwd, opts, onLog));
  const total = areas.length;
  let done = 0;
  // Once a codex usage-limit hits, stop launching new area reviews — they'd all
  // fail against the same exhausted quota (the STONKS "5/16 → end" wipeout). Keep
  // the typed error so the caller can report the reset time. (INT-2192)
  let rateLimit: RateLimitError | null = null;
  // Give-up state: withholds NEW launches only. Reviews already in flight are
  // left to finish, and a verdict from any of them revokes the give-up — at
  // concurrency > 1 the fast failures report first, so a slow healthy review is
  // routinely still running when the streak hits its threshold. (AGT-3990)
  let infraAbort: string | null = null;
  let infraStreak = 0;
  let firstInfraError: string | null = null;
  let reviewed = 0;
  let settledCount = 0;
  let running = 0;
  // Wakes every parked worker each time an area settles, so the give-up barrier
  // below re-evaluates against fresh state.
  let waiters: Array<() => void> = [];
  const settleTick = (): Promise<void> => new Promise<void>((resolve) => waiters.push(resolve));
  const wakeAll = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  // runPool's own clamp: how many areas are in flight at once, and therefore how
  // many must have reported before "every attempt so far failed" means anything.
  const inFlight = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, areas.length));

  const settled = await runPool(
    areas,
    opts.concurrency,
    async (area) => {
      if (rateLimit) throw new Error('skipped: codex usage limit already hit this run');
      // Park, don't skip. The give-up was decided while other reviews were still
      // running, and any one of them producing a verdict revokes it — so wait for
      // them to report rather than discarding this area on a verdict that may be
      // about to arrive. When nothing is left in flight, the give-up is final.
      while (infraAbort && running > 0 && reviewed === 0) await settleTick();
      if (rateLimit) throw new Error('skipped: codex usage limit already hit this run');
      if (infraAbort) throw new Error(`skipped: ${infraAbort}`);
      running++;
      deps.onProgress?.({ type: 'start', label: area.label, done, total });
      try {
        return await review(area, (line) => deps.onProgress?.({ type: 'log', label: area.label, line }));
      } catch (e) {
        if (e instanceof RateLimitError) rateLimit = e;
        throw e;
      } finally {
        running--;
      }
    },
    (s) => {
      done++;
      settledCount++;
      const area = areas[s.index];
      try {
        if (s.value) {
          reviewed++;
          infraStreak = 0;
          firstInfraError = null;
          // A verdict proves the adapter works, so a give-up decided while this
          // review was still running was wrong — revoke it and resume launching.
          infraAbort = null;
          deps.onProgress?.({ type: 'done', label: area.label, decision: s.value.decision, done, total });
          return;
        }
        deps.onProgress?.({ type: 'error', label: area.label, error: String(s.error ?? 'no result'), done, total });
        // Rate limits have their own guard and reset time; they are not evidence
        // that the adapter is broken. Neither is a failure on a run that has
        // already produced a verdict — that area was simply unlucky.
        if (reviewed > 0 || s.error instanceof RateLimitError) return;
        if (!isInfraError(s.error)) {
          // "Consecutive" is literal: an area-level/model-output failure proves
          // the adapter made progress far enough to break the infra streak. It
          // may be a slow member of the first wave arriving after faster workers
          // tentatively set infraAbort, so revoke that decision too.
          infraStreak = 0;
          firstInfraError = null;
          infraAbort = null;
          return;
        }
        if (infraAbort) return;
        if (infraStreak === 0) firstInfraError = String(s.error ?? 'no result');
        infraStreak++;
        // Wait for the whole first wave to report. With N reviews in flight, the
        // first N-1 settles can all be quick failures while a slow, healthy one is
        // still working — concluding "the adapter is dead" there would skip the
        // rest of a perfectly good audit.
        if (infraStreak < INFRA_ABORT_THRESHOLD || settledCount < inFlight) return;
        infraAbort =
          `adapter never produced a verdict — ${INFRA_ABORT_THRESHOLD} consecutive infrastructure failures, ` +
          `first: ${firstInfraError ?? String(s.error ?? 'no result')}`;
        deps.onProgress?.({ type: 'notice', line: infraAbort });
      } finally {
        // Parked workers re-check the give-up against this settle's outcome — after
        // it has been folded into the state above, not before.
        wakeAll();
      }
    },
  );

  const results: AuditAreaResult[] = settled.map((s, i) =>
    s.error || !s.value ? { area: areas[i], error: s.error ? String(s.error) : 'no result' } : { area: areas[i], review: s.value },
  );
  return {
    summary: aggregateAuditResults(results),
    results,
    rateLimit: rateLimit ?? undefined,
    infraAbort: infraAbort ?? undefined,
  };
}

/**
 * Merge a fallback run (a retry of the primary run's failed/skipped areas on a
 * different adapter) back over the primary results, then re-aggregate. The
 * fallback's own rateLimit (e.g. claude also exhausted) carries forward. (INT-2192)
 */
export function mergeFallback(primary: AuditRun, fallback: AuditRun): AuditRun {
  const fb = new Map(fallback.results.map((r) => [r.area.label, r]));
  const results = primary.results.map((r) => (r.error && fb.has(r.area.label) ? fb.get(r.area.label)! : r));
  // The primary's give-up only still stands if the fallback did not rescue every
  // area; the fallback's own give-up always does. (AGT-3990)
  const infraAbort = fallback.infraAbort ?? (results.some((r) => r.error) ? primary.infraAbort : undefined);
  return { summary: aggregateAuditResults(results), results, rateLimit: fallback.rateLimit, infraAbort };
}
