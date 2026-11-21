// ============================================
// OpenSwarm - SWE-bench grading command, report validation and cohort statistics
// Created: 2026-11-22
// Purpose: The pure half of benchmarks/sweBench.ts (AGT-3179, AGT-3185). It builds
//          the official swebench run_evaluation command, picks the dataset the
//          predictions must be graded against, fails closed on a grading report
//          that does not cover exactly the expected instances, and renders a
//          cohort table with N, a 95% Wilson interval and an exact McNemar test.
//          It reports numbers only: it never names a winner and never touches
//          DEFAULT_MODEL or any config default.
// Dependencies: node:fs, node:path, node:url, benchmarks/sweBenchVerifiedSet.ts
//               (COHORT_IDS only; that module's main() is guarded). No top-level
//               side effects.
// Test Status: tests/sweBench.grading.test.ts
// ============================================

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COHORT_IDS } from './sweBenchVerifiedSet.js';

export const SWE_BENCH_LITE = 'SWE-bench/SWE-bench_Lite';
export const SWE_BENCH_VERIFIED = 'SWE-bench/SWE-bench_Verified';
/** The only datasets a grading command may name. */
export const ALLOWED_DATASETS = [SWE_BENCH_LITE, SWE_BENCH_VERIFIED] as const;
export type SweDataset = (typeof ALLOWED_DATASETS)[number];

/** 97.5th percentile of the standard normal distribution, for a two-sided 95% interval. */
export const Z_95 = 1.959963984540054;
/** The only official report schema this module understands. */
export const REPORT_SCHEMA_VERSION = 2;
export const DEFAULT_GRADER_PYTHON = '/tmp/swebench-env/bin/python';

function isAllowedDataset(value: string): value is SweDataset {
  return (ALLOWED_DATASETS as readonly string[]).includes(value);
}

/**
 * The dataset the predictions are graded against. An explicit SWE_DATASET wins
 * and must be one of ALLOWED_DATASETS (anything else, including an empty
 * string, is refused). Without it, Verified is chosen only when every id is in
 * the Verified cohort; any id outside it (or an empty list) keeps Lite.
 */
