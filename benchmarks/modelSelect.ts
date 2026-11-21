#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Model Selection Benchmark
// Created: 2026-06-09
// Purpose: Measure worker model quality and cost on coding tasks and find the
//          Pareto frontier. Port of VEGA benchmarks/model_select.py:
//          score = pass_rate, then real cost, then turn count.
//          Never swaps models automatically: it prints a ranking and a person
//          applies it to config (the operator stays in control).
// Dependencies: src/agents/worker.ts (live OpenRouter runs), benchmarks/modelSelectScoring.ts
// Test Status: tests/modelSelect.scoring.test.ts (parseArgs, import guard; scoring helpers)
//
// Usage:
//   npx tsx benchmarks/modelSelect.ts --repeat 3
//   (OPENROUTER_API_KEY required — auto-loaded from the repo .env)
//   npx tsx benchmarks/modelSelect.ts --model openai/gpt-5 --model qwen/qwen3-coder
//   npx tsx benchmarks/modelSelect.ts --task L0-fix-multiply --repeat 5
//   npx tsx benchmarks/modelSelect.ts --model deepseek/deepseek-v4-flash --model z-ai/glm-5.3 \
//     --primary deepseek/deepseek-v4-flash --task L5-lru-cache --repeat 2   # ESCALATION FINDING
//
// Credits: with OPENROUTER_PROVIDER_ONLY=atlas-cloud the calls draw on a sponsor
// balance that can run out. A 402 "insufficient balance" means the sponsor pool
// is dry, not that the model failed: the run aborts with no ranking. Dropping
// the pin bills the real OpenRouter account. See benchmarks/RUBRIC.md "Credits".
// ============================================

import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorker } from '../src/agents/worker.js';
import { setDefaultAdapter } from '../src/adapters/index.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { CODING_TASKS, type BenchTask } from './tasks/codingTasks.js';
import {
  classifyInfraFailure, fmtUsd, runSweep, summarizeRun, type RunResult,
} from './modelSelectScoring.js';

const exec = promisify(execFile);

// ---- Candidate model pool ----
// Mostly non-frontier open models (the gpt family is compared in a separate run).
// baseline = gemini-2.5-flash (100% pass winner of the previous round).
export const DEFAULT_CANDIDATES = [
  'google/gemini-2.5-flash',          // baseline (previous winner)
  'deepseek/deepseek-v4-pro',         // deepseek flagship
  'deepseek/deepseek-v4-flash',       // deepseek lightweight
  'minimax/minimax-m3',               // latest MiniMax
  'z-ai/glm-5',                       // latest GLM
  'z-ai/glm-4.7-flash',               // ultra-cheap GLM
  'moonshotai/kimi-k2-thinking',      // strong Kimi coder
  'qwen/qwen3-coder-30b-a3b-instruct',// lightweight qwen coder
];

// ---- OpenRouter price catalog ----
async function fetchPrices(apiKey: string): Promise<Map<string, { in: number; out: number }>> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = (await res.json()) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
  const map = new Map<string, { in: number; out: number }>();
  for (const m of data.data) {
    map.set(m.id, {
      in: parseFloat(m.pricing?.prompt ?? '0'),
      out: parseFloat(m.pricing?.completion ?? '0'),
    });
  }
  return map;
}

async function setupRepo(task: BenchTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-bench-'));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'bench@local'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'bench'], { cwd: dir });
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function runOne(
  task: BenchTask,
  model: string,
  rep: number,
  prices: Map<string, { in: number; out: number }>,
): Promise<RunResult> {
  const dir = await setupRepo(task);
  const logs: string[] = [];
  const t0 = Date.now();
  let thrown: string | undefined;
  let workerError: string | undefined;
  let workerSummary: string | undefined;

  try {
    const res = await runWorker({
      taskTitle: task.title,
      taskDescription: task.description,
      projectPath: dir,
      adapterName: 'openrouter',
      model,
      timeoutMs: 240_000,
      maxTurns: 20,
      onLog: (l) => logs.push(l),
    });
    // runWorker returns most adapter errors (a 401 included) instead of
    // throwing, and logs them only to console.error, so the returned result is
    // where an infrastructure failure usually shows up. Its error is trusted
    // only on the catch path; the classifier checks the summary for that.
    workerError = res.error;
    workerSummary = res.summary;
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
    logs.push(`FATAL: ${thrown}`);
  }
  const infraError = classifyInfraFailure({
    error: thrown,
    workerError,
    summary: workerSummary,
    logs,
  }) ?? undefined;

  const durationMs = Date.now() - t0;

  // Grading: hand the repo state to the task's read function.
  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(dir, rel), 'utf-8');
    } catch {
      return null;
    }
  };
  const verdict = task.check(read, dir);

  // Metrics from the log lines.
  const toolCalls = logs.filter((l) => l.includes('🔧')).length;
  const apiCalls = logs.filter((l) => l.includes('API call #')).length;
  const tokenLine = logs.find((l) => /\d+ tokens/.test(l)) ?? '';
  const totalTokens = Number(tokenLine.match(/(\d+) tokens/)?.[1] ?? 0);
  // The adapter reports only a token total, so approximate an 80% prompt /
  // 20% completion split (extend the adapter to return split usage for precision).
  const promptTokens = Math.round(totalTokens * 0.8);
  const completionTokens = totalTokens - promptTokens;

  const price = prices.get(model) ?? { in: 0, out: 0 };
  const costUsd = promptTokens * price.in + completionTokens * price.out;

  await rm(dir, { recursive: true, force: true });

  return {
    model, taskId: task.id, rep,
    passed: verdict.passed, reason: verdict.reason,
    toolCalls, apiCalls, promptTokens, completionTokens, costUsd, durationMs,
    ...(infraError ? { infraError } : {}),
  };
}

