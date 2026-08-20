#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Reviewer Model Selection Benchmark
// Created: 2026-07-31
// Purpose: Rank candidate models for the REVIEWER role. modelSelect.ts covers the
//          worker (can it produce a passing edit?); this asks the different
//          question a reviewer must answer well: does it catch a planted defect
//          AND leave clean work alone?
//
//          A reviewer that rejects everything scores 100% detection and is
//          useless — it just loops the worker forever. So detection rate alone is
//          not the metric; the score pairs it with the false-reject rate on clean
//          fixtures, and ranks on the balanced accuracy of the two.
//
//          Reuses the planted-defect fixtures from reviewLensAB (INT-2230). Runs
//          a single reviewer per fixture — the 3-lens fan-out it A/B'd showed no
//          uplift and was removed from the product, so replaying it here would
//          quadruple cost for nothing.
//
// 실행:
//   npx tsx benchmarks/reviewerModelSelect.ts --repeat 2 \
//     --model deepseek/deepseek-v4-pro --model z-ai/glm-5.2
//   OPENROUTER_PROVIDER_ONLY=atlas-cloud npx tsx benchmarks/reviewerModelSelect.ts
//   (OPENROUTER_API_KEY required — auto-loaded from the repo .env)
// ============================================

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runReviewer } from '../src/agents/reviewer.js';
import { setDefaultAdapter } from '../src/adapters/index.js';
import type { AdapterName } from '../src/adapters/types.js';
import { safeConsole as console } from '../src/support/safeLog.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { LENS_FIXTURES, type LensFixture } from './tasks/reviewLensFixtures.js';

const exec = promisify(execFile);

const DEFAULT_CANDIDATES = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'z-ai/glm-4.7',
  'z-ai/glm-5.2',
  'minimax/minimax-m3',
];

interface RunResult {
  model: string;
  fixture: string;
  category: string;
  expectDefect: boolean;
  decision: string;
  /** Rejected (or requested changes) — regardless of whether it named the defect. */
  flagged: boolean;
  /** Flagged AND named the planted defect. */
  named: boolean;
  correct: boolean;
  durationMs: number;
  error?: string;
}