export function resolveDataset(instanceIds: readonly string[], env: { SWE_DATASET?: string } = {}): SweDataset {
  const explicit = env.SWE_DATASET;
  if (explicit !== undefined) {
    if (!isAllowedDataset(explicit)) {
      throw new Error(`SWE_DATASET must be one of ${ALLOWED_DATASETS.join(', ')}; got ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  const cohort = new Set<string>(COHORT_IDS);
  return instanceIds.length > 0 && instanceIds.every((id) => cohort.has(id)) ? SWE_BENCH_VERIFIED : SWE_BENCH_LITE;
}

export interface GradeCommandOptions {
  dataset: string;
  predsPath: string;
  runId: string;
  instanceIds: readonly string[];
  python?: string;
}

/** SWE-bench instance id shape, e.g. django__django-11099. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+$/;
/** A run id is a plain token that cannot be read as an option. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * argv for the official grader. One worker (the RUBRIC rule against VM
 * overload) and an instance-level image cache are always passed.
 */
export function buildGradeCommand(opts: GradeCommandOptions): string[] {
  if (!isAllowedDataset(opts.dataset)) throw new Error(`Refusing to grade against unknown dataset ${JSON.stringify(opts.dataset)}`);
  if (opts.instanceIds.length === 0) throw new Error('A grading command needs at least one instance id');
  if (!opts.predsPath) throw new Error('A grading command needs a predictions path');
  if (!opts.runId) throw new Error('A grading command needs a run id');
  // Every value below is a separate argv token, so shell quoting is not the
  // risk; a value that argparse reads as an option is. A token starting with
  // '-' would end the nargs='+' --instance_ids list (or be taken as a flag) and
  // could override the allowlisted --dataset_name, --predictions_path or --run_id.
  const badId = opts.instanceIds.find((id) => !INSTANCE_ID_PATTERN.test(id));
  if (badId !== undefined) throw new Error(`Refusing to grade a malformed instance id ${JSON.stringify(badId)}`);
  if (!RUN_ID_PATTERN.test(opts.runId)) throw new Error(`Refusing to grade with a malformed run id ${JSON.stringify(opts.runId)}`);
  if (opts.predsPath.startsWith('-')) throw new Error(`Refusing a predictions path that starts with '-': ${JSON.stringify(opts.predsPath)}`);
  return [
    opts.python ?? DEFAULT_GRADER_PYTHON, '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', opts.dataset,
    '--predictions_path', opts.predsPath,
    '--run_id', opts.runId,
    '--instance_ids', ...opts.instanceIds,
    '--max_workers', '1',
    '--cache_level', 'instance',
  ];
}

function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * A copy-pasteable rendering of buildGradeCommand's argv, one line per option
 * group. Returned as separate lines because the log sink strips CR/LF.
 */
export function formatGradeCommand(argv: readonly string[]): string[] {
  const groups: string[][] = [];
  for (const token of argv) {
    if (token.startsWith('--') || groups.length === 0) groups.push([token]);
    else groups[groups.length - 1].push(token);
  }
  // The interpreter, -m and the module name share the first line.
  return groups.map((group, index) => {
    const line = group.map(shellQuote).join(' ');
    const indent = index === 0 ? '  ' : '    ';
    return `${indent}${line}${index < groups.length - 1 ? ' \\' : ''}`;
  });
}

// ---- Report validation ----

const ID_FIELDS = [
  'submitted_ids', 'completed_ids', 'resolved_ids', 'unresolved_ids', 'error_ids', 'empty_patch_ids', 'incomplete_ids',
] as const;
type IdField = (typeof ID_FIELDS)[number];

export type GradeReportValidation =
  | { valid: true; resolved: number; total: number; resolvedIds: string[] }
  | { valid: false; problems: string[] };

function sameSet(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.length === b.size && new Set(a).size === a.length && a.every((id) => b.has(id));
}

/**
 * Fail-closed check of an official swebench run_evaluation report against the
 * ids that were meant to be graded. Any error, empty-patch or incomplete id, a
 * submitted or completed set that differs from `expectedIds`, a graded
 * (resolved + unresolved) set that does not partition it, or a schema_version
 * other than 2 makes the report invalid, so a partial run can never shrink the
 * denominator unnoticed.
 */
export function validateGradeReport(report: unknown, expectedIds: readonly string[]): GradeReportValidation {
  const expected = new Set(expectedIds);
  if (expectedIds.length === 0) return { valid: false, problems: ['expected ids are empty'] };
  if (expected.size !== expectedIds.length) return { valid: false, problems: ['expected ids contain duplicates'] };
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return { valid: false, problems: ['report is not a JSON object'] };
  }
  const r = report as Record<string, unknown>;
  const problems: string[] = [];
  if (r.schema_version !== REPORT_SCHEMA_VERSION) {
    problems.push(`schema_version must be ${REPORT_SCHEMA_VERSION}, got ${JSON.stringify(r.schema_version)}`);
  }
  const ids = {} as Record<IdField, string[]>;
  for (const field of ID_FIELDS) {
    const value = r[field];
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
      problems.push(`${field} is missing or not a list of ids`);
      ids[field] = [];
    } else {
      ids[field] = value as string[];
    }
  }
  for (const field of ['error_ids', 'empty_patch_ids', 'incomplete_ids'] as const) {
    if (ids[field].length > 0) problems.push(`${field} is not empty: ${ids[field].join(', ')}`);
  }
  for (const field of ['submitted_ids', 'completed_ids'] as const) {
    if (!sameSet(ids[field], expected)) problems.push(`${field} differs from the expected instance set`);
  }
  const graded = [...ids.resolved_ids, ...ids.unresolved_ids];
  if (!sameSet(graded, expected)) problems.push('resolved_ids and unresolved_ids do not partition the expected instance set');
  if (problems.length > 0) return { valid: false, problems };
  return { valid: true, resolved: ids.resolved_ids.length, total: expectedIds.length, resolvedIds: [...ids.resolved_ids] };
}

// ---- Statistics ----

export interface WilsonInterval {
  estimate: number;
  lower: number;
  upper: number;
}

/**
 * Two-sided 95% Wilson score interval for k successes out of n. N=0 carries
 * no information, so it returns estimate 0 with the full [0, 1] interval
 * instead of NaN.
 */
export function wilsonInterval(k: number, n: number, z: number = Z_95): WilsonInterval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`wilsonInterval needs integers 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return { estimate: 0, lower: 0, upper: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // The bounds are exactly 0 at k=0 and exactly 1 at k=n; pin them so rounding cannot leave 1 - 1e-16.
  return {
    estimate: p,
    lower: k === 0 ? 0 : Math.max(0, centre - half),
    upper: k === n ? 1 : Math.min(1, centre + half),
  };
}

/**
 * Exact two-sided McNemar test on the discordant pairs: b instances solved
 * only by the first model, c only by the second. Under H0 the smaller count
 * is Binomial(b + c, 0.5), so p = min(1, 2 * P(X <= min(b, c))). b + c = 0
 * gives p = 1. Computed in log space so large counts do not underflow.
 */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Error(`mcnemarExact needs non-negative integers, got b=${b} c=${c}`);
  }
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  const logHalfN = -n * Math.LN2;
  let logChoose = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= m; i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logChoose + logHalfN);
  }
  return Math.min(1, 2 * tail);
}

