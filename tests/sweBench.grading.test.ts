// Created: 2026-11-22
// Purpose: Pin the SWE-bench grading rules in benchmarks/sweBenchGrading.ts
//          (AGT-3179, AGT-3185): dataset choice, the official grading command,
//          fail-closed report validation against the real L6 reports on disk,
//          Wilson/McNemar statistics and the neutral cohort table.
// Dependencies: vitest, benchmarks/sweBenchGrading.ts, benchmarks/results/*.json
// Test Status: passing
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DATASETS, SWE_BENCH_LITE, SWE_BENCH_VERIFIED, Z_95, buildGradeCommand, discordantPairs, formatGradeCommand,
  isDirectRun, mcnemarExact, renderCohortTable, resolveDataset, validateGradeReport, wilsonInterval,
} from '../benchmarks/sweBenchGrading.js';
import { COHORT_IDS } from '../benchmarks/sweBenchVerifiedSet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'benchmarks', 'results');

/** The three Lite instances every L6 run graded. Hard-coded, not read from the reports. */
const L6_IDS = ['pylint-dev__pylint-5859', 'pylint-dev__pylint-7080', 'pylint-dev__pylint-7993'];

/**
 * Every L6 report in benchmarks/results and its honest verdict. Four are clean
 * schema_version 2 runs and accept. The m25 run had two empty patches, so only
 * one instance completed: it must be rejected, not quietly graded on N=1.
 */
const L6_REPORTS: Record<string, { valid: true; resolved: number } | { valid: false; problems: RegExp[] }> = {
  'l6-deepseek_deepseek-v4-flash.report.json': { valid: true, resolved: 3 },
  'l6-deepseek_deepseek-v4-pro.report.json': { valid: true, resolved: 2 },
  'l6-z-ai_glm-4.7.report.json': { valid: true, resolved: 1 },
  'swe_l6_v4flash_RESOLVED2of3_report.json': { valid: true, resolved: 2 },
  'swe_l6_m25_0of3_report.json': {
    valid: false,
    problems: [/^empty_patch_ids is not empty/, /^completed_ids differs/, /^resolved_ids and unresolved_ids do not partition/],
  },
};

const loadReport = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(RESULTS, name), 'utf-8'));
const clean = () => loadReport('l6-deepseek_deepseek-v4-pro.report.json');