async function setupFixtureRepo(fx: LensFixture): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-revbench-'));
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
  // The worker's change lands as an uncommitted working-tree diff, which is what
  // the reviewer reads.
  for (const [rel, content] of Object.entries(fx.changed)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

function keywordHit(text: string, keywords: string[]): boolean {
  const hay = text.toLowerCase();
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}

async function runOne(fx: LensFixture, model: string, adapter: AdapterName): Promise<RunResult> {
  const dir = await setupFixtureRepo(fx);
  const started = Date.now();
  try {
    const r = await runReviewer({
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
      model,
      timeoutMs: 180_000,
      mode: 'change',
    });

    const text = [r.feedback, ...(r.issues ?? []), ...(r.suggestions ?? [])].join(' \n ');
    const flagged = r.decision !== 'approve';
    const named = flagged && keywordHit(text, fx.detectionKeywords);
    // Clean fixtures invert: approving is the correct answer.
    const correct = fx.expectDefect ? named : !flagged;

    return {
      model, fixture: fx.key, category: fx.category, expectDefect: fx.expectDefect,
      decision: r.decision, flagged, named, correct, durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      model, fixture: fx.key, category: fx.category, expectDefect: fx.expectDefect,
      decision: 'error', flagged: false, named: false, correct: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Aggregate {
  model: string;
  defectRuns: number;
  detected: number;       // named the planted defect
  flaggedOnDefect: number; // rejected, even if it did not name the defect
  cleanRuns: number;
  falseRejects: number;
  errors: number;
  avgMs: number;
  detectionRate: number;
  falseRejectRate: number;
  balanced: number;       // mean of detection and clean-accept rates
}

function aggregate(results: RunResult[]): Aggregate[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const out: Aggregate[] = [];
  for (const [model, rs] of byModel) {
    const defects = rs.filter((r) => r.expectDefect);
    const cleans = rs.filter((r) => !r.expectDefect);
    const detected = defects.filter((r) => r.named).length;
    const falseRejects = cleans.filter((r) => r.flagged).length;
    const detectionRate = defects.length ? detected / defects.length : 0;
    const cleanAccept = cleans.length ? (cleans.length - falseRejects) / cleans.length : 0;
    // Average only over the classes actually present. Counting an absent class as
    // 0 made a --fixture subset of pure-defect fixtures report 50% balanced
    // accuracy on a perfect 100% detection run.
    const present = [
      ...(defects.length ? [detectionRate] : []),
      ...(cleans.length ? [cleanAccept] : []),
    ];
    out.push({
      model,
      defectRuns: defects.length,
      detected,
      flaggedOnDefect: defects.filter((r) => r.flagged).length,
      cleanRuns: cleans.length,
      falseRejects,
      errors: rs.filter((r) => r.error).length,
      avgMs: rs.reduce((s, r) => s + r.durationMs, 0) / Math.max(rs.length, 1),
      detectionRate,
      falseRejectRate: cleans.length ? falseRejects / cleans.length : 0,
      balanced: present.length ? present.reduce((s, v) => s + v, 0) / present.length : 0,
    });
  }

  // Balanced accuracy first — a reject-everything reviewer must not win. Ties go
  // to fewer false rejects (they cost worker loops), then to speed.
  return out.sort((a, b) =>
    b.balanced - a.balanced ||
    a.falseRejectRate - b.falseRejectRate ||
    a.avgMs - b.avgMs,
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function parseArgs(argv: string[]) {
  const models: string[] = [];
  const fixtures: string[] = [];
  let repeat = 2;
  let adapter: AdapterName = 'openrouter';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') models.push(argv[++i]);
    else if (a === '--fixture') fixtures.push(argv[++i]);
    else if (a === '--repeat') repeat = Number(argv[++i]);
    else if (a === '--adapter') adapter = argv[++i] as AdapterName;
  }
  return { models: models.length ? models : DEFAULT_CANDIDATES, fixtures, repeat, adapter };
}

async function main(): Promise<void> {
  const { models, fixtures, repeat, adapter } = parseArgs(process.argv.slice(2));
  loadEnvFile();
  initLocale('en');
  setDefaultAdapter(adapter);

  const selected = fixtures.length ? LENS_FIXTURES.filter((f) => fixtures.includes(f.key)) : LENS_FIXTURES;
  if (selected.length === 0) {
    console.error('No fixtures matched.');
    process.exit(1);
  }

  const defectCount = selected.filter((f) => f.expectDefect).length;
  console.log('\n=== Reviewer Model Selection ===');
  console.log(`adapter=${adapter}  models=${models.length}  fixtures=${selected.length} (${defectCount} defect, ${selected.length - defectCount} clean)  repeat=${repeat}`);
  console.log(`total reviews = ${models.length * selected.length * repeat}`);
  if (process.env.OPENROUTER_PROVIDER_ONLY) {
    console.log(`provider pin: ${process.env.OPENROUTER_PROVIDER_ONLY}`);
  }
  console.log('');

  const results: RunResult[] = [];
  for (const model of models) {
    for (const fx of selected) {
      for (let rep = 1; rep <= repeat; rep++) {
        const r = await runOne(fx, model, adapter);
        results.push(r);
        const mark = r.error ? '!' : r.correct ? '✓' : '✗';
        console.log(
          `  ${mark} ${model.padEnd(28)} ${fx.key.padEnd(28)} rep${rep} ` +
          `${r.decision.padEnd(16)} ${(r.durationMs / 1000).toFixed(0)}s` +
          (r.error ? `  ${r.error.slice(0, 80)}` : ''),
        );
      }
    }
  }

  const table = aggregate(results);
  console.log('\n--- ranking (balanced accuracy → fewer false rejects → faster) ---');
  console.log('model                          detect  false-rej  balanced  err  avg');
  for (const a of table) {
    console.log(
      `${a.model.padEnd(30)} ${pct(a.detectionRate).padStart(6)}  ` +
      `${pct(a.falseRejectRate).padStart(9)}  ${pct(a.balanced).padStart(8)}  ` +
      `${String(a.errors).padStart(3)}  ${(a.avgMs / 1000).toFixed(0)}s`,
    );
  }

  const best = table[0];
  if (best) {
    console.log(
      `\nbest: ${best.model} — detected ${best.detected}/${best.defectRuns} defects, ` +
      `${best.falseRejects}/${best.cleanRuns} false rejects on clean work`,
    );
  }
  console.log('\nNo config is changed automatically — apply the winner by hand.');

  const outDir = join(dirname(new URL(import.meta.url).pathname), 'results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `reviewerModelSelect-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, `${JSON.stringify({ results, table }, null, 2)}\n`);
  console.log(`raw results: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
