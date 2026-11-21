// Created: 2026-11-22
// Purpose: Pin the wiring of benchmarks/sweBench.ts (AGT-3179, AGT-3185):
//          importing it starts no run, main() prints the grading command built
//          by sweBenchGrading.ts, resolves the dataset before any solve, and
//          keeps the per-run mkdtemp output directory. The worker, adapters,
//          env loading and every child process (docker, git) are mocked, so no
//          test reaches a model, docker or the network.
// Dependencies: vitest, benchmarks/sweBench.ts, benchmarks/sweBenchVerifiedSet.ts
// Test Status: passing
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COHORT_IDS } from '../benchmarks/sweBenchVerifiedSet.js';

const mocks = vi.hoisted(() => ({
  runWorker: vi.fn(),
  loadEnvFile: vi.fn(),
  initLocale: vi.fn(),
  setDefaultAdapter: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../src/agents/worker.js', () => ({ runWorker: mocks.runWorker }));
vi.mock('../src/core/envFile.js', () => ({ loadEnvFile: mocks.loadEnvFile }));
vi.mock('../src/locale/index.js', () => ({ initLocale: mocks.initLocale }));
vi.mock('../src/adapters/index.js', () => ({ setDefaultAdapter: mocks.setDefaultAdapter }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOLVE_ENV = ['SWE_DIAG_MODEL', 'SWE_DIAG_FILE', 'SWE_VERBOSE'] as const;

type ExecCallback = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

let work: string;
let logs: string[];
let savedEnv: Partial<Record<(typeof SOLVE_ENV)[number], string>>;
const cleanup: string[] = [];

beforeEach(() => {
  vi.resetModules();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.runWorker.mockResolvedValue({ filesChanged: ['src/fix.py'], output: '', summary: '' });
  // Stand-in for docker and git: every call succeeds; rev-parse and diff return fixed output.
  mocks.execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
    const stdout = cmd === 'git' && args[0] === 'rev-parse' ? 'base\n' : cmd === 'git' && args[0] === 'diff' ? 'diff --git a/x b/x\n' : '';
    cb(null, { stdout, stderr: '' });
  });
  savedEnv = {};
  for (const key of SOLVE_ENV) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  work = mkdtempSync(join(tmpdir(), 'swe-entry-test-'));
  cleanup.push(work);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of SOLVE_ENV) if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeInstances(ids: readonly string[]): string {
  const file = join(work, 'instances.json');
  writeFileSync(file, JSON.stringify(ids.map((id) => ({
    instance_id: id, repo: 'owner/repo', base_commit: 'abc', problem_statement: 'bug', FAIL_TO_PASS: '["tests/test_x.py::test_y"]',
  }))));
  return file;
}

/** The grading command main() printed, as tokens (line continuations removed). */
function printedCommand(): string[] {
  const start = logs.findIndex((l) => l.includes('swebench.harness.run_evaluation'));
  expect(start).toBeGreaterThanOrEqual(0);
  return logs.slice(start).map((l) => l.replace(/ \\$/, '').trim()).join(' ').split(/\s+/);
}

const valueAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

async function loadMain() {
  return (await import('../benchmarks/sweBench.js')).main;
}

describe('sweBench.ts entry point', () => {
  it('does not start a run when imported', async () => {
    await import('../benchmarks/sweBench.js');
    await new Promise((r) => setImmediate(r));
    expect(mocks.loadEnvFile).not.toHaveBeenCalled();
    expect(mocks.setDefaultAdapter).not.toHaveBeenCalled();
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('prints the Verified grading command when every id is in the cohort', async () => {
    const main = await loadMain();
    const ids = [COHORT_IDS[0], COHORT_IDS[15], COHORT_IDS[29]];
    const out = join(work, 'preds.json');
    await main(['node', 'sweBench.ts', writeInstances(ids), out], {});

    const argv = printedCommand();
    expect(valueAfter(argv, '--dataset_name')).toBe('SWE-bench/SWE-bench_Verified');
    expect(valueAfter(argv, '--predictions_path')).toBe(out);
    expect(argv.slice(argv.indexOf('--instance_ids') + 1, argv.indexOf('--instance_ids') + 4)).toEqual(ids);
    expect(valueAfter(argv, '--max_workers')).toBe('1');
    expect(valueAfter(argv, '--cache_level')).toBe('instance');
    expect(logs.join('\n')).toContain('inferred from the instance ids');

    // Predictions carry the unchanged default model.
    const preds = JSON.parse(readFileSync(out, 'utf-8'));
    expect(preds).toHaveLength(3);
    expect(preds[0]).toMatchObject({ instance_id: ids[0], model_name_or_path: 'openswarm+deepseek__deepseek-v4-flash' });
    expect(mocks.runWorker).toHaveBeenCalledTimes(3);
    expect(mocks.runWorker.mock.calls[0][0]).toMatchObject({ model: 'deepseek/deepseek-v4-flash', webTools: false });
  });

  it('prints the Lite grading command when any id is outside the cohort', async () => {
    const main = await loadMain();
    await main(['node', 'sweBench.ts', writeInstances([COHORT_IDS[0], 'pylint-dev__pylint-5859']), join(work, 'p.json')], {});
    expect(valueAfter(printedCommand(), '--dataset_name')).toBe('SWE-bench/SWE-bench_Lite');
  });

  it('honours an allowlisted SWE_DATASET', async () => {
    const main = await loadMain();
    await main(['node', 'sweBench.ts', writeInstances(['pylint-dev__pylint-5859']), join(work, 'p.json')], { SWE_DATASET: 'SWE-bench/SWE-bench_Verified' });
    expect(valueAfter(printedCommand(), '--dataset_name')).toBe('SWE-bench/SWE-bench_Verified');
    expect(logs.join('\n')).toContain('from SWE_DATASET');
  });

  it('refuses an invalid SWE_DATASET before solving anything', async () => {
    const main = await loadMain();
    const out = join(work, 'p.json');
    await expect(main(['node', 'sweBench.ts', writeInstances([COHORT_IDS[0]]), out], { SWE_DATASET: 'princeton-nlp/SWE-bench' }))
      .rejects.toThrow(/SWE_DATASET must be one of/);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('run_evaluation'))).toBe(false);
  });

  it('writes predictions to a fresh per-run mkdtemp directory when no output path is given', async () => {
    const main = await loadMain();
    const file = writeInstances([COHORT_IDS[0]]);
    const predsPaths: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      logs.length = 0;
      await main(['node', 'sweBench.ts', file], {});
      const path = valueAfter(printedCommand(), '--predictions_path');
      cleanup.push(dirname(path));
      predsPaths.push(path);
    }
    for (const path of predsPaths) {
      expect(basename(path)).toBe('predictions.json');
      expect(basename(dirname(path))).toMatch(/^swe-preds-/);
      expect(dirname(dirname(path))).toBe(tmpdir());
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveLength(1);
    }
    expect(dirname(predsPaths[0])).not.toBe(dirname(predsPaths[1]));
  });

  it('no longer hardcodes the Lite dataset in its printed command', () => {
    const source = readFileSync(join(ROOT, 'benchmarks', 'sweBench.ts'), 'utf-8');
    expect(source).not.toContain('SWE-bench_Lite');
    expect(source).not.toContain('--dataset_name');
    expect(source).toMatch(/buildGradeCommand\(/);
    expect(source).toMatch(/resolveDataset\(/);
    expect(source).toContain("mkdtemp(join(tmpdir(), 'swe-preds-'))");
    expect(source).toMatch(/if \(isDirectRun\(import\.meta\.url, process\.argv\[1\]\)\)/);
  });
});