function problemsOf(report: unknown, expected: readonly string[] = L6_IDS): string[] {
  const result = validateGradeReport(report, expected);
  return result.valid ? [] : result.problems;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe('validateGradeReport on the real L6 reports', () => {
  it('covers every L6 report file in benchmarks/results', () => {
    const onDisk = readdirSync(RESULTS).filter((f) => /^l6-.*\.report\.json$/.test(f) || /^swe_l6_.*_report\.json$/.test(f));
    expect(onDisk.sort()).toEqual(Object.keys(L6_REPORTS).sort());
  });

  for (const [name, verdict] of Object.entries(L6_REPORTS)) {
    it(`${verdict.valid ? 'accepts' : 'rejects'} ${name}`, () => {
      const result = validateGradeReport(loadReport(name), L6_IDS);
      if (verdict.valid) {
        expect(result).toEqual({ valid: true, resolved: verdict.resolved, total: 3, resolvedIds: expect.any(Array) });
      } else {
        expect(result.valid).toBe(false);
        const problems = result.valid ? [] : result.problems;
        expect(problems).toHaveLength(verdict.problems.length);
        verdict.problems.forEach((re, i) => expect(problems[i]).toMatch(re));
      }
    });
  }
});

describe('validateGradeReport fail-closed rules', () => {
  it('rejects a grading report with errors, empty patches, incomplete ids or a different instance set', () => {
    expect(problemsOf(clean())).toEqual([]);

    // One mutation per case, each reported as exactly one problem, so removing
    // any single check makes its case fail.
    const cases: Array<[string, (r: Record<string, unknown>) => void, RegExp]> = [
      ['error ids', (r) => { r.error_ids = ['pylint-dev__pylint-7080']; }, /^error_ids is not empty: pylint-dev__pylint-7080$/],
      ['empty patches', (r) => { r.empty_patch_ids = ['pylint-dev__pylint-7080']; }, /^empty_patch_ids is not empty/],
      ['incomplete ids', (r) => { r.incomplete_ids = ['pylint-dev__pylint-7080']; }, /^incomplete_ids is not empty/],
      ['a smaller submitted set', (r) => { r.submitted_ids = L6_IDS.slice(0, 2); }, /^submitted_ids differs/],
      ['a larger submitted set', (r) => { r.submitted_ids = [...L6_IDS, 'pylint-dev__pylint-4551']; }, /^submitted_ids differs/],
      ['a duplicated submitted id', (r) => { r.submitted_ids = [L6_IDS[0], L6_IDS[0], L6_IDS[1]]; }, /^submitted_ids differs/],
      ['a different completed set', (r) => { r.completed_ids = L6_IDS.slice(1); }, /^completed_ids differs/],
      ['a graded set that misses an id', (r) => { r.unresolved_ids = []; }, /^resolved_ids and unresolved_ids do not partition/],
      ['a missing id list', (r) => { delete r.incomplete_ids; }, /^incomplete_ids is missing/],
      ['a non-string id', (r) => { r.error_ids = [5859]; }, /^error_ids is missing or not a list of ids/],
    ];
    for (const [label, mutate, expected] of cases) {
      const report = clean();
      mutate(report);
      const problems = problemsOf(report);
      expect(problems, label).toHaveLength(1);
      expect(problems[0], label).toMatch(expected);
    }

    // The same clean report checked against another expected set (the cohort).
    const againstCohort = problemsOf(clean(), COHORT_IDS);
    expect(againstCohort).toEqual(expect.arrayContaining([
      expect.stringMatching(/^submitted_ids differs/), expect.stringMatching(/^completed_ids differs/),
    ]));

    expect(problemsOf(null)).toEqual(['report is not a JSON object']);
    expect(problemsOf([clean()])).toEqual(['report is not a JSON object']);
    expect(problemsOf(clean(), [])).toEqual(['expected ids are empty']);
    expect(problemsOf(clean(), [L6_IDS[0], L6_IDS[0]])).toEqual(['expected ids contain duplicates']);
  });

  it('rejects a report whose schema_version is not 2', () => {
    for (const version of [1, 3, '2', undefined]) {
      const report = clean();
      if (version === undefined) delete report.schema_version;
      else report.schema_version = version;
      const problems = problemsOf(report);
      expect(problems, String(version)).toHaveLength(1);
      expect(problems[0]).toMatch(/^schema_version must be 2/);
    }
  });
});

describe('statistics', () => {
  it('computes a Wilson interval and an exact McNemar test for paired cohorts', () => {
    const z2 = Z_95 * Z_95;
    expect(Z_95).toBe(1.959963984540054);
    // Closed forms at the edges: 0/n has upper z^2/(n+z^2), n/n has lower n/(n+z^2).
    expect(wilsonInterval(0, 30)).toEqual({ estimate: 0, lower: 0, upper: expect.closeTo(z2 / (30 + z2), 12) });
    expect(wilsonInterval(0, 30).upper).toBeCloseTo(0.1135, 4);
    expect(wilsonInterval(30, 30)).toEqual({ estimate: 1, lower: expect.closeTo(30 / (30 + z2), 12), upper: 1 });
    expect(wilsonInterval(3, 3).lower).toBeCloseTo(0.4385, 4);
    const half = wilsonInterval(15, 30);
    expect(half.estimate).toBe(0.5);
    expect(half.lower).toBeCloseTo(0.3315, 4);
    expect(half.upper).toBeCloseTo(1 - half.lower, 12);
    const twoThirds = wilsonInterval(2, 3);
    expect(twoThirds.lower).toBeCloseTo(0.2077, 4);
    expect(twoThirds.upper).toBeCloseTo(0.9385, 4);
    // N=0 carries no information: the full interval, never NaN.
    expect(wilsonInterval(0, 0)).toEqual({ estimate: 0, lower: 0, upper: 1 });
    expect(() => wilsonInterval(4, 3)).toThrow(/0 <= k <= n/);
    expect(() => wilsonInterval(-1, 3)).toThrow();
    expect(() => wilsonInterval(1.5, 3)).toThrow();

    // Exact two-sided McNemar: p = min(1, 2 * P(X <= min(b, c))), X ~ Binomial(b + c, 0.5).
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 12);
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 12);
    expect(mcnemarExact(10, 0)).toBeCloseTo(0.001953125, 12);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(2, 5)).toBeCloseTo(58 / 128, 12);
    expect(mcnemarExact(1, 0)).toBe(1);
    const large = mcnemarExact(500, 560);
    expect(Number.isFinite(large) && large > 0 && large < 1).toBe(true);
    expect(Number.isFinite(mcnemarExact(0, 1100))).toBe(true);
    expect(() => mcnemarExact(-1, 2)).toThrow();

    // Discordant pairs from the real flash and glm-4.7 reports.
    const flash = validateGradeReport(loadReport('l6-deepseek_deepseek-v4-flash.report.json'), L6_IDS);
    const glm = validateGradeReport(loadReport('l6-z-ai_glm-4.7.report.json'), L6_IDS);
    if (!flash.valid || !glm.valid) throw new Error('fixtures must accept');
    expect(discordantPairs(flash.resolvedIds, glm.resolvedIds, L6_IDS)).toEqual({ b: 2, c: 0 });
    expect(discordantPairs(glm.resolvedIds, flash.resolvedIds, L6_IDS)).toEqual({ b: 0, c: 2 });
    expect(mcnemarExact(2, 0)).toBe(0.5);
  });
});

