#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Codex Spark Real-Work Benchmark
// ============================================
//
// Runs codex-responses models against isolated copies of this repository with
// real OpenSwarm regressions injected. The grader is the focused test suite, not
// a string heuristic, so this measures whether the worker can read, patch, and
// verify real harness code.
//
// Usage:
//   npx tsx benchmarks/codexSparkRealWork.ts --condition spark-low --condition spark-medium
//   npx tsx benchmarks/codexSparkRealWork.ts --task spark-sse --repeat 2 --keep

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../src/agents/worker.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import type { WorkerResult } from '../src/agents/agentPair.js';
import { safeConsole as console } from '../src/support/safeLog.js';

const exec = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'results');

interface BenchTask {
  id: string;
  title: string;
  description: string;
  inject: (repoDir: string) => Promise<void>;
  verify: (repoDir: string) => Promise<{ passed: boolean; reason: string; commands: string[] }>;
}

interface Condition {
  id: string;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  nudgeMaxOnNoEdit: number;
  maxTurns: number;
}

interface RunResult {
  conditionId: string;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  nudgeMaxOnNoEdit: number;
  taskId: string;
  rep: number;
  passed: boolean;
  reason: string;
  workerSuccess: boolean;
  workerSummary: string;
  filesChanged: string[];
  toolCalls: number;
  editCalls: number;
  apiCalls: number;
  totalTokens: number;
  cachedTokens: number;
  durationMs: number;
  verifyCommands: string[];
  tmpDir?: string;
}

const CONDITIONS: Condition[] = [
  {
    id: 'spark-low',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'low',
    nudgeMaxOnNoEdit: 3,
    maxTurns: 18,
  },
  {
    id: 'spark-medium',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'medium',
    nudgeMaxOnNoEdit: 3,
    maxTurns: 18,
  },
  {
    id: 'mini-low',
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low',
    nudgeMaxOnNoEdit: 3,
    maxTurns: 18,
  },
  {
    id: 'top-low',
    model: 'gpt-5.5',
    reasoningEffort: 'low',
    nudgeMaxOnNoEdit: 3,
    maxTurns: 18,
  },
];

const TASKS: BenchTask[] = [
  {
    id: 'fallback-persistence',
    title: 'Fix Codex Responses unsupported-model fallback persistence',
    description:
      'The focused codexResponses test suite is failing because unsupported-model fallback only changes the current request body. ' +
      'Fix the CodexResponsesAdapter so the effective fallback model persists across later tool-loop API turns. ' +
      'Read src/adapters/codexResponses.ts and src/adapters/codexResponses.test.ts, make the minimal code change, then run ' +
      '`npm test -- src/adapters/codexResponses.test.ts` and `npm run typecheck`.',
    inject: async (repoDir) => {
      const p = join(repoDir, 'src', 'adapters', 'codexResponses.ts');
      const text = await readFile(p, 'utf8');
      const broken = text.replace(/\n\s+effectiveModel = alt;\n\s+body\.model = alt;/, '\n              body.model = alt;');
      if (broken === text) throw new Error('fallback-persistence injection failed');
      await writeFile(p, broken, 'utf8');
    },
    verify: (repoDir) => verifyFocused(repoDir),
  },
  {
    id: 'spark-sse',
    title: 'Restore Spark Responses function-call SSE support',
    description:
      'The focused codexResponses tests are failing because Spark-shaped Responses function-call events are no longer reduced correctly. ' +
      'Restore support for function-call details arriving via response.output_item.done and argument done events. ' +
      'Read src/adapters/codexResponses.ts and src/adapters/codexResponses.test.ts, make the minimal fix, then run ' +
      '`npm test -- src/adapters/codexResponses.test.ts` and `npm run typecheck`.',
    inject: async (repoDir) => {
      const p = join(repoDir, 'src', 'adapters', 'codexResponses.ts');
      const text = await readFile(p, 'utf8');
      const broken = text
        .replace("      case 'response.output_item.added':\n      case 'response.output_item.done':", "      case 'response.output_item.added':")
        .replace('        const c = ev.item_id ? calls.get(ev.item_id) : getOnlyCall();\n        if (c && typeof ev.arguments === \'string\') c.args = ev.arguments;', '        const c = ev.item_id ? calls.get(ev.item_id) : undefined;\n        if (c && typeof ev.arguments === \'string\') c.args = ev.arguments;');
      if (broken === text) throw new Error('spark-sse injection failed');
      await writeFile(p, broken, 'utf8');
    },
    verify: (repoDir) => verifyFocused(repoDir),
  },
  {
    id: 'tool-strict-false',
    title: 'Restore strict:false on Codex Responses tools',
    description:
      'The focused codexResponses tests and typecheck are failing because the Responses tool transform no longer marks OpenSwarm tools as strict:false. ' +
      'Restore the flat Responses tool shape expected by the tests while keeping the permissive OpenSwarm schemas. ' +
      'Read src/adapters/codexResponses.ts and src/adapters/codexResponses.test.ts, make the minimal fix, then run ' +
      '`npm test -- src/adapters/codexResponses.test.ts` and `npm run typecheck`.',
    inject: async (repoDir) => {
      const p = join(repoDir, 'src', 'adapters', 'codexResponses.ts');
      const text = await readFile(p, 'utf8');
      const broken = text.replace(/\n\s+\/\/ OpenSwarm tools use permissive JSON schemas\.[\s\S]*?\n\s+strict: false,/, '');
      if (broken === text) throw new Error('tool-strict-false injection failed');
      await writeFile(p, broken, 'utf8');
    },
    verify: (repoDir) => verifyFocused(repoDir),
  },
];

