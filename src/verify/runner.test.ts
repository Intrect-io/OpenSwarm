import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { VerifyCommand } from './manifest.js';
import { makeBwrapOverlayProbe } from './verifySandbox.js';
import {
  CLONE_TIMEOUT_MS,
  gitTimeoutMsFor,
  runVerify,
  uvCacheOverlay,
} from './runner.js';

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function verify(run: string, timeoutMs = 2_000): VerifyCommand {
  return { name: 'fixture', run, kind: 'test', timeoutMs };
}

const uvAvailable = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;
const bwrapPath = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].find((path) => existsSync(path));
/** Whether this host's bwrap can overlay `cache` and write through it, probed the way the runner does. */
async function bwrapOverlayFor(cache: string): Promise<boolean> {
  if (process.platform !== 'linux' || !bwrapPath) return false;
  const scratch = await mkdtemp(join(tmpdir(), 'osw-overlay-probe-'));
  try {
    return makeBwrapOverlayProbe((executable, args) => spawnSync(executable, args, { encoding: 'utf8', timeout: 10_000 }))(
      bwrapPath, { cache, upper: join(scratch, 'upper'), work: join(scratch, 'work') },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openswarm-verify-runner-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'base\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'base');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('logs verify sandbox bytes and the live sandbox count at creation and cleanup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runVerify({ projectPath: repo, commands: [verify('true')], baseRef: 'HEAD', sandboxScratchRoot: root });
      // The lines are fire-and-forget (AGT-4801): verification never waits for a measurement.
      const usageLines = () => log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('[Verify] sandbox usage'));
      await vi.waitFor(() => expect(usageLines()).toHaveLength(2), { timeout: 10_000 });
      const lines = usageLines();
      expect(lines[0]).toMatch(/phase=create bytes=\d+ live=1/);
      expect(lines[1]).toMatch(/phase=remove bytes=\d+ live=1/);
    } finally {
      log.mockRestore();
    }
  });

  it('routes strict verification through the companion and keeps scratch checkouts under its allowed root', async () => {
    const canonicalScratchRoot = await realpath(root);
    const execute = vi.fn(async () => ({
      output: 'companion-pass', exitCode: 0, signal: null, timedOut: false,
      truncated: false, outputLimitExceeded: false,
    }));
    const createSession = vi.fn(async (workspace: string) => {
      expect(workspace.startsWith(`${canonicalScratchRoot}/.openswarm-verify-head-`)).toBe(true);
      return { execute };
    });

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf must-not-run-in-main-container')],
      baseRef: 'HEAD',
      sandboxExecutorSessionFactory: createSession,
      sandboxScratchRoot: root,
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toBe('companion-pass');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('must-not-run-in-main-container'), 2_000);
  });

  it('applies the host worker budget to deterministic JavaScript verification', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    git('add', 'package.json');
    git('commit', '-m', 'add test script');
    const execute = vi.fn(async () => ({
      output: 'pass', exitCode: 0, signal: null, timedOut: false,
      truncated: false, outputLimitExceeded: false,
    }));

    await runVerify({
      projectPath: repo,
      commands: [verify('npm test')],
      baseRef: 'HEAD',
      sandboxExecutorSessionFactory: async () => ({ execute }),
      sandboxScratchRoot: root,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/export OPENSWARM_TEST_PARALLELISM=\d+ .* && npm test -- --maxWorkers=\d+$/),
      2_000,
    );
  });

  it('uses the host uv cache in offline mode inside the sandbox', async () => {
    // Real OS sandbox: the host cache is readable through a throwaway overlay with
    // offline copy mode set, and nothing written to it reaches the host (#817 review).
    const originalHome = process.env.HOME;
    const cacheHome = join(root, 'cache-home');
    const uvCache = join(cacheHome, '.cache', 'uv');
    await mkdir(uvCache, { recursive: true });
    await writeFile(join(uvCache, 'seed'), 'host-wheel\n');
    const realCache = await realpath(uvCache);
    process.env.HOME = cacheHome;
    try {
      const [evidence] = await runVerify({
        projectPath: repo,
        commands: [verify([
          'printf "cache=%s offline=%s link=%s\\n" "$UV_CACHE_DIR" "$UV_OFFLINE" "$UV_LINK_MODE"',
          'cat "$UV_CACHE_DIR/seed" 2>/dev/null',
          'echo planted > "$UV_CACHE_DIR/planted" 2>/dev/null',
          'echo poisoned > "$UV_CACHE_DIR/seed" 2>/dev/null',
          'exit 0',
        ].join('; '), 10_000)],
        baseRef: 'HEAD',
      });
      if (await bwrapOverlayFor(realCache)) {
        expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
        expect(evidence.rawOutputTail).toContain(`cache=${realCache} offline=1 link=copy`);
        expect(evidence.rawOutputTail).toContain('host-wheel');
      } else if (evidence.headStatus === 'pass') {
        // No overlay: the host cache is not exposed at all and uv keeps its isolated empty cache.
        expect(evidence.rawOutputTail).toContain('cache= offline= link=');
      }
      expect(await readFile(join(uvCache, 'seed'), 'utf8')).toBe('host-wheel\n');
      expect(existsSync(join(uvCache, 'planted'))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('does not point the strict executor at the host uv cache', async () => {
    const originalHome = process.env.HOME;
    const cacheHome = join(root, 'cache-home');
    await mkdir(join(cacheHome, '.cache', 'uv'), { recursive: true });
    process.env.HOME = cacheHome;
    const execute = vi.fn(async (_script: string) => ({
      output: 'head: 2 passed', exitCode: 0, signal: null, timedOut: false,
      truncated: false, outputLimitExceeded: false,
    }));
    try {
      await runVerify({
        projectPath: repo,
        commands: [verify('uv run --frozen python -m pytest -q')],
        baseRef: 'HEAD',
        sandboxExecutorSessionFactory: async () => ({ execute }),
        sandboxScratchRoot: root,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).not.toMatch(/UV_CACHE_DIR|UV_OFFLINE/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it.skipIf(!uvAvailable)('runs a uv-locked pytest fixture for base and head in the real network-denied sandbox', async () => {
    const fixture = join(root, 'uv-fixture');
    const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'pyproject.toml'), [
      '[project]', 'name = "verify-uv-fixture"', 'version = "0.1.0"',
      'requires-python = ">=3.11"', 'dependencies = ["pytest==8.4.2"]', '',
    ].join('\n'));
    await writeFile(join(fixture, 'test_sample.py'), [
      'import socket',
      'def test_head_only():',
      '    assert True',
      'def test_network_is_denied():',
      '    with socket.socket() as sock:',
      '        sock.settimeout(0.5)',
      '        try:',
      '            sock.connect(("1.1.1.1", 443))',
      '        except OSError:',
      '            return',
      '        assert False, "network unexpectedly reachable"',
      '',
    ].join('\n'));
    execFileSync('uv', ['lock'], { cwd: fixture, stdio: 'pipe' });
    execFileSync('uv', ['sync', '--frozen'], { cwd: fixture, stdio: 'pipe' });
    await rm(join(fixture, '.venv'), { recursive: true, force: true });
    execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'pipe' });
    execFileSync('git', ['-C', fixture, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', fixture, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', fixture, 'add', '-A']);
    execFileSync('git', ['-C', fixture, 'commit', '-m', 'base fixture']);
    await writeFile(join(fixture, 'test_sample.py'), [
      'import socket',
      'def test_head_only():',
      '    assert False',
      'def test_network_is_denied():',
      '    with socket.socket() as sock:',
      '        sock.settimeout(0.5)',
      '        try:',
      '            sock.connect(("1.1.1.1", 443))',
      '        except OSError:',
      '            return',
      '        assert False, "network unexpectedly reachable"',
      '',
    ].join('\n'));

    const [evidence] = await runVerify({
      projectPath: fixture,
      commands: [verify(`${uv} run --frozen python -m pytest -q`, 30_000)],
      baseRef: 'HEAD',
    });

    expect(evidence.baseStatus, evidence.rawOutputTail).toBe('pass');
    expect(evidence.headStatus, evidence.rawOutputTail).toBe('fail');
    expect(evidence.newFailure).toBe(true);
    expect(evidence.rawOutputTail).toMatch(/2 passed/);
    expect(evidence.rawOutputTail).toMatch(/1 failed/);

    const originalHome = process.env.HOME;
    const emptyHome = join(root, 'empty-cache-home');
    await mkdir(join(emptyHome, '.cache', 'uv'), { recursive: true });
    process.env.HOME = emptyHome;
    try {
      const [coldCache] = await runVerify({
        projectPath: fixture,
        commands: [verify(`${uv} run --frozen python -m pytest -q`, 30_000)],
        baseRef: 'HEAD',
      });
      expect(coldCache, coldCache.rawOutputTail).toMatchObject({
        baseStatus: 'fail', headStatus: 'fail', newFailure: false, environmentFailure: true,
      });
      expect(coldCache.rawOutputTail).toMatch(/offline|cache|download/i);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  }, 120_000);

  it('reports an offline uv cache miss as an environment failure rather than a pass', async () => {
    const execute = vi.fn(async () => ({
      output: 'error: Failed to download package: cache miss while offline',
      exitCode: 2, signal: null, timedOut: false, truncated: false, outputLimitExceeded: false,
    }));
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('uv run --frozen python -m pytest -q')],
      baseRef: 'HEAD',
      sandboxExecutorSessionFactory: async () => ({ execute }),
      sandboxScratchRoot: root,
    });

    expect(evidence).toMatchObject({
      baseStatus: 'fail', headStatus: 'fail', newFailure: false, environmentFailure: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the strict companion cannot attest instead of falling back to host execution', async () => {
    const createSession = vi.fn(async () => {
      throw new Error('socket unavailable');
    });
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf host-fallback-would-pass')],
      baseRef: 'HEAD',
      sandboxExecutorSessionFactory: createSession,
      sandboxScratchRoot: root,
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] strict verification sandbox unavailable: socket unavailable');
    expect(evidence.rawOutputTail).not.toContain('host-fallback-would-pass');
  });

  it('skips the base worktree when head passes', async () => {
    const [evidence] = await runVerify({ projectPath: repo, commands: [verify('printf head-pass')], baseRef: 'HEAD' });
    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('head-pass');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('openswarm-verify-base-');
  });

  // cgf-portal 2026-09-17 (AGT-4407): a fresh worktree has no virtualenv, so
  // `python -m pytest` died with the same ModuleNotFoundError at base and head.
  // "Same failure → not new" was right; "→ tester passed" was not. The evidence
  // now names the toolchain failure so the tester can refuse the vacuous pass.
  it('flags a head failure caused by a missing toolchain as an environment failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('python3 -c "import openswarm_definitely_missing_module_xyz"', 10_000)],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
    expect(evidence.rawOutputTail).toMatch(/ModuleNotFoundError: No module named/);
  });

  it('treats a uv cache/network failure inside the sandbox as an environment failure, not a verdict', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "error: Failed to initialize cache at /nowhere/.cache/uv\\n"; exit 2')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
  });

  it('is not a new failure when both sides fail on the environment with different words (AX-1542)', async () => {
    // `$$` differs between the base and head sandboxes, as uv's first failed
    // download did — the fingerprints must not decide this case.
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "error: Failed to download pkg-$$\\n"; exit 2')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
    const [baseTail, headTail] = evidence.rawOutputTail.split('[head]');
    expect(baseTail).not.toBe(headTail);
  });

  it('recognises the uv offline cache-miss banner as an environment failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "  \\303\\227 Failed to download \\`pygments==2.21.0\\`\\n"; exit 2')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
  });

  it('recognises a uv error line that has other text in front of it', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "[setup] error: Failed to download pkg\\n"; exit 2')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
  });

  it('recognises a colourised uv error line as an environment failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "\\033[1m\\033[31merror\\033[0m: Failed to fetch: https://pypi.org/simple/x\\n"; exit 2')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false, environmentFailure: true });
  });

  it('never mounts a uv cache overlay through a pre-existing entry in the sandbox root', async () => {
    const cacheHome = join(root, 'cache-home');
    await mkdir(join(cacheHome, '.cache', 'uv'), { recursive: true });
    const sandboxRoot = join(root, 'sandbox');
    const outside = join(root, 'outside');
    await mkdir(join(sandboxRoot, 'uv-cache'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(sandboxRoot, 'uv-cache', 'upper'));
    expect(await uvCacheOverlay({ HOME: cacheHome }, sandboxRoot)).toBeUndefined();
    expect(await readdir(outside)).toEqual([]);

    const fresh = join(root, 'fresh');
    await mkdir(fresh);
    const overlay = await uvCacheOverlay({ HOME: cacheHome }, fresh);
    if (process.platform === 'linux') {
      expect(overlay).toEqual({
        cache: await realpath(join(cacheHome, '.cache', 'uv')),
        upper: join(fresh, 'uv-cache', 'upper'), work: join(fresh, 'uv-cache', 'work'),
      });
    } else {
      expect(overlay).toBeUndefined();
    }
  });

  it('does not read a test failure that mentions "Failed to fetch" as a uv environment failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "TypeError: Failed to fetch\\nError: Failed to download report\\nAssertionError: Failed to sync\\n"; exit 1')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
    expect(evidence.environmentFailure).toBeUndefined();
  });

  it('does not mark an ordinary head failure as an environment failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf assertion-failed; exit 1')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
    expect(evidence.environmentFailure).toBeUndefined();
  });

  it('does not expose supervisor secrets or the supervisor home to verification code', async () => {
    const originalSecret = process.env.OPENSWARM_VERIFY_SECRET;
    process.env.OPENSWARM_VERIFY_SECRET = 'must-not-leak';
    try {
      const [evidence] = await runVerify({
        projectPath: repo,
        commands: [verify('test -z "$OPENSWARM_VERIFY_SECRET"; test "$HOME" != "' + process.env.HOME + '"')],
        baseRef: 'HEAD',
      });
      expect(evidence.headStatus).toBe('pass');
    } finally {
      if (originalSecret === undefined) delete process.env.OPENSWARM_VERIFY_SECRET;
      else process.env.OPENSWARM_VERIFY_SECRET = originalSecret;
    }
  });

  it('permits VEGA test fixtures only within the disposable verification checkout', async () => {
    await mkdir(join(repo, 'pipeline'), { recursive: true });
    await writeFile(join(repo, 'pipeline', 'path_guard.py'), '# VEGA path policy marker\n');
    git('add', 'pipeline/path_guard.py');
    git('commit', '-m', 'VEGA path policy marker');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test "$VEGA_EXTRA_PATHS" = "$VEGA_CWD"; test "$VEGA_HEADLESS" = 1; test -d "$VEGA_EXTRA_PATHS"')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
  });

  it('runs each verification command from a fresh HEAD sandbox', async () => {
    const evidence = await runVerify({
      projectPath: repo,
      commands: [verify('touch leaked-artifact'), verify('test ! -e leaked-artifact')],
      baseRef: 'HEAD',
    });
    expect(evidence.map((item) => item.headStatus)).toEqual(['pass', 'pass']);
  });

  it.each(['node_modules', '.venv'])('does not write through shared %s during head verification', async (sharedPath) => {
    await mkdir(join(repo, sharedPath), { recursive: true });
    await writeFile(join(repo, sharedPath, 'state.txt'), 'original\n');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify(`printf sandbox > ${sharedPath}/state.txt`)],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped' });
    expect(await readFile(join(repo, sharedPath, 'state.txt'), 'utf8')).toBe('original\n');
  });

  it('does not write through shared dependencies during failed-check base comparison', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'state.txt'), 'original\n');
    await writeFile(join(repo, 'broken'), 'yes\n');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf sandbox > node_modules/state.txt; test ! -f broken')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
    expect(await readFile(join(repo, 'node_modules', 'state.txt'), 'utf8')).toBe('original\n');
  });

  it('rejects a worker-created symlink that could write outside the verification sandbox', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'original\n');
    await symlink(outside, join(repo, 'escape'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf mutated > escape')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('rejects escaping symlink');
    expect(await readFile(outside, 'utf8')).toBe('original\n');
  });

  it('ignores pytest temporary links left by a preserved worker worktree', async () => {
    const outside = join(root, 'pytest-output');
    await mkdir(join(repo, 'pytest-of-openswarm', 'pytest-10'), { recursive: true });
    await writeFile(outside, 'not a verification input\n');
    await symlink(outside, join(repo, 'pytest-of-openswarm', 'pytest-current'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf verified')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('verified');
  });

  it('ignores root-level pytest fixture symlinks while retaining normal link containment', async () => {
    const outside = join(root, 'fixture-output');
    await mkdir(join(repo, 'int3304_sortsym__p1mb7w0'), { recursive: true });
    await writeFile(outside, 'not a verification input\n');
    await symlink(outside, join(repo, 'int3304_sortsym__p1mb7w0', 'mlink_to_dir'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf verified')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('verified');
  });

  it('ignores task-scoped OpenSwarm pytest quarantine links', async () => {
    const outside = join(root, 'pytest-output');
    const quarantine = join(repo, '.openswarm-trash', 'AGT-3533-pytest-123');
    await mkdir(quarantine, { recursive: true });
    await writeFile(outside, 'not a verification input\n');
    await symlink(outside, join(quarantine, 'test-current'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf verified')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('verified');
  });

  it('allows a relative symlink whose target remains inside the repository sandbox', async () => {
    await writeFile(join(repo, 'target.txt'), 'original\n');
    await symlink('target.txt', join(repo, 'inside-link'));
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf sandbox > inside-link')],
      baseRef: 'HEAD',
    });
    expect(evidence.headStatus).toBe('pass');
    expect(await readFile(join(repo, 'target.txt'), 'utf8')).toBe('original\n');
  });

  it('marks a head failure over a passing base as new', async () => {
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('if [ -f broken ]; then echo broken >&2; exit 1; fi')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[head]\nbroken');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('openswarm-verify-base-');
  });

  it('reuses head-local executable dependencies in the detached base worktree', async () => {
    const bin = join(repo, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'verify-fixture');
    await writeFile(executable, '#!/bin/sh\nif [ -f broken ]; then exit 1; fi\n', 'utf8');
    await chmod(executable, 0o755);
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('PATH="$PWD/node_modules/.bin:$PATH" verify-fixture')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
  });

  it('runs npm package scripts against head-installed node_modules at base', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: { test: 'verify-fixture' },
    }), 'utf8');
    git('add', 'package.json');
    git('commit', '-m', 'base package script');
    const bin = join(repo, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'verify-fixture');
    await writeFile(executable, '#!/bin/sh\nif [ -f broken ]; then exit 1; fi\n', 'utf8');
    await chmod(executable, 0o755);
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('npm test --silent')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
  }, 120_000);

  it('preserves trusted npm lifecycle scripts and restores the worker package', async () => {
    const trustedPackageJson = JSON.stringify({
      scripts: {
        pretest: 'echo trusted-pre',
        test: 'node -e "console.log(require(\'./package.json\').workerMetadata)"',
        posttest: 'echo trusted-post',
      },
    });
    await writeFile(join(repo, 'package.json'), trustedPackageJson, 'utf8');
    git('add', 'package.json');
    git('commit', '-m', 'trusted npm scripts');
    const weakenedPackageJson = JSON.stringify({ workerMetadata: 'current-metadata', scripts: { test: 'true' } });
    await writeFile(join(repo, 'package.json'), weakenedPackageJson, 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('npm test --silent')],
      baseRef: 'HEAD',
      trustedPackageJsonByDirectory: { '': trustedPackageJson },
    });

    expect(evidence.rawOutputTail).toContain('trusted-pre');
    expect(evidence.rawOutputTail).toContain('current-metadata');
    expect(evidence.rawOutputTail).toContain('trusted-post');
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(weakenedPackageJson);
  });

  it('pins scripts for a nested command cwd without mutating the source tree', async () => {
    const packageDir = join(repo, 'packages', 'api');
    await mkdir(packageDir, { recursive: true });
    const trusted = JSON.stringify({ scripts: { test: 'echo nested-trusted' } });
    await writeFile(join(packageDir, 'package.json'), trusted);
    git('add', 'packages/api/package.json');
    git('commit', '-m', 'trusted nested package');
    const weakened = JSON.stringify({ workerMetadata: true, scripts: { test: 'true' } });
    await writeFile(join(packageDir, 'package.json'), weakened);

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD',
      trustedPackageJsonByDirectory: { 'packages/api': trusted },
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
    expect(evidence.rawOutputTail).toContain('nested-trusted');
    expect(await readFile(join(packageDir, 'package.json'), 'utf8')).toBe(weakened);
  });

  it('fails closed when a closer package manifest appears after plan capture', async () => {
    const trustedRoot = JSON.stringify({ scripts: { test: 'echo trusted-root' } });
    await writeFile(join(repo, 'package.json'), trustedRoot);
    git('add', 'package.json');
    git('commit', '-m', 'trusted root package');
    await mkdir(join(repo, 'packages', 'api'), { recursive: true });
    await writeFile(join(repo, 'packages', 'api', 'package.json'), '{"scripts":{"test":"true"}}');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD', trustedPackageJsonByDirectory: { '': trustedRoot },
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] verify package resolution changed');
  });

  it('fails closed when the trusted plan had no package and one is later added', async () => {
    await mkdir(join(repo, 'packages', 'api'), { recursive: true });
    git('add', 'packages');
    await writeFile(join(repo, 'packages', 'api', '.keep'), 'tracked');
    git('add', 'packages/api/.keep');
    git('commit', '-m', 'package cwd without manifest');
    await writeFile(join(repo, 'packages', 'api', 'package.json'), '{"scripts":{"test":"true"}}');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD', trustedPackageJsonByDirectory: {},
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] verify package resolution changed');
  });

  it('fails closed when the captured nearest package manifest is deleted', async () => {
    const packageDir = join(repo, 'packages', 'api');
    await mkdir(packageDir, { recursive: true });
    const trusted = JSON.stringify({ scripts: { test: 'echo trusted' } });
    await writeFile(join(packageDir, 'package.json'), trusted);
    git('add', 'packages/api/package.json');
    git('commit', '-m', 'trusted nested package');
    await unlink(join(packageDir, 'package.json'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD', trustedPackageJsonByDirectory: { 'packages/api': trusted },
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
  });

  // The two tests below are the only ones that run real Git *inside* the sandbox,
  // which makes them 4-7x heavier than the rest of this file (~1.4s vs ~0.2s
  // measured in isolation). At the old 5s ceiling that left a 3.6x margin, and
  // under full-suite parallel load they intermittently blew through it. A timeout
  // surfaces as headStatus 'infra' — errorClassification treats "timeout after" as
  // infrastructure — so the failure read as a broken sandbox rather than a slow
  // one. The ceiling is a hang guard, not a performance assertion.
  //
  // It must stay clearly BELOW vitest's own testTimeout (30s, vitest.config.ts).
  // runVerify starts this timer only after building the sandbox, so a ceiling at
  // the harness limit would let vitest kill the test first and report a generic
  // suite timeout — losing the headStatus and rawOutputTail this guard exists to
  // produce, which is the same unexplained failure in different clothing. 15s
  // leaves ~7x margin over the 2.1s measured under load and half the budget spare
  // for sandbox setup and teardown. (INT-3104)
  const SANDBOX_GIT_TIMEOUT_MS = 15_000;

  it('preserves Git metadata inside the isolated head sandbox', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('git rev-parse --is-inside-work-tree && git diff --check', SANDBOX_GIT_TIMEOUT_MS)],
      baseRef: 'HEAD',
    });
    // Surface the sandbox output on failure: an 'infra' result is otherwise a bare
    // status with no clue whether the sandbox broke or merely ran out of time.
    expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
    expect(evidence.newFailure).toBe(false);
    expect(evidence.rawOutputTail).toContain('true');
  }, 120_000);

  it('does not share the Git index when the source is a linked worktree', async () => {
    const linked = join(root, 'linked');
    git('worktree', 'add', '-q', '-b', 'linked-fixture', linked, 'HEAD');
    const before = execFileSync('git', ['-C', linked, 'status', '--porcelain=v1'], { encoding: 'utf8' });

    const [evidence] = await runVerify({
      projectPath: linked,
      commands: [verify('printf sandbox > README.md; git add README.md', SANDBOX_GIT_TIMEOUT_MS)],
      baseRef: 'HEAD',
    });

    expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
    expect(execFileSync('git', ['-C', linked, 'status', '--porcelain=v1'], { encoding: 'utf8' })).toBe(before);
    expect(await readFile(join(linked, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('mirrors tracked deletions and renames into the head sandbox', async () => {
    await writeFile(join(repo, 'old-name.txt'), 'tracked\n');
    git('add', 'old-name.txt');
    git('commit', '-m', 'tracked file');
    await unlink(join(repo, 'old-name.txt'));
    await writeFile(join(repo, 'new-name.txt'), 'tracked\n');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test ! -e old-name.txt && test -e new-name.txt')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
  });

  it('keeps a failure that also exists at base non-blocking', async () => {
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');
    git('add', 'broken');
    git('commit', '-m', 'pre-existing failure');
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test ! -f broken')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  });

  it('normalizes isolated worktree paths when comparing the same failure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('printf "%s\\npre-existing failure\\n" "$PWD"; exit 1')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  });

  it('compares failure fingerprints independently of stdout chunk boundaries', async () => {
    await writeFile(join(repo, 'split-output'), 'yes\n');
    const command = 'if [ -f split-output ]; then printf abc; sleep 0.05; printf def; else printf abcdef; fi; exit 1';

    const [evidence] = await runVerify({ projectPath: repo, commands: [verify(command)], baseRef: 'HEAD' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  });

  it('marks an additional head failure as new when base already fails', async () => {
    await writeFile(join(repo, 'existing-failure'), 'yes\n', 'utf8');
    git('add', 'existing-failure');
    git('commit', '-m', 'pre-existing failure');
    await writeFile(join(repo, 'new-failure'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('for file in existing-failure new-failure; do if [ -f "$file" ]; then echo "$file" >&2; failed=1; fi; done; test -z "$failed"')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[base]\nexisting-failure');
    expect(evidence.rawOutputTail).toContain('[head]\nexisting-failure\nnew-failure');
  });

  it('uses the full output fingerprint when unique failure text precedes the visible tail', async () => {
    await writeFile(join(repo, 'existing-failure'), 'yes\n', 'utf8');
    git('add', 'existing-failure');
    git('commit', '-m', 'pre-existing long failure');
    await writeFile(join(repo, 'new-failure'), 'yes\n', 'utf8');
    const command = "if [ -f new-failure ]; then echo head-only-failure; fi; printf '%09000d' 0; exit 1";

    const [evidence] = await runVerify({ projectPath: repo, commands: [verify(command)], baseRef: 'HEAD' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
    expect(evidence.rawOutputTail).not.toContain('head-only-failure');
  });

  it('does not waive matching failures when dependency inputs changed', async () => {
    await mkdir(join(repo, 'packages', 'app'), { recursive: true });
    await writeFile(join(repo, 'packages', 'app', 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}', 'utf8');
    git('add', 'packages/app/package.json');
    git('commit', '-m', 'base dependency');
    await writeFile(join(repo, 'packages', 'app', 'package.json'), '{"dependencies":{"fixture":"2.0.0"}}', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('echo same-failure; exit 1'), cwd: 'packages/app' }],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
  });

  it('waives the same pre-existing missing environment dependency after a manifest change', async () => {
    await writeFile(join(repo, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
    git('add', 'pyproject.toml');
    git('commit', '-m', 'base python manifest');
    await writeFile(join(repo, 'pyproject.toml'), '[project]\nname = "fixture"\nversion = "1"\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify("printf '%s\\nModuleNotFoundError: No module named '\"'\"'slack_bolt'\"'\"'\\n' \"$PWD\"; exit 1")],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  });

  it.each(['Cargo.toml', 'go.mod'])('invalidates baseline failures when %s changes', async (name) => {
    await writeFile(join(repo, name), 'base\n', 'utf8');
    git('add', name);
    git('commit', '-m', `base ${name}`);
    await writeFile(join(repo, name), 'changed\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo, commands: [verify('echo same-failure; exit 1')], baseRef: 'HEAD',
    });
    expect(evidence.newFailure).toBe(true);
  });

  it('detects an untracked nested dependency manifest', async () => {
    await mkdir(join(repo, 'packages', 'new-app'), { recursive: true });
    await writeFile(join(repo, 'packages', 'new-app', 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}');

    const [evidence] = await runVerify({
      projectPath: repo, commands: [verify('echo same-failure; exit 1')], baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ baseStatus: 'fail', headStatus: 'fail', newFailure: true });
  });

  it('classifies command-not-found as infrastructure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('definitely-not-an-openswarm-command')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'infra', baseStatus: 'skipped', newFailure: false });
  });

  it('fails closed when a verify cwd symlink escapes the project', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repo, 'escape'));
    const command = { ...verify('echo escaped'), cwd: 'escape' };

    const [evidence] = await runVerify({ projectPath: repo, commands: [command], baseRef: 'HEAD' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] verify sandbox rejects escaping symlink');
  });

  it('allows a tracked dangling symlink whose target remains inside the project', async () => {
    await symlink('generated/pkg', join(repo, 'pkg'));
    git('add', 'pkg');
    git('commit', '-m', 'track internal build output link');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test -L pkg')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
  });

  it('classifies a timeout as infrastructure', async () => {
    const started = Date.now();
    const [evidence] = await runVerify({ projectPath: repo, commands: [verify('sleep 1', 20)], baseRef: 'HEAD' });
    expect(evidence).toMatchObject({ headStatus: 'infra', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('timeout after 20ms');
    expect(Date.now() - started).toBeLessThan(500);
  }, 120_000);

  it('caps combined stdout and stderr to the last 8KB', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify("printf '%09000d' 0; printf tail-marker >&2")],
      baseRef: 'HEAD',
    });
    expect(Buffer.byteLength(evidence.rawOutputTail)).toBeLessThanOrEqual(8 * 1024);
    expect(evidence.rawOutputTail).toContain('tail-marker');
  });
});

describe('head sandbox disk footprint (AGT-4785)', () => {
  const sandboxEntries = async () => (await readdir(root)).filter((name) => name.startsWith('.openswarm-verify-'));

  it('head sandbox clone does not copy pack files', async () => {
    // ~2 MB of incompressible history, packed, so a full object copy would show.
    await writeFile(join(repo, 'blob.bin'), randomBytes(2 * 1024 * 1024));
    git('add', 'blob.bin');
    git('commit', '-m', 'large history');
    git('gc', '--quiet');
    const sourceKb = Number(execFileSync('du', ['-sk', join(repo, '.git')], { encoding: 'utf8' }).split('\t')[0]);
    // Runs inside the OS sandbox: alternates are readable there, but never writable.
    const probe = [
      'alt="$(cat .git/objects/info/alternates)"', 'test -d "$alt"', 'git cat-file -e HEAD:blob.bin',
      'test -z "$(find .git -name "*.pack")"', '! touch "$alt/osw-write-probe" 2>/dev/null',
      'echo "clone-kb=$(du -sk .git | cut -f1)"',
    ].join(' && ');
    const [evidence] = await runVerify({ projectPath: repo, commands: [verify(probe, 15_000)], baseRef: 'HEAD', sandboxScratchRoot: root });
    expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
    const cloneKb = Number(/clone-kb=(\d+)/.exec(evidence.rawOutputTail)?.[1]);
    expect(cloneKb).toBeLessThan(sourceKb / 4);
    expect(existsSync(join(repo, '.git', 'objects', 'osw-write-probe'))).toBe(false);
    expect(await sandboxEntries()).toEqual([]);
  }, 60_000);

  it('removes the head sandbox on success, failure and throw', async () => {
    const run = (command: string) => runVerify({ projectPath: repo, commands: [verify(command)], baseRef: 'HEAD', sandboxScratchRoot: root });
    expect((await run('true'))[0].headStatus).toBe('pass');
    expect(await sandboxEntries()).toEqual([]);
    expect((await run('false'))[0].headStatus).toBe('fail');
    expect(await sandboxEntries()).toEqual([]);
    // An unreadable source file makes the working-tree copy throw after the clone exists.
    await writeFile(join(repo, 'unreadable.txt'), 'secret\n');
    await chmod(join(repo, 'unreadable.txt'), 0o000);
    await expect(run('true')).rejects.toThrow(/EACCES|permission/i);
    expect(await sandboxEntries()).toEqual([]);
  });
});

describe('git timeout budgets (AGT-4416)', () => {
  it('gives the sandbox clone ten minutes and every other git call the 30 s default', () => {
    expect(CLONE_TIMEOUT_MS).toBe(10 * 60_000);
    expect(gitTimeoutMsFor(['clone', '--quiet', '--no-hardlinks', '--no-checkout', '/src', '/dst'])).toBe(CLONE_TIMEOUT_MS);
    for (const args of [['rev-parse', 'HEAD'], ['checkout', '--quiet', '--detach', 'abc'], ['worktree', 'add', '--detach', '/x', 'abc'], ['merge-base', 'HEAD', 'main']]) {
      expect(gitTimeoutMsFor(args)).toBe(30_000);
    }
  });
});
