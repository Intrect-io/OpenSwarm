// Covers the versioned git hooks in .githooks/ and scripts/install-githooks.mjs
// (run by the package.json "prepare" script). Every git operation runs in a
// throwaway repository under the OS temp dir with global and system config
// disabled, so nothing here can touch the real repository's shared config.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..');
const COMMIT_MSG = join(REPO, '.githooks', 'commit-msg');
const PRE_COMMIT = join(REPO, '.githooks', 'pre-commit');
const INSTALLER = join(REPO, 'scripts', 'install-githooks.mjs');
// Assembled so the literal trailer never appears in a command line of this repo.
const TRAILER_KEY = ['Co', 'Authored', 'By'].join('-');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-githooks-'));
  temps.push(dir);
  return dir;
}

/** An environment with no inherited GIT_* state and empty global/system config. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '');
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmpdir(),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function makeRepo() {
  const root = tempDir();
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const env = isolatedEnv(home);
  expect(run('git', ['init', '-q'], repo, env).status).toBe(0);
  const git = (...args: string[]) => run('git', args, repo, env);
  return { repo, env, git };
}

describe('commit-msg hook', () => {
  function check(message: string) {
    const dir = tempDir();
    const file = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, message);
    return run('sh', [COMMIT_MSG, file], dir, isolatedEnv(dir));
  }

  it('commit-msg rejects a Co-Authored-By trailer', () => {
    const result = check(`feat: add a thing\n\nBody text.\n\n${TRAILER_KEY}: Some Bot <bot@example.invalid>\n`);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`${TRAILER_KEY} trailer`);
  });

  it('rejects the trailer case-insensitively', () => {
    expect(check(`fix: x\n\n${TRAILER_KEY.toLowerCase()}: someone <a@b.invalid>\n`).status).toBe(1);
    expect(check(`fix: x\n\n${TRAILER_KEY.toUpperCase()} : someone <a@b.invalid>\n`).status).toBe(1);
  });

  it('accepts a message without the trailer, or with it only on a comment line', () => {
    expect(check('fix: plain message\n\nMentions co-authorship in prose only.\n').status).toBe(0);
    expect(check(`fix: x\n# ${TRAILER_KEY}: ignored comment line\n`).status).toBe(0);
  });

  it('refuses a real git commit that carries the trailer', () => {
    const { repo, git } = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    const msg = join(repo, '..', 'msg.txt');
    writeFileSync(msg, `feat: a\n\n${TRAILER_KEY}: X <x@y.invalid>\n`);
    // Only the commit-msg hook: pre-commit has its own tests below.
    const hooks = join(repo, '..', 'hooks');
    mkdirSync(hooks);
    copyFileSync(COMMIT_MSG, join(hooks, 'commit-msg'));
    chmodSync(join(hooks, 'commit-msg'), 0o755);
    const refused = git('-c', `core.hooksPath=${hooks}`, 'commit', '-q', '-F', msg);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain('refused');
    expect(git('rev-parse', '--verify', '-q', 'HEAD').status).not.toBe(0);
  });
});

describe('pre-commit hook', () => {
  function stageRepo(locCheck: string | null) {
    const ctx = makeRepo();
    if (locCheck !== null) {
      mkdirSync(join(ctx.repo, 'scripts'));
      writeFileSync(join(ctx.repo, 'scripts', 'loc-check.mjs'), locCheck);
    }
    // A non-TypeScript file, so the hook never reaches npx oxlint / tsc.
    writeFileSync(join(ctx.repo, 'notes.mjs'), 'export const a = 1;\n');
    ctx.git('add', 'notes.mjs');
    return ctx;
  }

  it('fails closed when scripts/loc-check.mjs is missing', () => {
    const { repo, env } = stageRepo(null);
    const result = run('bash', [PRE_COMMIT], repo, env);
    expect(result.status).toBe(1);
    expect(result.out).toContain('loc-check.mjs is missing');
  });

  it('fails when the LOC gate fails, passing it the staged files', () => {
    const { repo, env } = stageRepo("console.error('stub args: ' + process.argv.slice(2).join(' ')); process.exit(1);\n");
    const result = run('bash', [PRE_COMMIT], repo, env);
    expect(result.status).toBe(1);
    expect(result.out).toContain('stub args: --staged --files notes.mjs');
    expect(result.out).toContain('LOC gate failed');
  });

  it('passes when the LOC gate passes and no TypeScript is staged', () => {
    const { repo, env } = stageRepo('process.exit(0);\n');
    expect(run('bash', [PRE_COMMIT], repo, env).status).toBe(0);
  });

  it('runs the real loc-check on the staged content of a file over the limit', () => {
    const { repo, env, git } = stageRepo(readFileSync(join(REPO, 'scripts', 'loc-check.mjs'), 'utf8'));
    mkdirSync(join(repo, 'src'));
    const big = join(repo, 'src', 'big.mjs');
    writeFileSync(big, Array.from({ length: 1501 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
    git('add', 'src/big.mjs');
    // The working tree shrinks after staging; the gate must judge the staged blob.
    writeFileSync(big, 'export const v = 1;\n');
    const result = run('bash', [PRE_COMMIT], repo, env);
    expect(result.status).toBe(1);
    expect(result.out).toContain('src/big.mjs: 1501 code LOC exceeds the 1500 limit');
  });
});

describe('install-githooks', () => {
  it('no-ops outside a git repository', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.githooks'));
    const result = run(process.execPath, [INSTALLER, 'core.hooksPath', '.githooks'], dir, isolatedEnv(dir));
    expect(result.status).toBe(0);
    expect(result.out).toContain('not inside a git work tree');
  });

  it('does not override an existing core.hooksPath', () => {
    const { repo, env, git } = makeRepo();
    mkdirSync(join(repo, '.githooks'));
    git('config', '--local', 'core.hooksPath', '/custom/hooks');
    const result = run(process.execPath, [INSTALLER, 'core.hooksPath', '.githooks'], repo, env);
    expect(result.status).toBe(0);
    expect(result.out).toContain('not overriding');
    expect(git('config', '--get', 'core.hooksPath').out.trim()).toBe('/custom/hooks');
  });

  it('installs .githooks when core.hooksPath is unset, and only at the top level', () => {
    const { repo, env, git } = makeRepo();
    mkdirSync(join(repo, '.githooks'));
    mkdirSync(join(repo, 'stage', '.githooks'), { recursive: true });
    const nested = run(process.execPath, [INSTALLER], join(repo, 'stage'), env);
    expect(nested.status).toBe(0);
    expect(nested.out).toContain('not at the top level');
    expect(git('config', '--get', 'core.hooksPath').status).not.toBe(0);

    expect(run(process.execPath, [INSTALLER, 'core.hooksPath', '.githooks'], repo, env).status).toBe(0);
    expect(git('config', '--get', 'core.hooksPath').out.trim()).toBe('.githooks');
    expect(run(process.execPath, [INSTALLER], repo, env).out).toContain('already');
  });

  it('no-ops when .githooks is absent', () => {
    const { repo, env, git } = makeRepo();
    const result = run(process.execPath, [INSTALLER], repo, env);
    expect(result.status).toBe(0);
    expect(result.out).toContain('.githooks is absent');
    expect(git('config', '--get', 'core.hooksPath').status).not.toBe(0);
  });

  it('the prepare script exits 0 in a directory without scripts/ (Docker npm ci layer)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepare).toContain('core.hooksPath');
    const dir = tempDir();
    const result = run('sh', ['-c', pkg.scripts.prepare], dir, isolatedEnv(dir));
    expect(result.status).toBe(0);
  });

  it('the prepare script installs the hooks in a checkout that has the installer', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const { repo, env, git } = makeRepo();
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, '.githooks'));
    copyFileSync(INSTALLER, join(repo, 'scripts', 'install-githooks.mjs'));
    const result = run('sh', ['-c', pkg.scripts.prepare], repo, env);
    expect(result.status).toBe(0);
    expect(git('config', '--get', 'core.hooksPath').out.trim()).toBe('.githooks');
  });
});