function parseArgs(argv: string[]) {
  const conditionIds: string[] = [];
  const taskIds: string[] = [];
  let repeat = 1;
  let timeoutMs = 240_000;
  let keep = false;
  let out = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--condition') conditionIds.push(argv[++i]);
    else if (arg === '--task') taskIds.push(argv[++i]);
    else if (arg === '--repeat') repeat = Number(argv[++i]);
    else if (arg === '--timeout-ms') timeoutMs = Number(argv[++i]);
    else if (arg === '--keep') keep = true;
    else if (arg === '--out') out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  const conditions = conditionIds.length
    ? conditionIds.map((id) => {
        const found = CONDITIONS.find((c) => c.id === id);
        if (!found) throw new Error(`unknown condition: ${id}`);
        return found;
      })
    : CONDITIONS.filter((c) => ['spark-low', 'spark-medium', 'mini-low'].includes(c.id));

  const tasks = taskIds.length
    ? taskIds.map((id) => {
        const found = TASKS.find((t) => t.id === id);
        if (!found) throw new Error(`unknown task: ${id}`);
        return found;
      })
    : TASKS;

  return { conditions, tasks, repeat, timeoutMs, keep, out };
}

function printUsage(): void {
  console.log([
    'Usage: npx tsx benchmarks/codexSparkRealWork.ts [options]',
    '',
    'Options:',
    '  --condition <id>   Repeatable. spark-low, spark-medium, mini-low, top-low',
    '  --task <id>        Repeatable. fallback-persistence, spark-sse, tool-strict-false',
    '  --repeat <n>       Repetitions per condition/task (default 1)',
    '  --timeout-ms <n>   Worker timeout per run (default 240000)',
    '  --keep             Keep temp repos for inspection',
    '  --out <file>       Write JSON result path',
  ].join('\n'));
}

