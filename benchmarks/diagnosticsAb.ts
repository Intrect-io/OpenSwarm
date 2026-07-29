#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Inline diagnostics tool A/B (INT-3105)
// Created: 2026-07-29
// Purpose: Measure whether exposing the `diagnostics` tool (project tsc inside
//          the agentic loop) improves edit success on cross-file contract
//          tasks — the LSP-hypothesis spike. Each task is a temp TypeScript
//          mini-repo where the correct change requires updating every caller /
//          construction site; missing one leaves the project uncompilable, so
//          success is deterministic: `tsc --noEmit` clean + task assertions.
//
//          Arms differ ONLY in the tool schema exposure (same prompt, model,
//          tool budget): control = today's toolset (bash included, so the model
//          COULD run tsc itself), diag = + `diagnostics` tool.
//
// RESULT (2026-07-29, N=48: glm-4.7-flash + gpt-5-mini × nudge on/off × 3 tasks
// × 2 seeds): control 19/24 vs diag 20/24 — no measurable success uplift; the
// hypothesis was rejected and the tool stays opt-in-only. Spontaneous tool use
// is model-dependent (glm: every run; mini: rare). Raw records in
// benchmarks/results/diagnosticsAb-2026-07-29*.json. (INT-3105)
//
// 실행:
//   npx tsx benchmarks/diagnosticsAb.ts                          # atlas-cloud pinned, z-ai/glm-4.7, 2 seeds
//   npx tsx benchmarks/diagnosticsAb.ts --provider any --model openai/gpt-5-mini
//   npx tsx benchmarks/diagnosticsAb.ts --task rename-function --nudge off
//   (OPENROUTER_API_KEY from .env; default provider pin = atlas-cloud sponsorship credits)
// ============================================

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { OpenRouterCliAdapter } from '../src/adapters/openrouter.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { runPool } from '../src/support/concurrencyPool.js';

const execFileAsync = promisify(execFile);

interface AbTask {
  name: string;
  files: Record<string, string>;
  prompt: string;
  /** Deterministic success beyond tsc-clean (tsc runs for every task). */
  assert: (read: (rel: string) => Promise<string>) => Promise<string | null>;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' },
  include: ['src'],
});

// Cross-file contract tasks. Callers are spread over several files (with decoy
// files) so a model that edits only what it greps first will miss one.
const TASKS: AbTask[] = [
  {
    name: 'add-required-field',
    files: {
      'src/types.ts': 'export interface Task {\n  id: string;\n  title: string;\n}\n',
      'src/create.ts': "import type { Task } from './types.js';\nexport function makeTask(id: string, title: string): Task {\n  return { id, title };\n}\n",
      'src/seed.ts': "import type { Task } from './types.js';\nexport const SEED_TASKS: Task[] = [\n  { id: '1', title: 'first' },\n  { id: '2', title: 'second' },\n];\n",
      'src/clone.ts': "import type { Task } from './types.js';\nexport function cloneTask(t: Task): Task {\n  return { id: t.id, title: t.title };\n}\n",
      'src/render.ts': "import type { Task } from './types.js';\nexport function renderTask(t: Task): string {\n  return `${t.id}: ${t.title}`;\n}\n",
    },
    prompt:
      'Add a required field `priority: number` to the `Task` interface in src/types.ts. ' +
      'Update every place that constructs a Task object so the project still type-checks; use priority 0 for existing data.',
    assert: async (read) => {
      // The field must be REQUIRED — `priority?: number` would keep tsc clean
      // while skipping every construction site, silently passing the task.
      const types = await read('src/types.ts');
      if (!/priority\s*:\s*number/.test(types) || /priority\s*\?\s*:/.test(types)) {
        return 'src/types.ts does not declare a required `priority: number`';
      }
      for (const rel of ['src/create.ts', 'src/seed.ts', 'src/clone.ts']) {
        if (!(await read(rel)).includes('priority')) return `${rel} still constructs Task without priority`;
      }
      return null;
    },
  },
  {
    name: 'rename-function',
    files: {
      'src/format.ts': "export function formatUser(name: string, age: number): string {\n  return `${name} (${age})`;\n}\nexport function formatDate(d: Date): string {\n  return d.toISOString();\n}\n",
      'src/report.ts': "import { formatUser } from './format.js';\nexport function report(names: Array<[string, number]>): string {\n  return names.map(([n, a]) => formatUser(n, a)).join('\\n');\n}\n",
      'src/banner.ts': "import { formatUser, formatDate } from './format.js';\nexport function banner(name: string, age: number): string {\n  return `== ${formatUser(name, age)} @ ${formatDate(new Date())} ==`;\n}\n",
      'src/audit.ts': "import { formatUser } from './format.js';\nexport const auditLine = (who: string): string => 'audit:' + formatUser(who, 0);\n",
      'src/util.ts': "export function formatBytes(n: number): string {\n  return `${n}B`;\n}\n",
    },
    prompt:
      'Rename the function `formatUser` in src/format.ts to `renderUser` and update every usage in the project. ' +
      'Do not leave any reference to the old name.',
    assert: async (read) => {
      for (const rel of ['src/format.ts', 'src/report.ts', 'src/banner.ts', 'src/audit.ts']) {
        const content = await read(rel);
        if (content.includes('formatUser')) return `${rel} still references formatUser`;
      }
      return null;
    },
  },
  {
    name: 'change-signature',
    files: {
      'src/math.ts': 'export function sum(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
      'src/stats.ts': "import { sum } from './math.js';\nexport function mean(items: number[]): number {\n  return items.length === 0 ? 0 : sum(items) / items.length;\n}\n",
      'src/invoice.ts': "import { sum } from './math.js';\nexport function invoiceTotal(lines: number[], shipping: number): number {\n  return sum(lines) + shipping;\n}\n",
      'src/cart.ts': "import { sum } from './math.js';\nexport const cartTotal = (prices: number[]): number => sum(prices);\n",
      'src/badge.ts': 'export function badge(label: string): string {\n  return `[${label}]`;\n}\n',
    },
    prompt:
      'Change `sum` in src/math.ts to `sum(items: number[], initial: number): number`, using `initial` as the reduce seed. ' +
      'Update every caller to pass 0 as the initial value.',
    assert: async (read) => {
      if (!(await read('src/math.ts')).includes('initial')) return 'src/math.ts signature not changed';
      for (const rel of ['src/stats.ts', 'src/invoice.ts', 'src/cart.ts']) {
        if (!/sum\([^)]*,\s*0\s*\)/.test(await read(rel))) return `${rel} caller not updated`;
      }
      return null;
    },
  },
];

