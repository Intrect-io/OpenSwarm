import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runVerify } from './runner.js';

let root: string;
let repo: string;
function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-verify-environment-')));
  repo = join(root, 'repo');
  await mkdir(join(repo, 'apps/pipelines'), { recursive: true });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'apps/pipelines/source.txt'), 'source');
  git('add', '.');
  git('commit', '-m', 'base');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['.env', 'apps/pipelines/.env.local', 'apps/pipelines/.dev.vars'])('omits external %s without dereferencing it', async (path) => {
  // A dangling target proves that snapshot preparation never needs to open it.
  await symlink(join(root, 'unreadable-secret'), join(repo, path));
  await writeFile(join(repo, '.env.example'), 'PUBLIC_EXAMPLE=1');
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'environment', kind: 'test', run: `test ! -e ${path} && test ! -L ${path} && test -f .env.example` }],
  });
  expect(result).toMatchObject({ headStatus: 'pass', newFailure: false });
});

it('omits tracked environment files from both head and base while retaining comparison evidence', async () => {
  await writeFile(join(repo, '.env'), 'PRIVATE_VALUE=must-not-copy');
  git('add', '.env');
  git('commit', '-m', 'tracked environment');
  const inspected: string[] = [];
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'comparison', kind: 'test', run: 'exit 1' }],
    sandboxExecutorSessionFactory: async (workspace) => {
      expect(existsSync(join(workspace, '.env'))).toBe(false);
      inspected.push(workspace);
      return { execute: async () => ({ output: 'same assertion', exitCode: 1, signal: null, timedOut: false }) };
    },
  });
  expect(inspected).toHaveLength(2);
  expect(result).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
});

it('omits environment files inside configured shared data without resolving their links', async () => {
  await mkdir(join(repo, 'data'));
  await symlink(join(root, 'unreadable-secret'), join(repo, 'data/.env'));
  await writeFile(join(repo, 'data/input.txt'), 'input');
  await writeFile(join(repo, 'openswarm.json'), JSON.stringify({ sandbox: { sharedPaths: ['data'] } }));
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'shared', kind: 'test', run: 'test ! -L data/.env && test -f data/input.txt' }],
  });
  expect(result).toMatchObject({ headStatus: 'pass', newFailure: false });
});

it.each(['.venv', '.venv-verify', 'venv'])('copies the command-local %s independently for head and base', async (name) => {
  const dependency = join(repo, 'apps/pipelines', name);
  await mkdir(join(dependency, 'bin'), { recursive: true });
  await writeFile(join(root, 'interpreter'), 'external dependency');
  await symlink(join(root, 'interpreter'), join(dependency, 'bin/python'));
  await writeFile(join(dependency, 'state'), 'original');
  const sitePackages = join(dependency, 'lib/python3.12/site-packages');
  await mkdir(sitePackages, { recursive: true });
  const editablePath = join(sitePackages, '_editable.pth');
  const originalEditable = `${repo}/apps/pipelines/src\nimport unrelated_hook\n/outside/src\n`;
  await writeFile(editablePath, originalEditable);
  await mkdir(join(sitePackages, 'certifi'));
  await writeFile(join(sitePackages, 'certifi/cacert.pem'), 'public CA bundle');
  await symlink(join(root, 'unreadable-secret'), join(sitePackages, '.env'));
  const inspected: string[] = [];
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'pytest:apps/pipelines', kind: 'test', cwd: 'apps/pipelines', run: `./${name}/bin/python -m pytest` }],
    sandboxExecutorSessionFactory: async (workspace) => {
      const copy = join(workspace, 'apps/pipelines', name);
      expect(await readFile(join(copy, 'bin/python'), 'utf8')).toBe('external dependency');
      expect(await readFile(join(copy, 'state'), 'utf8')).toBe('original');
      expect(await readFile(join(copy, 'lib/python3.12/site-packages/_editable.pth'), 'utf8'))
        .toBe(`${workspace}/apps/pipelines/src\nimport unrelated_hook\n/outside/src\n`);
      expect(await readFile(join(copy, 'lib/python3.12/site-packages/certifi/cacert.pem'), 'utf8')).toBe('public CA bundle');
      expect(existsSync(join(copy, 'lib/python3.12/site-packages/.env'))).toBe(false);
      await writeFile(join(copy, 'bin/python'), 'mutated in sandbox');
      await writeFile(join(copy, 'state'), 'mutated in sandbox');
      inspected.push(workspace);
      return { execute: async () => ({ output: 'same assertion', exitCode: 1, signal: null, timedOut: false }) };
    },
  });
  expect(inspected).toHaveLength(2);
  expect(result).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  expect(await readFile(join(root, 'interpreter'), 'utf8')).toBe('external dependency');
  expect(await readFile(join(dependency, 'state'), 'utf8')).toBe('original');
  expect(await readFile(editablePath, 'utf8')).toBe(originalEditable);
});

