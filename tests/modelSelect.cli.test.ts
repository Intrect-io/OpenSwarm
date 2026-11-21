// Created: 2026-11-22
// Purpose: Tests for the model-selection bench entry (AGT-4186): parseArgs fails
//          closed, --primary must be in the model list, and importing the module
//          never starts a benchmark run.
// Dependencies: benchmarks/modelSelect.ts (worker, adapters, env loading and fetch are mocked)
// Test Status: passing
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runWorker, loadEnvFile, setDefaultAdapter } = vi.hoisted(() => ({
  runWorker: vi.fn(),
  loadEnvFile: vi.fn(),
  setDefaultAdapter: vi.fn(),
}));
vi.mock('../src/agents/worker.js', () => ({ runWorker }));
vi.mock('../src/core/envFile.js', () => ({ loadEnvFile }));
vi.mock('../src/adapters/index.js', () => ({ setDefaultAdapter }));

describe('modelSelect entry', () => {
  const realArgv = process.argv;
  const fetchStub = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    runWorker.mockReset();
    loadEnvFile.mockReset();
    setDefaultAdapter.mockReset();
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    process.argv = realArgv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('importing modelSelect does not start a benchmark run', async () => {
    // argv that parseArgs accepts, so a reverted guard would reach loadEnvFile.
    process.argv = [realArgv[0], join(tmpdir(), 'some-other-script.ts')];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const mod = await import('../benchmarks/modelSelect.js');
    await new Promise((r) => setTimeout(r, 20));

    expect(typeof mod.parseArgs).toBe('function');
    expect(loadEnvFile).not.toHaveBeenCalled();
    expect(setDefaultAdapter).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes('[bench]'))).toBe(false);
  });

  it('refuses an unknown task id, a bad repeat and a missing flag value', async () => {
    const { parseArgs } = await import('../benchmarks/modelSelect.js');
    expect(() => parseArgs(['--task', 'L0-fix-multiply', '--task', 'L9-nope'])).toThrow(/unknown task id\(s\): L9-nope/);
    for (const bad of ['0', '-1', '1.5', 'abc', '01']) {
      expect(() => parseArgs(['--repeat', bad])).toThrow(/--repeat must be a positive integer/);
    }
    expect(() => parseArgs(['--model'])).toThrow(/--model needs a value/);
    expect(() => parseArgs(['--model', '--task', 'L0-fix-multiply'])).toThrow(/--model needs a value/);
    expect(() => parseArgs(['--repeat'])).toThrow(/--repeat needs a value/);
    expect(() => parseArgs(['--primary'])).toThrow(/--primary needs a value/);
    // An unknown token or the --flag=value form must not fall back to the full default sweep.
    expect(() => parseArgs(['--task=L0-fix-multiply'])).toThrow(/unknown argument "--task=L0-fix-multiply"/);
    expect(() => parseArgs(['--repeat=1'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--models', 'x/a'])).toThrow(/unknown argument "--models"/);
  });

  it('accepts valid flags and keeps the defaults', async () => {
    const { parseArgs, DEFAULT_CANDIDATES } = await import('../benchmarks/modelSelect.js');
    const def = parseArgs([]);
    expect(def.models).toEqual(DEFAULT_CANDIDATES);
    expect(def.repeat).toBe(3);
    expect(def.baseline).toBe('google/gemini-2.5-flash');
    expect(def.primary).toBeUndefined();

    const a = parseArgs(['--model', 'x/a', '--model', 'x/b', '--task', 'L0-fix-multiply', '--repeat', '2', '--primary', 'x/a']);
    expect(a.models).toEqual(['x/a', 'x/b']);
    expect(a.tasks.map((t) => t.id)).toEqual(['L0-fix-multiply']);
    expect(a.repeat).toBe(2);
    expect(a.primary).toBe('x/a');
  });

  it('refuses a --primary that is not in the model list', async () => {
    const { parseArgs, DEFAULT_CANDIDATES } = await import('../benchmarks/modelSelect.js');
    expect(() => parseArgs(['--model', 'x/a', '--primary', 'x/zzz'])).toThrow(/--primary x\/zzz is not in the model list/);
    // Checked against the default list when no --model is given.
    expect(() => parseArgs(['--primary', 'x/zzz'])).toThrow(/not in the model list/);
    expect(parseArgs(['--primary', DEFAULT_CANDIDATES[2]]).primary).toBe(DEFAULT_CANDIDATES[2]);
  });

  it('isDirectRun matches the script path directly, through a symlink, and rejects others', async () => {
    const { isDirectRun } = await import('../benchmarks/modelSelect.js');
    const dir = mkdtempSync(join(tmpdir(), 'osw-modelselect-'));
    try {
      const file = join(dir, 'modelSelect.ts');
      writeFileSync(file, '');
      const link = join(dir, 'link.ts');
      symlinkSync(file, link);
      const url = pathToFileURL(file).href;
      expect(isDirectRun(url, file)).toBe(true);
      expect(isDirectRun(url, link)).toBe(true);
      expect(isDirectRun(pathToFileURL(link).href, file)).toBe(true);
      expect(isDirectRun(url, undefined)).toBe(false);
      expect(isDirectRun(url, join(dir, 'other.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
