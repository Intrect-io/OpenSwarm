// Created: 2026-11-21
// Purpose: tests for the fail-closed steward config loader (AGT-4803)
// Dependencies: vitest, node:fs, node:os, node:path
// Test Status: passing

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_GITHUB_TOKEN_ENVS,
  defaultStewardConfigPath,
  isAmbientGithubTokenEnv,
  loadStewardConfig,
  STEWARD_CONFIG_DEFAULTS,
} from './stewardConfig.js';

const DEFAULTS = {
  mergeEnabled: false,
  automationAccounts: [],
  tokenEnv: 'OPENSWARM_STEWARD_GH_TOKEN',
  mergeMethod: 'squash',
};

describe('stewardConfig', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steward-config-'));
    file = join(dir, 'config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (value: unknown): void => {
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('defaults path under the home directory', () => {
    expect(defaultStewardConfigPath({})).toBe(join(homedir(), '.openswarm', 'steward', 'config.json'));
    expect(defaultStewardConfigPath({ OPENSWARM_STEWARD_CONFIG: '  ' })).toBe(
      join(homedir(), '.openswarm', 'steward', 'config.json'),
    );
  });

  it('honours the OPENSWARM_STEWARD_CONFIG env override', () => {
    write({ mergeEnabled: true });
    expect(defaultStewardConfigPath({ OPENSWARM_STEWARD_CONFIG: file })).toBe(file);
    const prev = process.env.OPENSWARM_STEWARD_CONFIG;
    process.env.OPENSWARM_STEWARD_CONFIG = file;
    try {
      const loaded = loadStewardConfig();
      expect(loaded.source).toBe('file');
      expect(loaded.path).toBe(file);
      expect(loaded.config.mergeEnabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OPENSWARM_STEWARD_CONFIG;
      else process.env.OPENSWARM_STEWARD_CONFIG = prev;
    }
  });

  it('falls back to defaults when the file is missing', () => {
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('no steward config');
  });

  it('falls back to defaults when the path is a directory', () => {
    const sub = join(dir, 'config.d');
    mkdirSync(sub);
    const loaded = loadStewardConfig({ path: sub });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('unreadable');
  });

  it('falls back to defaults on invalid JSON', () => {
    write('{"mergeEnabled": true,');
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('invalid JSON');
  });

  it('rejects a string "true" for mergeEnabled', () => {
    write({ mergeEnabled: 'true' });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('mergeEnabled');
  });

  it('rejects a bad tokenEnv as a whole file', () => {
    write({ mergeEnabled: true, tokenEnv: 'ghp_secret-token' });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('tokenEnv');
  });

  it.each([
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT',
  ])('rejects the ambient token env %s as tokenEnv, as a whole file', (name) => {
    write({ mergeEnabled: true, automationAccounts: ['openswarm-bot'], tokenEnv: name });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.config.mergeEnabled).toBe(false);
    expect(loaded.reason).toContain('tokenEnv');
    expect(loaded.reason).toMatch(/ambient GitHub token/);
  });

  it('lists every ambient token env and matches them case-insensitively', () => {
    expect([...AMBIENT_GITHUB_TOKEN_ENVS].sort()).toEqual([
      'GH_ENTERPRISE_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PAT', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN',
    ]);
    expect(isAmbientGithubTokenEnv('gh_token')).toBe(true);
    expect(isAmbientGithubTokenEnv('OPENSWARM_STEWARD_GH_TOKEN')).toBe(false);
    expect(isAmbientGithubTokenEnv(STEWARD_CONFIG_DEFAULTS.tokenEnv)).toBe(false);
  });

  it('rejects a bad mergeMethod as a whole file', () => {
    write({ mergeEnabled: true, mergeMethod: 'fast-forward' });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded).toMatchObject({ source: 'default', config: DEFAULTS });
    expect(loaded.reason).toContain('mergeMethod');
  });

  it('loads a valid file', () => {
    write({ mergeEnabled: true, automationAccounts: ['openswarm-bot', 'ci[bot]'], tokenEnv: 'STEWARD_TOKEN', mergeMethod: 'rebase' });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual({
      mergeEnabled: true,
      automationAccounts: ['openswarm-bot', 'ci[bot]'],
      tokenEnv: 'STEWARD_TOKEN',
      mergeMethod: 'rebase',
    });
  });

  it('fills omitted fields of a valid file with defaults', () => {
    write({ automationAccounts: ['bot-a'] });
    const loaded = loadStewardConfig({ path: file });
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual({ ...DEFAULTS, automationAccounts: ['bot-a'] });
  });

  it('uses the injected readFile', () => {
    const loaded = loadStewardConfig({ path: '/virtual/config.json', readFile: () => '{"mergeMethod":"merge"}' });
    expect(loaded.source).toBe('file');
    expect(loaded.config.mergeMethod).toBe('merge');
  });

  it('never yields mergeEnabled true from a bad file', () => {
    const bad: string[] = [
      '{"mergeEnabled": true',
      JSON.stringify({ mergeEnabled: 'true' }),
      JSON.stringify({ mergeEnabled: 1 }),
      JSON.stringify({ mergeEnabled: true, tokenEnv: 'lower_case' }),
      JSON.stringify({ mergeEnabled: true, mergeMethod: 'ff' }),
      JSON.stringify({ mergeEnabled: true, automationAccounts: 'bot' }),
      JSON.stringify({ mergeEnabled: true, automationAccounts: ['bad login!'] }),
      JSON.stringify({ mergeEnabled: true, unknownKey: 1 }),
      JSON.stringify([{ mergeEnabled: true }]),
      'null',
      'true',
    ];
    for (const raw of bad) {
      const loaded = loadStewardConfig({ path: '/virtual/config.json', readFile: () => raw });
      expect(loaded.source, raw).toBe('default');
      expect(loaded.config.mergeEnabled, raw).toBe(false);
    }
    expect(loadStewardConfig({ path: 'relative/config.json', readFile: () => '{"mergeEnabled":true}' }).config.mergeEnabled).toBe(false);
    expect(STEWARD_CONFIG_DEFAULTS.mergeEnabled).toBe(false);
  });
});
