import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverVerifyCommands } from './discover.js';

const roots: string[] = [];

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
      { name: 'pytest', run: 'python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('prefers the repository verification virtualenv for pytest', async () => {
    const root = await fixture({
      'pytest.ini': '[pytest]\n',
      '.venv-verify/bin/python': '#!/bin/sh\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
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
      { name: 'pytest', run: './.venv/bin/python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
      { name: 'ruff', run: './.venv/bin/ruff check .', kind: 'lint', timeoutMs: 300_000 },
    ]);

    // No installed ruff: nothing is invented, even with a ruff config present.
    const withoutRuff = await fixture({ 'pytest.ini': '[pytest]\n', 'ruff.toml': 'line-length = 100\n' });
    expect((await discoverVerifyCommands(withoutRuff)).map((c) => c.name)).toEqual(['pytest']);
  });

  it('serializes an explicitly configured xdist pytest run for stable base comparison', async () => {
    const root = await fixture({
      'pytest.ini': '[pytest]\naddopts = --tb=short -n auto --dist loadgroup\n',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'pytest', run: 'python -m pytest -n 0 -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
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
