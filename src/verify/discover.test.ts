import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverVerifyCommands } from './discover.js';

const roots: string[] = [];

const SYNTAX_RUN = "python3 -m compileall -q -x '(^|/)(\\.venv|\\.venv-verify|venv|node_modules|build|dist|\\.git)(/|$)' .";
/** The interpreter-only syntax gate discovery lists first for every pytest project (AGT-4407). */
function syntax(label = '', cwd?: string) {
  return { name: `syntax${label}`, run: SYNTAX_RUN, kind: 'lint' as const, timeoutMs: 300_000, ...(cwd ? { cwd } : {}) };
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-discover-'));
  roots.push(root);
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content, 'utf8');
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverVerifyCommands', () => {
  it('discovers Node typecheck and test scripts', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }) });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'typecheck', run: 'npm run typecheck', kind: 'typecheck', timeoutMs: 300_000 },
      { name: 'test', run: 'npm run test', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('uses only a repository-installed tsc and ignores the npm placeholder test', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'typecheck', run: './node_modules/.bin/tsc --noEmit', kind: 'typecheck', timeoutMs: 300_000 },
    ]);
  });

  it('does not download a compiler when tsconfig exists without a local tsc', async () => {
    const root = await fixture({ 'tsconfig.json': '{}' });
    expect(await discoverVerifyCommands(root)).toEqual([]);
  });

  it('surfaces filesystem read failures instead of silently disabling discovery', async () => {
    const root = await fixture({});
    await mkdir(join(root, 'package.json'));
    await expect(discoverVerifyCommands(root)).rejects.toThrow('Cannot read verification input');
  });

  it.each([
    ['pytest.ini', '[pytest]\n'],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n'],
    ['setup.cfg', '[tool:pytest]\naddopts = -q\n'],
  ])('discovers pytest from %s', async (name, content) => {
    const root = await fixture({ [name]: content });
    expect(await discoverVerifyCommands(root)).toEqual([
      syntax(),
      { name: 'pytest', run: 'python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('prefers the repository verification virtualenv for pytest', async () => {
    const root = await fixture({
      'pytest.ini': '[pytest]\n',
      '.venv-verify/bin/python': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      syntax(),
      { name: 'pytest', run: './.venv-verify/bin/python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  // vega-agent#608, 2026-09-02: a green pytest run published an undefined name
  // (F821) and 63 pyflakes errors; the repository's own CI runs ruff.
  it('adds a repository-installed ruff after pytest, and only then', async () => {
    const withRuff = await fixture({
      'pytest.ini': '[pytest]\n',
      '.venv/bin/python': '#!/bin/sh\n',
      '.venv/bin/ruff': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(withRuff)).toEqual([
      syntax(),
      { name: 'pytest', run: './.venv/bin/python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
      { name: 'ruff', run: './.venv/bin/ruff check .', kind: 'lint', timeoutMs: 300_000 },
    ]);

    // No installed ruff: nothing is invented, even with a ruff config present.
    const withoutRuff = await fixture({ 'pytest.ini': '[pytest]\n', 'ruff.toml': 'line-length = 100\n' });
    expect((await discoverVerifyCommands(withoutRuff)).map((c) => c.name)).toEqual(['syntax', 'pytest']);
  });

  // cgf-portal (2026-09-02): pyproject with pytest config at apps/pipelines,
  // nothing at the root. Discovery found nothing, the deterministic tester never
  // ran, and all 113 attempts that day fell through to the LLM tester.
  it('looks one level into workspace directories when the root has no Python project', async () => {
    const root = await fixture({
      'apps/pipelines/pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'apps/web/package.json': '{}',
      'packages/shared/pyproject.toml': '[project]\nname = "shared"\n',
      '.venv/bin/python': '#!/bin/sh\n',
      '.venv/bin/pytest': '#!/bin/sh\n',
      '.venv/bin/ruff': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      syntax(':apps/pipelines', 'apps/pipelines'),
      { name: 'pytest:apps/pipelines', run: '../../.venv/bin/python -m pytest -x -q', kind: 'test', timeoutMs: 300_000, cwd: 'apps/pipelines' },
      { name: 'ruff:apps/pipelines', run: '../../.venv/bin/ruff check .', kind: 'lint', timeoutMs: 300_000, cwd: 'apps/pipelines' },
    ]);
  });

  it('prefers a subproject virtualenv and stays at the root when the root is a Python project', async () => {
    const nested = await fixture({
      'apps/api/pytest.ini': '[pytest]\n',
      'apps/api/.venv/bin/python': '#!/bin/sh\n',
      'apps/api/.venv/bin/pytest': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(nested)).toEqual([
      syntax(':apps/api', 'apps/api'),
      { name: 'pytest:apps/api', run: './.venv/bin/python -m pytest -x -q', kind: 'test', timeoutMs: 300_000, cwd: 'apps/api' },
    ]);

    const rootProject = await fixture({
      'pytest.ini': '[pytest]\n',
      'apps/api/pytest.ini': '[pytest]\n',
    });
    expect((await discoverVerifyCommands(rootProject)).map((c) => c.name)).toEqual(['syntax', 'pytest']);
  });

  // cgf-portal's root .venv holds only an interpreter; running `python -m pytest`
  // with it fails identically on base and head, which the runner treats as a
  // pre-existing environment failure — a green tester with zero tests run.
  it('emits no subproject pytest when the chosen virtualenv cannot run pytest', async () => {
    const root = await fixture({
      'apps/pipelines/pyproject.toml': '[tool.pytest.ini_options]\n',
      '.venv/bin/python': '#!/bin/sh\n',
      '.venv/bin/ruff': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([]);
  });

  it('serializes an explicitly configured xdist pytest run for stable base comparison', async () => {
    const root = await fixture({
      'pytest.ini': '[pytest]\naddopts = --tb=short -n auto --dist loadgroup\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      syntax(),
      { name: 'pytest', run: 'python -m pytest -n 0 -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  // cgf-portal (2026-09-17, AGT-4407): a fresh worktree has no .venv (the
  // post-checkout hook never links it), so discovery fell back to the PATH
  // interpreter and `python -m pytest` failed identically at base and head —
  // a 3-second green tester with zero tests run, and a SyntaxError PR opened
  // as ready. With a uv.lock the repository's own runner is `uv run`.
  it('drives a locked uv project through `uv run --frozen` when no virtualenv exists', async () => {
    const root = await fixture({
      'apps/pipelines/pyproject.toml': '[project]\nname = "cgf-pipelines"\n[dependency-groups]\ndev = ["pytest>=8", "ruff>=0.5"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'apps/pipelines/uv.lock': 'version = 1\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      syntax(':apps/pipelines', 'apps/pipelines'),
      { name: 'pytest:apps/pipelines', run: 'uv run --frozen python -m pytest -x -q', kind: 'test', timeoutMs: 300_000, cwd: 'apps/pipelines' },
      { name: 'ruff:apps/pipelines', run: 'uv run --frozen ruff check .', kind: 'lint', timeoutMs: 300_000, cwd: 'apps/pipelines' },
    ]);

    // No ruff in the project's declared dependencies: none is invented.
    const noRuff = await fixture({
      'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\n',
      'uv.lock': 'version = 1\n',
    });
    expect((await discoverVerifyCommands(noRuff)).map((c) => c.run)).toEqual([SYNTAX_RUN, 'uv run --frozen python -m pytest -x -q']);
  });

  it('a repository virtualenv still wins over uv when both exist', async () => {
    const root = await fixture({
      'pytest.ini': '[pytest]\n',
      'uv.lock': 'version = 1\n',
      '.venv/bin/python': '#!/bin/sh\n',
    });
    expect((await discoverVerifyCommands(root)).map((c) => c.run)).toEqual([SYNTAX_RUN, './.venv/bin/python -m pytest -x -q']);
  });

  it('discovers Rust tests', async () => {
    const root = await fixture({ 'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n' });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'cargo test', run: 'cargo test --quiet', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('discovers Go tests', async () => {
    const root = await fixture({ 'go.mod': 'module example.test/demo\n' });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'go test', run: 'go test ./...', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('returns an empty list for an empty repository', async () => {
    expect(await discoverVerifyCommands(await fixture({}))).toEqual([]);
  });

  it('discovers this OpenSwarm checkout without executing commands', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const commands = await discoverVerifyCommands(repo);
    expect(commands.map((item) => item.run)).toEqual(expect.arrayContaining(['npm run typecheck', 'npm run test']));
  });
});