async function verifyFocused(repoDir: string): Promise<{ passed: boolean; reason: string; commands: string[] }> {
  const commands = ['npm test -- src/adapters/codexResponses.test.ts', 'npm run typecheck'];
  const test = await runCommand(repoDir, 'npm', ['test', '--', 'src/adapters/codexResponses.test.ts'], 120_000);
  if (!test.ok) return { passed: false, reason: `focused test failed: ${test.output.slice(0, 240)}`, commands };

  const typecheck = await runCommand(repoDir, 'npm', ['run', 'typecheck'], 120_000);
  if (!typecheck.ok) return { passed: false, reason: `typecheck failed: ${typecheck.output.slice(0, 240)}`, commands };

  return { passed: true, reason: 'focused test + typecheck passed', commands };
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const out = await exec(command, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: `${out.stdout}${out.stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

async function setupRepo(task: BenchTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-spark-real-'));

  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'vitest.setup.ts']) {
    await cp(join(ROOT, name), join(dir, name));
  }
  await cp(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });

  const rootNodeModules = join(ROOT, 'node_modules');
  if (existsSync(rootNodeModules)) {
    await symlink(rootNodeModules, join(dir, 'node_modules'), 'dir');
  }

  await task.inject(dir);
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'bench@local'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'bench'], { cwd: dir });
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '-qm', `bench fixture ${task.id}`], { cwd: dir });

  return dir;
}

async function runOne(
  condition: Condition,
  task: BenchTask,
  rep: number,
  timeoutMs: number,
  keep: boolean,
): Promise<RunResult> {
  const dir = await setupRepo(task);
  const logs: string[] = [];
  const started = Date.now();
  let worker: WorkerResult | undefined;
  let workerError = '';

  try {
    worker = await runWorker({
      taskTitle: task.title,
      taskDescription: task.description,
      projectPath: dir,
      adapterName: 'codex-responses',
      model: condition.model,
      reasoningEffort: condition.reasoningEffort,
      timeoutMs,
      maxTurns: condition.maxTurns,
      nudgeMaxOnNoEdit: condition.nudgeMaxOnNoEdit,
      webTools: false,
      memoryTools: false,
      suppressStatusLogs: true,
      onLog: (line) => logs.push(line),
    });
  } catch (err) {
    workerError = err instanceof Error ? err.message : String(err);
    logs.push(`FATAL: ${workerError}`);
  }

  const verify = await task.verify(dir);
  const durationMs = Date.now() - started;
  const filesChanged = await changedFiles(dir);

  const result: RunResult = {
    conditionId: condition.id,
    model: condition.model,
    reasoningEffort: condition.reasoningEffort,
    nudgeMaxOnNoEdit: condition.nudgeMaxOnNoEdit,
    taskId: task.id,
    rep,
    passed: verify.passed,
    reason: verify.passed ? verify.reason : `${verify.reason}${workerError ? `; worker error: ${workerError}` : ''}`,
    workerSuccess: Boolean(worker?.success),
    workerSummary: worker?.summary ?? workerError,
    filesChanged,
    toolCalls: logs.filter((line) => line.includes('🔧')).length,
    editCalls: logs.filter((line) => line.includes('🔧') && /edit_file|write_file|apply_patch/.test(line)).length,
    apiCalls: logs.filter((line) => line.includes('API call #')).length,
    totalTokens: parseLastTokenMetric(logs, /(\d+) tokens/),
    cachedTokens: parseLastTokenMetric(logs, /\((\d+) cached/),
    durationMs,
    verifyCommands: verify.commands,
    tmpDir: keep ? dir : undefined,
  };

  if (!keep) await rm(dir, { recursive: true, force: true });
  return result;
}

async function changedFiles(repoDir: string): Promise<string[]> {
  const out = await runCommand(repoDir, 'git', ['diff', '--name-only', 'HEAD'], 30_000);
  return out.output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseLastTokenMetric(logs: string[], pattern: RegExp): number {
  for (const line of [...logs].reverse()) {
    const match = line.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function summarize(results: RunResult[]): string {
  const byCondition = new Map<string, RunResult[]>();
  for (const result of results) {
    const items = byCondition.get(result.conditionId) ?? [];
    items.push(result);
    byCondition.set(result.conditionId, items);
  }

  const lines: string[] = [];
  lines.push('\n========== CODEX SPARK REAL-WORK BENCH ==========');
  lines.push('condition           pass   avg api  avg tools  avg edits  avg tok  avg cached  avg sec');
  for (const [condition, rows] of byCondition) {
    const pass = rows.filter((r) => r.passed).length;
    const avg = (f: (r: RunResult) => number) => rows.reduce((sum, row) => sum + f(row), 0) / rows.length;
    lines.push(
      `${condition.padEnd(18)} ` +
      `${`${pass}/${rows.length}`.padStart(5)} ` +
      `${avg((r) => r.apiCalls).toFixed(1).padStart(7)} ` +
      `${avg((r) => r.toolCalls).toFixed(1).padStart(10)} ` +
      `${avg((r) => r.editCalls).toFixed(1).padStart(9)} ` +
      `${Math.round(avg((r) => r.totalTokens)).toString().padStart(8)} ` +
      `${Math.round(avg((r) => r.cachedTokens)).toString().padStart(11)} ` +
      `${(avg((r) => r.durationMs) / 1000).toFixed(1).padStart(7)}`,
    );
  }

  lines.push('\nRuns:');
  for (const result of results) {
    const mark = result.passed ? '✅' : '❌';
    lines.push(
      `${mark} ${result.conditionId.padEnd(13)} ${result.taskId.padEnd(22)} rep${result.rep} ` +
      `${result.apiCalls}api ${result.toolCalls}tools ${result.editCalls}edits ` +
      `${result.totalTokens}tok ${(result.durationMs / 1000).toFixed(1)}s - ${result.reason}`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  loadEnvFile();
  initLocale('en');

  const { conditions, tasks, repeat, timeoutMs, keep, out } = parseArgs(process.argv.slice(2));
  console.log(`[spark-bench] conditions=${conditions.map((c) => c.id).join(',')} tasks=${tasks.map((t) => t.id).join(',')} repeat=${repeat}`);
  console.log(`[spark-bench] total runs=${conditions.length * tasks.length * repeat}`);

  const results: RunResult[] = [];
  for (const condition of conditions) {
    for (const task of tasks) {
      for (let rep = 1; rep <= repeat; rep += 1) {
        const result = await runOne(condition, task, rep, timeoutMs, keep);
        results.push(result);
        const mark = result.passed ? '✅' : '❌';
        console.log(
          `${mark} ${condition.id} ${task.id} rep${rep}: ` +
          `${result.apiCalls}api ${result.toolCalls}tools ${result.editCalls}edits ` +
          `${result.totalTokens}tok ${(result.durationMs / 1000).toFixed(1)}s - ${result.reason}`,
        );
      }
    }
  }

  const report = summarize(results);
  console.log(report);

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const outPath = out ? join(ROOT, out) : join(RESULTS_DIR, `codexSparkRealWork-${stamp}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = {
    createdAt: new Date().toISOString(),
    repo: '.',
    conditions,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title })),
    results,
    report,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(join(RESULTS_DIR, 'codexSparkRealWork-latest.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n[spark-bench] raw results -> ${relative(ROOT, outPath)}`);
  console.log(`[spark-bench] latest -> ${relative(ROOT, join(RESULTS_DIR, 'codexSparkRealWork-latest.json'))}`);

  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
