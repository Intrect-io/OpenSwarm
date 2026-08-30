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
});