/** Discordant counts between two models graded on the same instance set. */
export function discordantPairs(
  aResolved: readonly string[], bResolved: readonly string[], instanceIds: readonly string[],
): { b: number; c: number } {
  const a = new Set(aResolved);
  const other = new Set(bResolved);
  let b = 0;
  let c = 0;
  for (const id of instanceIds) {
    if (a.has(id) && !other.has(id)) b += 1;
    else if (!a.has(id) && other.has(id)) c += 1;
  }
  return { b, c };
}

// ---- Cohort table ----

export interface CohortEntry {
  model: string;
  report: unknown;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

/**
 * Markdown table for models graded on one shared instance set. Every report is
 * validated against `expectedIds` first and any invalid report throws, so the
 * table can only show complete runs. Rows keep the input order (sorting by
 * rate would be a ranking); every row carries N and the 95% Wilson interval,
 * and every model pair carries its discordant counts and exact McNemar p. It
 * states numbers only and draws no conclusion.
 */
export function renderCohortTable(entries: readonly CohortEntry[], expectedIds: readonly string[]): string {
  if (entries.length === 0) throw new Error('renderCohortTable needs at least one model report');
  const validated = entries.map(({ model, report }) => {
    const result = validateGradeReport(report, expectedIds);
    if (!result.valid) throw new Error(`Report for ${model} is invalid: ${result.problems.join('; ')}`);
    return { model, ...result };
  });
  const n = expectedIds.length;
  const lines = [
    `N = ${n} instances, the same set for every model. Interval: 95% Wilson score.`,
    '',
    '| Model | Resolved | N | Rate | 95% CI |',
    '|---|---:|---:|---:|---|',
  ];
  for (const row of validated) {
    const ci = wilsonInterval(row.resolved, row.total);
    lines.push(`| ${cell(row.model)} | ${row.resolved} | ${row.total} | ${pct(ci.estimate)} | ${pct(ci.lower)} to ${pct(ci.upper)} |`);
  }
  if (validated.length > 1) {
    lines.push(
      '',
      'Paired comparison: exact two-sided McNemar test on discordant instances.',
      '',
      '| Model A | Model B | N | Solved by A only | Solved by B only | p |',
      '|---|---|---:|---:|---:|---:|',
    );
    for (let i = 0; i < validated.length; i += 1) {
      for (let j = i + 1; j < validated.length; j += 1) {
        const { b, c } = discordantPairs(validated[i].resolvedIds, validated[j].resolvedIds, expectedIds);
        lines.push(`| ${cell(validated[i].model)} | ${cell(validated[j].model)} | ${n} | ${b} | ${c} | ${mcnemarExact(b, c).toFixed(4)} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---- Entry-point guard ----

/**
 * True when `moduleUrl` is the script node/tsx was asked to run. Both sides
 * go through realpath so a symlinked checkout or a relative argv[1] matches;
 * any resolution failure counts as "not a direct run".
 */
export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