it('ignores an unused nested virtualenv but still rejects an unrelated escaping source link', async () => {
  await mkdir(join(repo, 'unused/.venv/bin'), { recursive: true });
  await symlink(join(root, 'external'), join(repo, 'unused/.venv/bin/python'));
  const options = {
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'source', kind: 'test' as const, run: 'test ! -e unused/.venv && test -f apps/pipelines/source.txt' }],
  };
  expect((await runVerify(options))[0].headStatus).toBe('pass');
  await symlink(join(root, 'external'), join(repo, 'escape'));
  expect((await runVerify(options))[0]).toMatchObject({ headStatus: 'fail', securityFailure: true });
});

it('omits ignored local asset links and disables checkout hooks for base comparison', async () => {
  await writeFile(join(repo, '.gitignore'), 'local-data\n');
  git('add', '.gitignore');
  git('commit', '-m', 'local data policy');
  await symlink(join(root, 'private-customer-data'), join(repo, 'local-data'));
  const hook = join(repo, '.git/hooks/post-checkout');
  await writeFile(hook, '#!/bin/sh\ntouch hook-ran\n');
  await chmod(hook, 0o755);
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD',
    commands: [{ name: 'comparison', kind: 'test', run: 'if test -e hook-ran || test -L local-data; then echo polluted; else echo isolated; fi; exit 1' }],
  });
  expect(result).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  expect(result.rawOutputTail).not.toContain('polluted');
});

it('rejects tracked external links even when an ignore rule matches their name', async () => {
  await symlink(join(root, 'external'), join(repo, 'tracked-link'));
  git('add', 'tracked-link');
  git('commit', '-m', 'tracked link');
  await writeFile(join(repo, '.gitignore'), 'tracked-link\n');
  const [result] = await runVerify({
    projectPath: repo, baseRef: 'HEAD', commands: [{ name: 'source', kind: 'test', run: 'true' }],
  });
  expect(result).toMatchObject({ headStatus: 'fail', securityFailure: true });
});

it('rebases a linked worktree editable install from its verified main checkout', async () => {
  const shared = join(repo, 'apps/pipelines/.venv/lib/python3.12/site-packages');
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, '_editable.pth'), `${repo}/apps/pipelines/src\n`);
  const linked = join(root, 'linked');
  git('worktree', 'add', '--detach', linked, 'HEAD');
  await symlink(join(repo, 'apps/pipelines/.venv'), join(linked, 'apps/pipelines/.venv'));
  let inspected = false;
  const [result] = await runVerify({
    projectPath: linked, baseRef: 'HEAD',
    commands: [{ name: 'source', kind: 'test', cwd: 'apps/pipelines', run: 'true' }],
    sandboxExecutorSessionFactory: async (workspace) => {
      const content = await readFile(join(workspace, 'apps/pipelines/.venv/lib/python3.12/site-packages/_editable.pth'), 'utf8');
      expect(content).toBe(`${workspace}/apps/pipelines/src\n`);
      inspected = true;
      return { execute: async () => ({ output: 'inspected', exitCode: 0, signal: null, timedOut: false, truncated: false, outputLimitExceeded: false }) };
    },
  });
  expect(inspected).toBe(true);
  expect(result.headStatus).toBe('pass');
});