describe('resolveDataset', () => {
  it('chooses Verified when every id is in the cohort and Lite when any id is outside it', () => {
    expect(resolveDataset(COHORT_IDS)).toBe(SWE_BENCH_VERIFIED);
    expect(resolveDataset(['sympy__sympy-13031'])).toBe(SWE_BENCH_VERIFIED);
    expect(resolveDataset([...COHORT_IDS, 'pylint-dev__pylint-5859'])).toBe(SWE_BENCH_LITE);
    expect(resolveDataset(L6_IDS)).toBe(SWE_BENCH_LITE);
    expect(resolveDataset([])).toBe(SWE_BENCH_LITE);
  });

  it('lets an allowlisted SWE_DATASET override the inference and refuses anything else', () => {
    expect(ALLOWED_DATASETS).toEqual(['SWE-bench/SWE-bench_Lite', 'SWE-bench/SWE-bench_Verified']);
    expect(resolveDataset(COHORT_IDS, { SWE_DATASET: SWE_BENCH_LITE })).toBe(SWE_BENCH_LITE);
    expect(resolveDataset(L6_IDS, { SWE_DATASET: SWE_BENCH_VERIFIED })).toBe(SWE_BENCH_VERIFIED);
    for (const bad of ['', 'SWE-bench/SWE-bench', 'princeton-nlp/SWE-bench_Lite', 'swe-bench/swe-bench_verified', 'Verified']) {
      expect(() => resolveDataset(COHORT_IDS, { SWE_DATASET: bad }), bad).toThrow(/SWE_DATASET must be one of/);
    }
  });
});

describe('buildGradeCommand', () => {
  const opts = { dataset: SWE_BENCH_VERIFIED, predsPath: '/tmp/x/predictions.json', runId: 'openswarm-run', instanceIds: L6_IDS };

  it('emits the official run_evaluation command with --max_workers 1 and --cache_level instance', () => {
    const argv = buildGradeCommand(opts);
    expect(argv.slice(0, 3)).toEqual(['/tmp/swebench-env/bin/python', '-m', 'swebench.harness.run_evaluation']);
    expect(valueAfter(argv, '--dataset_name')).toBe(SWE_BENCH_VERIFIED);
    expect(valueAfter(argv, '--predictions_path')).toBe('/tmp/x/predictions.json');
    expect(valueAfter(argv, '--run_id')).toBe('openswarm-run');
    expect(argv.slice(argv.indexOf('--instance_ids') + 1, argv.indexOf('--instance_ids') + 4)).toEqual(L6_IDS);
    expect(valueAfter(argv, '--max_workers')).toBe('1');
    expect(valueAfter(argv, '--cache_level')).toBe('instance');
    expect(argv.filter((t) => t === '--max_workers')).toHaveLength(1);
    expect(buildGradeCommand({ ...opts, python: 'python3' })[0]).toBe('python3');
  });

  it('refuses an unknown dataset or an empty instance list', () => {
    expect(() => buildGradeCommand({ ...opts, dataset: 'SWE-bench/SWE-bench' })).toThrow(/unknown dataset/);
    expect(() => buildGradeCommand({ ...opts, instanceIds: [] })).toThrow(/at least one instance/);
    expect(() => buildGradeCommand({ ...opts, predsPath: '' })).toThrow(/predictions path/);
    expect(() => buildGradeCommand({ ...opts, runId: '' })).toThrow(/run id/);
  });

  it('refuses instance ids, run ids or a predictions path that argparse would read as options', () => {
    // '--dataset_name X' inside the id list would otherwise override the allowlisted dataset.
    expect(() => buildGradeCommand({ ...opts, instanceIds: [L6_IDS[0], '--dataset_name', 'princeton-nlp/X'] }))
      .toThrow(/malformed instance id "--dataset_name"/);
    expect(() => buildGradeCommand({ ...opts, instanceIds: ['-x'] })).toThrow(/malformed instance id/);
    expect(() => buildGradeCommand({ ...opts, instanceIds: ['django__django'] })).toThrow(/malformed instance id/);
    expect(() => buildGradeCommand({ ...opts, instanceIds: ['django__django-1 --run_id x'] })).toThrow(/malformed instance id/);
    expect(() => buildGradeCommand({ ...opts, runId: '--predictions_path' })).toThrow(/malformed run id/);
    expect(() => buildGradeCommand({ ...opts, runId: 'run id' })).toThrow(/malformed run id/);
    expect(() => buildGradeCommand({ ...opts, predsPath: '--run_id' })).toThrow(/predictions path that starts with '-'/);
    expect(() => buildGradeCommand({ ...opts, instanceIds: [...COHORT_IDS], runId: 'openswarm-run.2' })).not.toThrow();
  });

  it('formats the command as copy-pasteable lines that round-trip to the same tokens', () => {
    const argv = buildGradeCommand(opts);
    const lines = formatGradeCommand(argv);
    expect(lines[0]).toBe('  /tmp/swebench-env/bin/python -m swebench.harness.run_evaluation \\');
    expect(lines.at(-1)).toBe('    --cache_level instance');
    expect(lines).toContain('    --max_workers 1 \\');
    const tokens = lines.map((l) => l.replace(/ \\$/, '').trim()).join(' ').split(/\s+/);
    expect(tokens).toEqual(argv);
    const spaced = formatGradeCommand(buildGradeCommand({ ...opts, predsPath: "/tmp/my preds/it's.json" }));
    expect(spaced).toContain(`    --predictions_path '/tmp/my preds/it'\\''s.json' \\`);
  });
});

