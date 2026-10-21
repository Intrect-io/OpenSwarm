// ============================================
// OpenSwarm - Worker shell environment (AGT-4783)
// ============================================
//
// The worker's shell must not carry an identity it could act with. These tests
// pin the three parts of that: the variable allowlist, the private HOME (with
// caches re-pointed at the real directories), and the gh/git/ssh identity
// overrides. The live checks run the real `git` binary with the env, because
// "the variable is set" is not the same as "git ignores the keychain".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWorkerShellEnv, resetWorkerHomeForTests } from './workerEnv.js';

let realHome: string;
let workerHome: string;

beforeEach(() => {
  realHome = mkdtempSync(path.join(tmpdir(), 'osw-real-home-'));
  workerHome = mkdtempSync(path.join(tmpdir(), 'osw-worker-home-'));
});

afterEach(() => {
  rmSync(realHome, { recursive: true, force: true });
  rmSync(workerHome, { recursive: true, force: true });
  resetWorkerHomeForTests();
});

const build = (base: NodeJS.ProcessEnv) => buildWorkerShellEnv(base, { realHome, workerHome });

describe('worker shell variable allowlist', () => {
  it('drops tokens, keys, DSNs, agent sockets and the daemon\'s own secrets', () => {
    const env = build({
      PATH: '/usr/bin:/bin',
      GH_TOKEN: 'x', GITHUB_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/tmp/agent', LINEAR_API_KEY: 'x', OPENAI_API_KEY: 'x', OPENROUTER_API_KEY: 'x',
      POSTGRES_DSN: 'x', DATABASE_URL: 'x', OPENSWARM_WEB_TOKEN: 'x', NPM_TOKEN: 'x',
      GIT_CONFIG_GLOBAL: '/somewhere/.gitconfig', NODE_OPTIONS: '--require /tmp/hook.js',
    });
    for (const key of [
      'GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK',
      'LINEAR_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'POSTGRES_DSN', 'DATABASE_URL',
      'OPENSWARM_WEB_TOKEN', 'NPM_TOKEN', 'GIT_CONFIG_GLOBAL', 'NODE_OPTIONS',
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it('keeps locale, terminal, CI and the test-resource budget', () => {
    const env = build({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm', CI: 'true', TZ: 'UTC',
      OPENSWARM_TEST_PARALLELISM: '2',
    });
    expect(env).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm', CI: 'true', TZ: 'UTC' });
    expect(env.OPENSWARM_TEST_PARALLELISM).toBeDefined();
  });

  it('prepends the user tool bins resolved against the real home', () => {
    const env = build({ PATH: '/usr/bin' });
    const parts = (env.PATH ?? '').split(path.delimiter);
    expect(parts).toContain(path.join(realHome, '.cargo', 'bin'));
    expect(parts.indexOf(path.join(realHome, '.cargo', 'bin'))).toBeLessThan(parts.indexOf('/usr/bin'));
  });
});

describe('worker shell HOME', () => {
  it('is the private home, not the real one, so file-based logins are not found', () => {
    const env = build({ PATH: '/usr/bin', HOME: realHome });
    expect(env.HOME).toBe(workerHome);
    expect(env.XDG_CONFIG_HOME).toBe(path.join(workerHome, '.config'));
    expect(env.HOME).not.toBe(realHome);
  });

  it('re-points existing caches and toolchain homes at the real directories', () => {
    mkdirSync(path.join(realHome, '.cargo'), { recursive: true });
    mkdirSync(path.join(realHome, '.cache', 'uv'), { recursive: true });
    mkdirSync(path.join(realHome, '.npm'), { recursive: true });
    const env = build({ PATH: '/usr/bin' });
    expect(env.CARGO_HOME).toBe(path.join(realHome, '.cargo'));
    expect(env.UV_CACHE_DIR).toBe(path.join(realHome, '.cache', 'uv'));
    expect(env.npm_config_cache).toBe(path.join(realHome, '.npm'));
    // A home the host never created is not invented.
    expect(env).not.toHaveProperty('RUSTUP_HOME');
  });

  it('keeps an explicitly configured toolchain home over the default', () => {
    const env = build({ PATH: '/usr/bin', CARGO_HOME: '/opt/cargo' });
    expect(env.CARGO_HOME).toBe('/opt/cargo');
  });

  it('creates one private home per process when none is given', () => {
    const first = buildWorkerShellEnv({ PATH: '/usr/bin' }, { realHome });
    const second = buildWorkerShellEnv({ PATH: '/usr/bin' }, { realHome });
    expect(first.HOME).toBe(second.HOME);
    expect(first.HOME).not.toBe(realHome);
    rmSync(first.HOME!, { recursive: true, force: true });
  });
});

describe('worker shell gh / git / ssh identity', () => {
  it('points gh at an empty config dir and resets git credential helpers', () => {
    const env = build({ PATH: '/usr/bin' });
    expect(env.GH_CONFIG_DIR).toBe(path.join(workerHome, '.config', 'gh'));
    expect(readdirSync(env.GH_CONFIG_DIR!)).toEqual([]);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
    });
    expect(env.GIT_SSH_COMMAND).toContain('-i /dev/null');
  });

  it('git, run with the env, resolves no credential helper and no password (live)', () => {
    const env = { ...build({ PATH: process.env.PATH }), LC_ALL: 'C' };
    // The last value wins; an empty one means "no helper", whatever the system
    // config (osxkeychain on macOS) declared before it.
    const helpers = execFileSync('git', ['config', '--get-all', 'credential.helper'], { env, encoding: 'utf8' })
      .split('\n');
    expect(helpers.filter(Boolean).length === 0 || helpers.at(-2) === '').toBe(true);
    // With no helper and prompts disabled, git cannot produce a password: it
    // exits non-zero instead of printing one.
    const filled = spawnSync('git', ['credential', 'fill'], {
      env, input: 'protocol=https\nhost=github.com\nusername=x\n\n', encoding: 'utf8',
    });
    expect(filled.stdout).not.toMatch(/^password=(?!$)/m);
    expect(filled.status).not.toBe(0);
  });
});
