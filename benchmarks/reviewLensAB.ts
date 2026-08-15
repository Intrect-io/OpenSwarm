#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Multi-Lens Reviewer A/B Benchmark (INT-2230)
// Created: 2026-07-01
// Purpose: Measure the ROI of the 3-lens fan-out reviewer vs a single reviewer
//          on planted-defect fixtures. Answers the two reversal conditions from
//          the PoC: (1) does multi-lens catch defects a single reviewer misses?
//          (3) do the lenses overlap so much that 3 is wasteful?
//
//          Each fixture is a temp git repo (HEAD = pre-change, working tree =
//          the worker's diff). For every fixture we run:
//            - single : runReviewer once (baseline path)
//            - multi  : the 3 lenses, captured per-lens, then merged exactly like
//                       runMultiLensReview does (mergeReviewResults)
//          Detection = decision != approve AND a fixture keyword appears in the
//          issues/feedback. Clean fixtures score the inverse (approve = correct).
//
// 실행:
//   npx tsx benchmarks/reviewLensAB.ts                 # codex (default), all fixtures
//   npx tsx benchmarks/reviewLensAB.ts --adapter codex-responses
//   npx tsx benchmarks/reviewLensAB.ts --fixture security-command-injection
//   npx tsx benchmarks/reviewLensAB.ts --concurrency 1 # gentler on rate limits
//   (auth comes from the same place the daemon uses; .env auto-loaded)
// ============================================

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runReviewer } from '../src/agents/reviewer.js';
import type { ReviewerOptions } from '../src/agents/reviewer.js';
import type { ReviewResult, ReviewDecision } from '../src/agents/agentPair.js';
import { runPool } from '../src/support/concurrencyPool.js';
import { safeConsole as console } from '../src/support/safeLog.js';
import { setDefaultAdapter } from '../src/adapters/index.js';
import type { AdapterName } from '../src/adapters/types.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { LENS_FIXTURES, type LensFixture } from './tasks/reviewLensFixtures.js';

const exec = promisify(execFile);

// ---- lens definitions (self-contained) ----
// The multi-lens reviewer was removed from production after this A/B showed no
// ROI (INT-2230). These definitions are kept here so the benchmark stays
// reproducible: it still fans a single worker result across three focused review
// lenses and merges them exactly as the removed runMultiLensReview did.

interface ReviewLens {
  key: string;
  focus: string;
}

const REVIEW_LENSES: ReviewLens[] = [
  { key: 'correctness', focus: 'logic errors, unhandled edge cases, off-by-one, wrong assumptions, error handling' },
  { key: 'security', focus: 'injection, unsafe input, leaked secrets/keys, auth gaps, unsafe deserialization' },
  { key: 'regression-risk', focus: 'breaks existing behavior, changes a shared contract, missing/!updated tests, side effects on callers' },
];

function buildLensTaskDescription(base: string, lens: ReviewLens): string {
  return `${base}\n\n## Review lens: ${lens.key}\nFocus your review specifically on: ${lens.focus}. Other concerns are secondary — another reviewer covers them.`;
}

const DECISION_RANK: Record<ReviewDecision, number> = { approve: 0, revise: 1, reject: 2 };

function firstLineOf(text: string | undefined): string {
  if (!text) return '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Worst decision across lenses + deduped union of issues/suggestions. */
function mergeReviewResults(results: ReviewResult[]): ReviewResult {
  if (results.length === 0) return { decision: 'approve', feedback: '', issues: [], suggestions: [] };
  let decision: ReviewDecision = 'approve';
  for (const r of results) if (DECISION_RANK[r.decision] > DECISION_RANK[decision]) decision = r.decision;
  const issues = dedupStrings(results.flatMap((r) => r.issues ?? []));
  const suggestions = dedupStrings(results.flatMap((r) => r.suggestions ?? []));
  const feedback = results.map((r) => firstLineOf(r.feedback)).filter(Boolean).join('\n');
  return { decision, feedback, issues, suggestions };
}

// ---- CLI args ----
function parseArgs(argv: string[]): { adapter: AdapterName; fixtures: string[]; concurrency: number } {
  let adapter: AdapterName = 'codex';
  const fixtures: string[] = [];
  let concurrency = REVIEW_LENSES.length;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') adapter = argv[++i] as AdapterName;
    else if (a === '--fixture') fixtures.push(argv[++i]);
    else if (a === '--concurrency') concurrency = Number(argv[++i]);
  }
  return { adapter, fixtures, concurrency };
}

