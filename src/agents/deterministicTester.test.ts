import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureVerifyInputFingerprint,
  loadTrustedVerifyPlan,
  runDeterministicTester,
  runTesterWithVerification,
  withDiscoveredTimeout,
} from './deterministicTester.js';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';
import { configureSandboxExecutor, resetSandboxExecutorForTests } from '../sandboxExecutor/runtime.js';
import { DEFAULT_SANDBOX_EXECUTOR_LIMITS } from '../sandboxExecutor/protocol.js';

let root: string | undefined;

afterEach(async () => {
  resetHumanSurfaceReadOnlyForTests();
  resetSandboxExecutorForTests();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// cgf-portal's suite takes 272 s calm and 295 s with two verifications at once, and the
// generic 300 s for a discovered command lost both verdicts (AGT-4678). The configured value
// is for what the verifier discovers; a repository's own manifest keeps its own timeout.
describe('timeout of discovered verification commands (AGT-4678)', () => {
  const verify = (extra: Record<string, unknown> = {}) => ({ enabled: true, blockOnNewFailures: true, maxCommands: 4, ...extra });

  async function discoveredRepo(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-timeout-'));
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
    return root;
  }

  it('gives a discovered command the configured timeout', async () => {
    const plan = await loadTrustedVerifyPlan(await discoveredRepo(), verify({ commandTimeoutMs: 600_000 }));
    expect(plan.commands.length).toBeGreaterThan(0);
    expect(plan.commands.every((command) => command.timeoutMs === 600_000)).toBe(true);
  });

  it('keeps the 300 s default when nothing is configured', async () => {
    const plan = await loadTrustedVerifyPlan(await discoveredRepo(), verify());
    expect(plan.commands.length).toBeGreaterThan(0);
    expect(plan.commands.every((command) => command.timeoutMs === 300_000)).toBe(true);
  });

  it('leaves a manifest-declared command at the timeout its repository declared', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-timeout-manifest-'));
    await mkdir(join(root, '.openswarm'));
    await writeFile(join(root, '.openswarm', 'verify.yaml'), [
      'version: 1', 'commands:', '  - name: unit', '    run: npm test', '    kind: test', '    timeoutMs: 120000',
    ].join('\n'));
    const plan = await loadTrustedVerifyPlan(root, verify({ commandTimeoutMs: 600_000 }));
    expect(plan.commands.map((command) => command.timeoutMs)).toEqual([120_000]);
  });

  it('withDiscoveredTimeout does not mutate its input and ignores an unset value', () => {
    const input = [{ name: 'pytest', run: 'pytest', kind: 'test' as const, timeoutMs: 300_000 }];
    expect(withDiscoveredTimeout(input, 600_000)[0].timeoutMs).toBe(600_000);
    expect(input[0].timeoutMs).toBe(300_000);
    expect(withDiscoveredTimeout(input, undefined)).toBe(input);
  });
});

describe('deterministic verification trust inputs', () => {
  it('allows ordinary package script mutation because discovered bodies are pinned separately', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
    const initial = await captureVerifyInputFingerprint(root);
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"true"}}');
    expect(await captureVerifyInputFingerprint(root)).toBe(initial);

  });

  it('detects explicit manifest mutation independently', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await mkdir(join(root, '.openswarm'));
    const initial = await captureVerifyInputFingerprint(root);
    await writeFile(join(root, '.openswarm', 'verify.yaml'), 'version: 1\ncommands: []\n');
    expect(await captureVerifyInputFingerprint(root)).not.toBe(initial);
  });

  it('fails closed without invoking fallback when trusted inputs change', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    const trustedInputFingerprint = await captureVerifyInputFingerprint(root);
    await mkdir(join(root, '.openswarm'));
    await writeFile(join(root, '.openswarm', 'verify.yaml'), 'version: 1\ncommands: []\n');
    const fallback = vi.fn();

    await expect(runTesterWithVerification({
      projectPath: root,
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
      trustedInputFingerprint,
      fallback,
    })).rejects.toThrow('verification inputs changed after worker execution');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('captures the nearest package manifest for each command cwd', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await mkdir(join(root, 'packages', 'api'), { recursive: true });
    await mkdir(join(root, '.openswarm'));
    const nestedPackage = '{"scripts":{"test":"vitest"}}';
    await writeFile(join(root, 'packages', 'api', 'package.json'), nestedPackage);
    await writeFile(join(root, '.openswarm', 'verify.yaml'), [
      'version: 1', 'commands:', '  - name: api', '    run: npm test',
      '    kind: test', '    cwd: packages/api',
    ].join('\n'));

    const plan = await loadTrustedVerifyPlan(root, { enabled: true, blockOnNewFailures: true, maxCommands: 4 });
    expect(plan.packageJsonByDirectory).toEqual({ 'packages/api': nestedPackage });
  });

  it('refuses to pass when the only verdict is a toolchain that could not run (AGT-4407)', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-unrunnable-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'pipe' });
    // The base ref is origin/<default>; give the fixture a remote so the base
    // run really executes instead of failing to resolve (which is its own,
    // already-handled infra path).
    execFileSync('git', ['clone', '--bare', '-q', repo, join(root, 'origin.git')], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', join(root, 'origin.git')]);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin'], { stdio: 'pipe' });

    // Same ModuleNotFoundError at base and head — before AGT-4407 this returned
    // success: true with zero tests run (cgf-portal's 3-second green tester).
    await expect(runDeterministicTester(
      repo,
      { enabled: true, blockOnNewFailures: true, maxCommands: 1 },
      [{ name: 'pytest', run: 'python3 -c "import openswarm_definitely_missing_module_xyz"', kind: 'test', timeoutMs: 10_000 }],
    )).rejects.toThrow(/verify-runner: pytest could not run in this checkout/);
  });

  it('still refuses when base and head fail on the environment with different words (AX-1542)', async () => {
    // Live 2026-09-18: uv's first failed download was `jiter` at base and
    // `fastapi` at head, the fingerprints differed, and a checkout that could
    // not run anything was reported as "a blocking new failure" — the task
    // burned three attempts on it. Not a verdict: fall back to the LLM tester.
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-unrunnable-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'pipe' });
    execFileSync('git', ['clone', '--bare', '-q', repo, join(root, 'origin.git')], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', join(root, 'origin.git')]);
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin'], { stdio: 'pipe' });

    await expect(runDeterministicTester(
      repo,
      { enabled: true, blockOnNewFailures: true, maxCommands: 1 },
      [{ name: 'pytest', run: 'printf "error: Failed to download pkg-$$\\n"; exit 2', kind: 'test', timeoutMs: 10_000 }],
    )).rejects.toThrow(/verify-runner: pytest could not run in this checkout/);
  });

  it('keeps strict companion failures blocking when ordinary test regressions are non-blocking', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-strict-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'pipe' });
    enableHumanSurfaceReadOnly();
    configureSandboxExecutor({
      ...DEFAULT_SANDBOX_EXECUTOR_LIMITS,
      socketPath: join(root, 'missing.sock'),
      allowedRoots: [root],
      connectTimeoutMs: 50,
    });

    await expect(runDeterministicTester(
      repo,
      { enabled: true, blockOnNewFailures: false, maxCommands: 1 },
      [{ name: 'strict-check', run: 'printf host-fallback-would-pass', kind: 'test', timeoutMs: 1_000 }],
    )).rejects.toThrow(/verify-security:.*strict-check.*sandbox unavailable/);
  });

  it('uses the companion for verify-security even when humanSurfaceReadOnly is off', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-companion-no-hsr-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'pipe' });
    configureSandboxExecutor({
      ...DEFAULT_SANDBOX_EXECUTOR_LIMITS,
      socketPath: join(root, 'missing.sock'),
      allowedRoots: [root],
      connectTimeoutMs: 50,
    });

    await expect(runDeterministicTester(
      repo,
      { enabled: true, blockOnNewFailures: false, maxCommands: 1 },
      [{ name: 'typecheck', run: 'printf host-bwrap-would-fail', kind: 'lint', timeoutMs: 1_000 }],
    )).rejects.toThrow(/verify-security: typecheck could not run inside the attested companion/);
  });
});

describe('llmFallback (AGT-4679)', () => {
  const verify = { enabled: true, blockOnNewFailures: true, maxCommands: 4 };

  it('does not ask the LLM tester when it is disabled and no deterministic command exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-nollm-'));
    const fallback = vi.fn();
    const result = await runTesterWithVerification({ projectPath: root, verify, llmFallback: false, fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, testsPassed: 0, testsFailed: 0, deterministic: false });
    expect(result.output).toMatch(/nothing was verified/);
  });

  it('keeps the LLM tester as the fallback by default', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-llm-'));
    const fallback = vi.fn().mockResolvedValue({ success: true, testsPassed: 1, testsFailed: 0, output: 'LLM tester' });
    const result = await runTesterWithVerification({ projectPath: root, verify, fallback });
    expect(fallback).toHaveBeenCalledOnce();
    expect(result.output).toBe('LLM tester');
  });
});