// ---- CLI ----
export interface ModelSelectArgs {
  models: string[];
  tasks: BenchTask[];
  repeat: number;
  baseline: string;
  primary?: string;
}

const VALUE_FLAGS = new Set(['--model', '--task', '--repeat', '--baseline', '--primary']);

/**
 * Parse the CLI flags, failing closed: an unknown task id, a repeat that is not
 * a positive integer, a flag with no value, or a --primary outside the model
 * list throws instead of silently running a different (or empty) sweep.
 */
export function parseArgs(argv: readonly string[]): ModelSelectArgs {
  const models: string[] = [];
  const taskIds: string[] = [];
  let repeat = 3;
  let baseline = 'google/gemini-2.5-flash';
  let primary: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!VALUE_FLAGS.has(flag)) {
      // An unknown token (a typo, or the --flag=value form) would otherwise be
      // dropped and the bench would fall back to the full paid default sweep.
      throw new Error(`modelSelect: unknown argument "${flag}"`);
    }
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`modelSelect: ${flag} needs a value`);
    }
    i++;
    if (flag === '--model') models.push(value);
    else if (flag === '--task') taskIds.push(value);
    else if (flag === '--baseline') baseline = value;
    else if (flag === '--primary') primary = value;
    else if (flag === '--repeat') {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`modelSelect: --repeat must be a positive integer, got "${value}"`);
      }
      repeat = Number(value);
    }
  }

  const known = new Set(CODING_TASKS.map((t) => t.id));
  const unknown = taskIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`modelSelect: unknown task id(s): ${unknown.join(', ')}`);
  }

  const effectiveModels = models.length ? models : [...DEFAULT_CANDIDATES];
  if (primary !== undefined && !effectiveModels.includes(primary)) {
    throw new Error(`modelSelect: --primary ${primary} is not in the model list (${effectiveModels.join(', ')})`);
  }

  return {
    models: effectiveModels,
    tasks: taskIds.length ? CODING_TASKS.filter((t) => taskIds.includes(t.id)) : CODING_TASKS,
    repeat, baseline, primary,
  };
}

async function main(): Promise<void> {
  // Validate the flags before anything touches the network or the .env.
  const { models, tasks, repeat, baseline, primary } = parseArgs(process.argv.slice(2));

  loadEnvFile();
  initLocale('en');
  setDefaultAdapter('openrouter');

  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not set (checked shell env and .env).');
    process.exit(1);
  }

  console.log(`[bench] models=${models.length} tasks=${tasks.length} repeat=${repeat}${primary ? ` primary=${primary}` : ''}`);
  console.log(`[bench] total runs = ${models.length * tasks.length * repeat}`);

  const prices = await fetchPrices(apiKey);

  // Models run in parallel; each uses its own temp repo, so they never collide.
  // Within one model the task x repeat runs are serial to stay under that
  // model's rate limit. The first infrastructure failure stops every model.
  const results = await runSweep(models, tasks, repeat,
    (task, model, rep) => runOne(task, model, rep, prices),
    (r) => {
      const mark = r.infraError ? '⛔' : r.passed ? '✅' : '❌';
      const why = r.infraError ? `INFRA: ${r.infraError}` : r.reason;
      console.log(`  ${mark} ${r.model.padEnd(24)} ${r.taskId.padEnd(24)} rep${r.rep}  ${fmtUsd(r.costUsd)} ${r.toolCalls}tc ${(r.durationMs / 1000).toFixed(0)}s  ${why}`);
    });

  const summary = summarizeRun(results, baseline, primary);
  if (!summary.ok) {
    // No ranking, and results/latest.json keeps the last valid run.
    console.error(summary.text);
    process.exit(2);
  }
  console.log(summary.text);

  // Fixed file name: each run overwrites latest.json.
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'latest.json');
  await writeFile(outPath, JSON.stringify({ results, aggs: summary.aggs, baseline, primary }, null, 2));
  console.log(`\n[bench] raw results → ${outPath}`);
}

/**
 * True when `moduleUrl` is the script node/tsx was asked to run. Both sides go
 * through realpath so a symlinked checkout or a relative argv[1] still matches.
 */
export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const real = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  try {
    return real(resolve(argv1)) === real(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
}
