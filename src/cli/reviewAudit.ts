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
import type { AdapterName } from '../adapters/types.js';
import { runPool } from '../support/concurrencyPool.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { c, status } from '../support/colors.js';
import {
  planFixUnits,
  workerContextForFixUnit,
  type FixRepositoryContext,
  type FixUnit,
} from './fixPlanning.js';
import { runIsolatedFixBatch } from './fixSandbox.js';

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
      areas.push({ label: area.label, decision: 'error', issueCount: 0, actionCount: 0 });
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
    failedAreas.forEach((a) => lines.push(`- ${a.label}`));
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
      a.decision === 'error' ? '(subagent failed)' : `${a.issueCount} issue(s), ${a.actionCount} follow-up(s)`;
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
  | { type: 'error'; label: string; error: string; done: number; total: number };

export interface RunMaxReviewOptions {
  /** Max reviewer subagents in flight at once. */
  concurrency: number;
  /** Adapter override for the reviewers. */
  adapter?: AdapterName;
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
}

/** Default area reviewer: spawn an independent reviewer subagent over the area's files. */
async function defaultReviewArea(
  area: AuditArea,
  cwd: string,
  opts: RunMaxReviewOptions,
  onLog: (line: string) => void,
): Promise<ReviewResult> {
  const { runReviewer } = await import('../agents/reviewer.js');
  const { buildReviewWorkerResult } = await import('./reviewCommand.js');
  return runReviewer({
    mode: 'audit',
    taskTitle: `Codebase audit: ${area.label}`,
    taskDescription:
      `Audit the ${area.files.length} existing source file(s) under ${area.label} for correctness bugs, ` +
      `security issues, resource leaks, and quality problems.`,
    workerResult: buildReviewWorkerResult(area.files, `Codebase audit of ${area.label}`),
    projectPath: cwd,
    adapterName: opts.adapter as never,
    signal: opts.signal,
    priorReviewContext: opts.priorReviewContextByArea?.[area.label],
    onLog,
  });
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

  const settled = await runPool(
    areas,
    opts.concurrency,
    async (area) => {
      if (rateLimit) throw new Error('skipped: codex usage limit already hit this run');
      deps.onProgress?.({ type: 'start', label: area.label, done, total });
      try {
        return await review(area, (line) => deps.onProgress?.({ type: 'log', label: area.label, line }));
      } catch (e) {
        if (e instanceof RateLimitError) rateLimit = e;
        throw e;
      }
    },
    (s) => {
      done++;
      const area = areas[s.index];
      if (s.error) {
        deps.onProgress?.({ type: 'error', label: area.label, error: String(s.error), done, total });
      } else if (s.value) {
        deps.onProgress?.({ type: 'done', label: area.label, decision: s.value.decision, done, total });
      }
    },
  );

  const results: AuditAreaResult[] = settled.map((s, i) =>
    s.error || !s.value ? { area: areas[i], error: s.error ? String(s.error) : 'no result' } : { area: areas[i], review: s.value },
  );
  return { summary: aggregateAuditResults(results), results, rateLimit: rateLimit ?? undefined };
}

/**
 * Merge a fallback run (a retry of the primary run's failed/skipped areas on a
 * different adapter) back over the primary results, then re-aggregate. The
 * fallback's own rateLimit (e.g. claude also exhausted) carries forward. (INT-2192)
 */
export function mergeFallback(primary: AuditRun, fallback: AuditRun): AuditRun {
  const fb = new Map(fallback.results.map((r) => [r.area.label, r]));
  const results = primary.results.map((r) => (r.error && fb.has(r.area.label) ? fb.get(r.area.label)! : r));
  return { summary: aggregateAuditResults(results), results, rateLimit: fallback.rateLimit };
}

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
  return { summary: aggregateAuditResults(results), results, rateLimit: reReview.rateLimit ?? base.rateLimit };
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
  const allAreas = initial.results.map((result) => result.area);

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