// ---- repo scaffold: HEAD = committed, working tree = changed ----
async function setupFixtureRepo(fx: LensFixture): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-lensab-'));
  for (const [rel, content] of Object.entries(fx.committed)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'bench@local'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'bench'], { cwd: dir });
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'init'], { cwd: dir });
  // Apply the worker's change as an uncommitted working-tree diff.
  for (const [rel, content] of Object.entries(fx.changed)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

function baseOptions(fx: LensFixture, dir: string, adapter: AdapterName): ReviewerOptions {
  return {
    taskTitle: fx.taskTitle,
    taskDescription: fx.taskDescription,
    workerResult: {
      success: true,
      summary: fx.summary,
      filesChanged: Object.keys(fx.changed),
      commands: fx.commands,
      output: '',
    },
    projectPath: dir,
    adapterName: adapter,
    timeoutMs: 180_000,
    mode: 'change',
  };
}

// ---- scoring ----
function textOf(r: ReviewResult): string {
  return [r.feedback, ...(r.issues ?? []), ...(r.suggestions ?? [])].join(' \n ').toLowerCase();
}

function keywordHit(r: ReviewResult, keywords: string[]): boolean {
  const hay = textOf(r);
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}

/** Did this verdict correctly handle the fixture? */
function scored(r: ReviewResult, fx: LensFixture): { correct: boolean; flagged: boolean; named: boolean } {
  const flagged = r.decision !== 'approve';
  if (!fx.expectDefect) {
    // Clean: correct == approved (no false reject).
    return { correct: !flagged, flagged, named: false };
  }
  const named = flagged && keywordHit(r, fx.detectionKeywords);
  // Defect: correct == flagged AND named the actual defect.
  return { correct: named, flagged, named };
}

interface FixtureOutcome {
  key: string;
  category: string;
  expectDefect: boolean;
  single: { decision: string; correct: boolean; named: boolean; ms: number };
  multi: { decision: string; correct: boolean; named: boolean; ms: number };
  lenses: Array<{ key: string; decision: string; named: boolean; ms: number }>;
  /** How many lenses independently named the defect (overlap signal). */
  lensesNaming: number;
}

async function runFixture(fx: LensFixture, adapter: AdapterName, concurrency: number): Promise<FixtureOutcome> {
  const dir = await setupFixtureRepo(fx);
  try {
    const opts = baseOptions(fx, dir, adapter);

    // --- single baseline ---
    const s0 = Date.now();
    const single = await runReviewer(opts);
    const singleMs = Date.now() - s0;
    const singleScore = scored(single, fx);

    // --- multi: run the lenses exactly like runMultiLensReview, but keep each ---
    const settled = await runPool(REVIEW_LENSES, concurrency, async (lens) => {
      const t0 = Date.now();
      const r = await runReviewer({ ...opts, taskDescription: buildLensTaskDescription(opts.taskDescription, lens) });
      return { lens, r, ms: Date.now() - t0 };
    });
    const lensRuns = settled
      .filter((x): x is { index: number; value: { lens: typeof REVIEW_LENSES[number]; r: ReviewResult; ms: number } } => x.value !== undefined)
      .map((x) => x.value);

    const merged = mergeReviewResults(lensRuns.map((l) => l.r));
    const multiScore = scored(merged, fx);
    const multiMs = Math.max(...lensRuns.map((l) => l.ms), 0); // wall-clock (parallel)

    const lenses = lensRuns.map((l) => {
      const sc = scored(l.r, fx);
      return { key: l.lens.key, decision: l.r.decision, named: sc.named, ms: l.ms };
    });
    const lensesNaming = lenses.filter((l) => l.named).length;

    return {
      key: fx.key,
      category: fx.category,
      expectDefect: fx.expectDefect,
      single: { decision: single.decision, correct: singleScore.correct, named: singleScore.named, ms: singleMs },
      multi: { decision: merged.decision, correct: multiScore.correct, named: multiScore.named, ms: multiMs },
      lenses,
      lensesNaming,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

async function main(): Promise<void> {
  const { adapter, fixtures, concurrency } = parseArgs(process.argv.slice(2));
  loadEnvFile();
  initLocale('en');
  setDefaultAdapter(adapter);

  const selected = fixtures.length ? LENS_FIXTURES.filter((f) => fixtures.includes(f.key)) : LENS_FIXTURES;
  if (selected.length === 0) {
    console.error('No fixtures matched.');
    process.exit(1);
  }

  console.log(`\n=== Multi-Lens Reviewer A/B (INT-2230) ===`);
  console.log(`adapter=${adapter}  fixtures=${selected.length}  lens-concurrency=${concurrency}`);
  console.log(`calls ≈ ${selected.length} single + ${selected.length * REVIEW_LENSES.length} lens = ${selected.length * (1 + REVIEW_LENSES.length)}\n`);

  const outcomes: FixtureOutcome[] = [];
  // Fixtures run sequentially so at most `concurrency` reviewer calls are ever
  // in flight — keeps the codex usage curve predictable.
  for (const fx of selected) {
    process.stdout.write(`▶ ${fx.key} (${fx.category})… `);
    try {
      const o = await runFixture(fx, adapter, concurrency);
      outcomes.push(o);
      const mark = (b: boolean) => (b ? '✓' : '✗');
      console.log(
        `single=${o.single.decision}[${mark(o.single.correct)}]  multi=${o.multi.decision}[${mark(o.multi.correct)}]  lensesNaming=${o.lensesNaming}/${o.lenses.length}`,
      );
    } catch (err) {
      console.log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- aggregate ----
  const defects = outcomes.filter((o) => o.expectDefect);
  const cleans = outcomes.filter((o) => !o.expectDefect);
  const singleCaught = defects.filter((o) => o.single.correct).length;
  const multiCaught = defects.filter((o) => o.multi.correct).length;
  const singleFalseReject = cleans.filter((o) => o.single.decision !== 'approve').length;
  const multiFalseReject = cleans.filter((o) => o.multi.decision !== 'approve').length;
  // Defects multi caught that single missed (the uplift that justifies the cost).
  const uplift = defects.filter((o) => o.multi.correct && !o.single.correct);
  const regressions = defects.filter((o) => o.single.correct && !o.multi.correct);

  console.log(`\n=== Detection (defective fixtures, n=${defects.length}) ===`);
  console.log(`single caught: ${singleCaught}/${defects.length} (${pct(singleCaught, defects.length)})`);
  console.log(`multi  caught: ${multiCaught}/${defects.length} (${pct(multiCaught, defects.length)})`);
  console.log(`uplift (multi caught, single missed): ${uplift.length} → ${uplift.map((o) => o.key).join(', ') || 'none'}`);
  if (regressions.length) console.log(`⚠ multi missed what single caught: ${regressions.map((o) => o.key).join(', ')}`);

  console.log(`\n=== False reject (clean fixtures, n=${cleans.length}) ===`);
  console.log(`single: ${singleFalseReject}/${cleans.length}   multi: ${multiFalseReject}/${cleans.length}`);

  // Overlap: for defects, how many lenses independently named the defect. High
  // across the board = lenses redundant (reversal condition 3).
  const namingCounts = defects.map((o) => o.lensesNaming);
  const avgNaming = namingCounts.length ? namingCounts.reduce((a, b) => a + b, 0) / namingCounts.length : 0;
  console.log(`\n=== Lens overlap (defective fixtures) ===`);
  console.log(`avg lenses naming the defect: ${avgNaming.toFixed(2)} / ${REVIEW_LENSES.length}`);
  for (const o of defects) {
    const named = o.lenses.filter((l) => l.named).map((l) => l.key).join(', ') || 'none';
    console.log(`  ${o.key.padEnd(28)} [${o.category}] named-by: ${named}`);
  }
  // Per-lens contribution: which lens was the sole namer on any fixture.
  console.log(`\n=== Per-lens sole contribution ===`);
  for (const lens of REVIEW_LENSES) {
    const sole = defects.filter((o) => o.lensesNaming === 1 && o.lenses.find((l) => l.named)?.key === lens.key);
    console.log(`  ${lens.key.padEnd(16)} sole-namer on: ${sole.map((o) => o.key).join(', ') || 'none'}`);
  }

  // ---- verdict hint ----
  console.log(`\n=== ROI signal ===`);
  console.log(`multi cost = ${REVIEW_LENSES.length}× calls vs single.`);
  if (uplift.length > 0 && multiFalseReject <= singleFalseReject) {
    console.log(`→ multi caught ${uplift.length} defect(s) single missed with no extra false rejects. Uplift real.`);
  } else if (uplift.length === 0) {
    console.log(`→ no detection uplift. 3× cost buys nothing on this set → reversal condition 1 triggered (keep single).`);
  }
  if (avgNaming >= REVIEW_LENSES.length - 0.25) {
    console.log(`→ lenses almost fully overlap (avg ${avgNaming.toFixed(2)}) → reversal condition 3 (drop to fewer lenses).`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join('benchmarks', 'results', `reviewLensAB-${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      { adapter, concurrency, ranAt: stamp, summary: { defects: defects.length, cleans: cleans.length, singleCaught, multiCaught, uplift: uplift.map((o) => o.key), singleFalseReject, multiFalseReject, avgNaming }, outcomes },
      null,
      2,
    ),
  );
  console.log(`\nresults → ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