describe('renderCohortTable', () => {
  const entries = () => [
    { model: 'model-a', report: loadReport('l6-deepseek_deepseek-v4-flash.report.json') },
    { model: 'model-b', report: loadReport('l6-deepseek_deepseek-v4-pro.report.json') },
    { model: 'model-c', report: loadReport('l6-z-ai_glm-4.7.report.json') },
  ];

  it('shows N and the 95% interval on every row and names no winner', () => {
    const table = renderCohortTable(entries(), L6_IDS);
    expect(table).toContain('N = 3 instances');
    expect(table).toContain('95% Wilson');
    expect(table).toContain('| model-a | 3 | 3 | 100.0% | 43.9% to 100.0% |');
    expect(table).toContain('| model-b | 2 | 3 | 66.7% | 20.8% to 93.9% |');
    expect(table).toContain('| model-c | 1 | 3 | 33.3% | 6.1% to 79.2% |');
    expect(table).toContain('| model-a | model-b | 3 | 1 | 0 | 1.0000 |');
    expect(table).toContain('| model-a | model-c | 3 | 2 | 0 | 0.5000 |');
    expect(table).toContain('| model-b | model-c | 3 | 1 | 0 | 1.0000 |');
    expect(table).not.toMatch(/winner|best|better|worse|\btie|wins?\b|beats?\b|significan|leader|rank|recommend/i);
  });

  it('keeps the input order instead of ranking by rate', () => {
    const table = renderCohortTable(entries().reverse(), L6_IDS);
    expect(table.indexOf('| model-c |')).toBeLessThan(table.indexOf('| model-a |'));
  });

  it('refuses to render an invalid report or an empty model list', () => {
    expect(() => renderCohortTable([...entries(), { model: 'model-d', report: loadReport('swe_l6_m25_0of3_report.json') }], L6_IDS))
      .toThrow(/model-d is invalid: empty_patch_ids/);
    expect(() => renderCohortTable([], L6_IDS)).toThrow(/at least one model/);
  });
});

describe('isDirectRun', () => {
  it('matches the script through a symlink and rejects other or missing paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-guard-'));
    try {
      const script = join(dir, 'script.ts');
      const link = join(dir, 'link.ts');
      writeFileSync(script, '');
      writeFileSync(join(dir, 'other.ts'), '');
      symlinkSync(script, link);
      const url = pathToFileURL(script).href;
      expect(isDirectRun(url, script)).toBe(true);
      expect(isDirectRun(url, link)).toBe(true);
      expect(isDirectRun(url, join(dir, 'other.ts'))).toBe(false);
      expect(isDirectRun(url, join(dir, 'missing.ts'))).toBe(false);
      expect(isDirectRun(url, undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