interface RunRecord {
  task: string;
  arm: 'control' | 'diag';
  /** Repeat index only — no sampling seed is threaded to the API (temperature
   * is the adapter's fixed 0.2); repeats sample the model's own variance. */
  seed: number;
  success: boolean;
  failReason?: string;
  tscClean: boolean;
  /** Tool-loop API calls (`▸ API call #` log lines). The loop's final-answer
   * retries log differently and are not counted — identical in both arms, so
   * comparisons hold even though the absolute count can undercount by 1-2. */
  apiCalls: number;
  toolCalls: number;
  diagnosticsCalls: number;
  bashTscCalls: number;
  durationMs: number;
}

async function materialize(task: AbTask): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `osw-diag-ab-${task.name}-`));
  await writeFile(path.join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(task.files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

async function tscClean(dir: string): Promise<boolean> {
  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], { cwd: dir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function runOne(task: AbTask, arm: 'control' | 'diag', seed: number, model: string, nudge: boolean): Promise<RunRecord> {
  const dir = await materialize(task);
  const logs: string[] = [];
  const started = Date.now();
  try {
    const adapter = new OpenRouterCliAdapter();
    // Arm treatment: with --nudge on (default), both arms get the SAME generic
    // verify nudge (the control can run tsc via bash); the diag arm's prompt
    // ADDITIONALLY names the tool — the treatment is the productized bundle
    // (schema + affordance), not schema alone. With --nudge off, the prompts
    // are strictly identical and only the schema differs, isolating whether
    // mere exposure drives usage. Read the two modes together.
    const verifyNudge = 'After editing, verify the project still type-checks before finishing.';
    const systemPrompt = !nudge
      ? undefined
      : arm === 'diag'
        ? `${verifyNudge} Use the \`diagnostics\` tool with the files you changed.`
        : verifyNudge;
    const result = await adapter.run({
      prompt: task.prompt,
      cwd: dir,
      model,
      systemPrompt,
      maxTurns: 12,
      timeoutMs: 300_000,
      webTools: false,
      memoryTools: false,
      diagnosticsTool: arm === 'diag',
      onLog: (line) => logs.push(line),
    });
    // An adapter failure that resolves (nonzero exit, e.g. auth/HTTP error the
    // adapter didn't classify as infra) is an INFRA failure of the run, not a
    // task failure — throwing routes it to the pool's error channel so it
    // cannot deflate an arm's success rate.
    if (result.exitCode !== 0) {
      throw new Error(`adapter run failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    }
    const clean = await tscClean(dir);
    const read = (rel: string) => import('node:fs/promises').then((fs) => fs.readFile(path.join(dir, rel), 'utf8'));
    const assertFail = clean ? await task.assert(read) : 'tsc not clean';
    return {
      task: task.name,
      arm,
      seed,
      success: clean && assertFail === null,
      failReason: assertFail ?? undefined,
      tscClean: clean,
      apiCalls: logs.filter((l) => l.includes('▸ API call #')).length,
      toolCalls: logs.filter((l) => l.includes('🔧')).length,
      diagnosticsCalls: logs.filter((l) => l.includes('🔧 diagnostics')).length,
      bashTscCalls: logs.filter((l) => l.includes('🔧 bash') && l.includes('tsc')).length,
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function summarize(records: RunRecord[]): void {
  const arms: Array<'control' | 'diag'> = ['control', 'diag'];
  console.log('\n=== diagnostics A/B summary ===');
  for (const arm of arms) {
    const rs = records.filter((r) => r.arm === arm);
    const ok = rs.filter((r) => r.success).length;
    const avg = (f: (r: RunRecord) => number) => (rs.reduce((a, r) => a + f(r), 0) / Math.max(rs.length, 1)).toFixed(1);
    console.log(
      `${arm.padEnd(8)} success ${ok}/${rs.length} · avg api ${avg((r) => r.apiCalls)} · avg tools ${avg((r) => r.toolCalls)} ` +
        `· avg ms ${avg((r) => r.durationMs)} · diag calls ${rs.reduce((a, r) => a + r.diagnosticsCalls, 0)} ` +
        `· bash-tsc calls ${rs.reduce((a, r) => a + r.bashTscCalls, 0)}`,
    );
  }
  console.log('\nper-run:');
  for (const r of records) {
    console.log(
      `  ${r.task.padEnd(20)} ${r.arm.padEnd(8)} seed${r.seed} ${r.success ? '✓' : `✗ (${r.failReason})`} ` +
        `api=${r.apiCalls} tools=${r.toolCalls} diag=${r.diagnosticsCalls} bashTsc=${r.bashTscCalls} ${Math.round(r.durationMs / 1000)}s`,
    );
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.OPENROUTER_API_KEY?.trim() && !process.env.OPENROUTER_API?.trim()) {
    console.error('OPENROUTER_API_KEY is not set (.env or env).');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Default provider pin: Atlas Cloud (sponsorship credits) — `--provider any`
  // unpins, `--provider <slug>` pins elsewhere. The default model must be one
  // Atlas Cloud actually serves (glm-4.7, deepseek-v4-pro, kimi-k2.5, glm-5 as
  // of 2026-07-29); a pinned run with an unserved model fails with no provider.
  const provider = flag('provider') ?? 'atlas-cloud';
  if (provider !== 'any') process.env.OPENROUTER_PROVIDER_ONLY = provider;
  const model = flag('model') ?? (provider === 'atlas-cloud' ? 'z-ai/glm-4.7' : 'openai/gpt-5-mini');
  const seeds = Number(flag('seeds') ?? 2);
  const only = flag('task');
  const concurrency = Number(flag('concurrency') ?? 3);
  const nudge = flag('nudge') !== 'off';

  const tasks = only ? TASKS.filter((t) => t.name === only) : TASKS;
  if (tasks.length === 0) {
    console.error(`Unknown task "${only}". Available: ${TASKS.map((t) => t.name).join(', ')}`);
    process.exit(2);
  }

  const plan = tasks.flatMap((task) =>
    (['control', 'diag'] as const).flatMap((arm) =>
      Array.from({ length: seeds }, (_, seed) => ({ task, arm, seed })),
    ),
  );
  console.log(`diagnostics A/B: model=${model} provider=${provider} nudge=${nudge} runs=${plan.length} (tasks=${tasks.length} × arms=2 × seeds=${seeds})`);

  const settled = await runPool(plan, concurrency, async ({ task, arm, seed }) => {
    const record = await runOne(task, arm, seed, model, nudge);
    console.log(`done: ${record.task} ${record.arm} seed${record.seed} → ${record.success ? '✓' : '✗'}`);
    return record;
  });
  const records = settled
    .map((s) => s.value)
    .filter((r): r is RunRecord => Boolean(r));
  const failedRuns = settled.filter((s) => s.error);
  for (const f of failedRuns) {
    console.error(`run failed (infra): ${f.error instanceof Error ? f.error.message : String(f.error)}`);
  }

  summarize(records);
  const out = path.join('benchmarks', 'results', `diagnosticsAb-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify({ model, provider, seeds, nudge, records }, null, 2));
  console.log(`\nsaved: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
