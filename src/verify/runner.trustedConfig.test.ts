// Round-1 redteam A-F2 (2026-11-03): verification read the test-runner config
// from the change under test, so a change could exclude its own failing test.
// The head sandbox now runs with the base revision's config.

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyCommand } from './manifest.js';
import { runVerify } from './runner.js';
import { isPinnedTestConfig } from './trustedConfig.js';

let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const check = (run: string): VerifyCommand => ({ name: 'tests', run, kind: 'test', timeoutMs: 10_000 });

// Stands in for a test runner: the "suite" fails when the code is broken,
// unless the config excludes the failing test.
const RUNNER = (config: string) =>
  `if grep -q broken src/value.txt && ! grep -q 'exclude-bad' ${config}; then echo 'FAIL bad.test'; exit 1; fi; echo 'all passed'`;

async function commitBase(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries({ 'src/value.txt': 'ok\n', ...files })) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content, 'utf8');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trusted-config-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('trusted test-runner config', () => {
  it('a head-only exclude in vitest.config cannot turn a failing check green', async () => {
    await commitBase({ 'vitest.config.ts': 'export default { test: { exclude: [] } };\n' });
    // The change breaks the code and, committed alongside, excludes the test that notices.
    await writeFile(join(repo, 'src/value.txt'), 'broken\n');
    await writeFile(join(repo, 'vitest.config.ts'), "export default { test: { exclude: ['exclude-bad'] } };\n");
    git('commit', '-q', '-am', 'break and hide');

    const [evidence] = await runVerify({ projectPath: repo, commands: [check(RUNNER('vitest.config.ts'))], baseRef: 'main' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
    expect(evidence.rawOutputTail).toContain('FAIL bad.test');
    // The live checkout keeps the change's own file; only the sandbox was pinned.
    expect(git('show', 'HEAD:vitest.config.ts')).toContain('exclude-bad');
  });

  it('a head-only conftest.py change cannot turn a failing check green', async () => {
    await commitBase({ 'tests/conftest.py': 'collect_ignore = []\n' });
    // Uncommitted, as a worker leaves it.
    await writeFile(join(repo, 'src/value.txt'), 'broken\n');
    await writeFile(join(repo, 'tests/conftest.py'), "collect_ignore = ['exclude-bad']\n");

    const [evidence] = await runVerify({ projectPath: repo, commands: [check(RUNNER('tests/conftest.py'))], baseRef: 'main' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
  });

  it('fails closed on a test-runner config the base never had', async () => {
    await commitBase({});
    await writeFile(join(repo, 'src/value.txt'), 'broken\n');
    await writeFile(join(repo, 'conftest.py'), "collect_ignore = ['exclude-bad']\n");

    const [evidence] = await runVerify({ projectPath: repo, commands: [check(RUNNER('conftest.py'))], baseRef: 'main' });

    expect(evidence).toMatchObject({ headStatus: 'fail', newFailure: true, securityFailure: true });
    expect(evidence.rawOutputTail).toContain('conftest.py (a test-runner config the base revision does not have)');
  });

  it('fails closed when pyproject test settings change, not when only dependencies do', async () => {
    const pyproject = (deps: string, pytest: string) =>
      `[project]\nname = "x"\ndependencies = [${deps}]\n\n[tool.pytest.ini_options]\naddopts = "${pytest}"\n`;
    await commitBase({ 'pyproject.toml': pyproject('"a"', '-q') });

    await writeFile(join(repo, 'pyproject.toml'), pyproject('"a", "b"', '-q'));
    const [depsOnly] = await runVerify({ projectPath: repo, commands: [check('echo ok')], baseRef: 'main' });
    expect(depsOnly).toMatchObject({ headStatus: 'pass', newFailure: false });

    await writeFile(join(repo, 'pyproject.toml'), pyproject('"a"', '-q --deselect tests/test_bad.py'));
    const [testSettings] = await runVerify({ projectPath: repo, commands: [check('echo ok')], baseRef: 'main' });
    expect(testSettings).toMatchObject({ securityFailure: true, newFailure: true });
    expect(testSettings.rawOutputTail).toContain('pyproject.toml (its test/coverage settings changed)');
  });

  it('leaves an untouched config and ordinary files alone', async () => {
    await commitBase({ 'vitest.config.ts': "export default { test: { exclude: ['exclude-bad'] } };\n" });
    await writeFile(join(repo, 'src/value.txt'), 'broken\n');

    const [evidence] = await runVerify({ projectPath: repo, commands: [check(RUNNER('vitest.config.ts'))], baseRef: 'main' });

    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
    expect(isPinnedTestConfig('a/b/conftest.py')).toBe(true);
    expect(isPinnedTestConfig('src/config.ts')).toBe(false);
  });
});
