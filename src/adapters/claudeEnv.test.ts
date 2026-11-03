import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeEnvOverlay, describeClaudeAuthSource, resolveClaudeAuthEnv } from './claudeEnv.js';

describe('resolveClaudeAuthEnv', () => {
  let home: string;
  let claudeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'openswarm-claude-env-'));
    claudeDir = join(home, '.claude');
    mkdirSync(claudeDir);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeSettings = (name: string, value: unknown) =>
    writeFileSync(join(claudeDir, name), typeof value === 'string' ? value : JSON.stringify(value));

  it('copies only the auth keys out of the user settings env', () => {
    writeSettings('settings.json', {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'tok',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        BASH_MAX_TIMEOUT_MS: '9',
        CLAUDE_AFK_TIMEOUT_MS: '1',
      },
      language: 'Korean',
    });
    expect(resolveClaudeAuthEnv({ HOME: home })).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
    });
  });

  it('lets the parent env win when it already authenticates', () => {
    writeSettings('settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'from-file' } });
    expect(resolveClaudeAuthEnv({ HOME: home, ANTHROPIC_API_KEY: 'from-env' })).toEqual({});
    expect(resolveClaudeAuthEnv({ HOME: home, ANTHROPIC_AUTH_TOKEN: 'from-env' })).toEqual({});
  });

  it('keeps a base URL the parent env already sets', () => {
    writeSettings('settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://file' } });
    expect(resolveClaudeAuthEnv({ HOME: home, ANTHROPIC_BASE_URL: 'https://env' })).toEqual({ ANTHROPIC_AUTH_TOKEN: 'tok' });
  });

  it('lets settings.local.json override settings.json', () => {
    writeSettings('settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'shared' } });
    writeSettings('settings.local.json', { env: { ANTHROPIC_AUTH_TOKEN: 'local' } });
    expect(resolveClaudeAuthEnv({ HOME: home }).ANTHROPIC_AUTH_TOKEN).toBe('local');
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const other = join(home, 'alt');
    mkdirSync(other);
    writeFileSync(join(other, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'k' } }));
    expect(resolveClaudeAuthEnv({ HOME: home, CLAUDE_CONFIG_DIR: other })).toEqual({ ANTHROPIC_API_KEY: 'k' });
  });

  it('injects nothing for a missing, malformed, or auth-less settings file', () => {
    expect(resolveClaudeAuthEnv({ HOME: home })).toEqual({});
    writeSettings('settings.json', '{not json');
    expect(resolveClaudeAuthEnv({ HOME: home })).toEqual({});
    writeSettings('settings.json', { env: { ANTHROPIC_BASE_URL: 'https://proxy' } });
    expect(resolveClaudeAuthEnv({ HOME: home })).toEqual({});
  });

  it('describes the auth source without exposing values', () => {
    expect(describeClaudeAuthSource({ HOME: home })).toBe('none');
    writeSettings('.credentials.json', '{}');
    expect(describeClaudeAuthSource({ HOME: home })).toBe('oauth-file');
    writeSettings('settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
    expect(describeClaudeAuthSource({ HOME: home })).toBe('user-settings');
    expect(describeClaudeAuthSource({ HOME: home, ANTHROPIC_API_KEY: 'x' })).toBe('env');
  });

  it('builds an overlay that strips session vars and injects auth only when user settings are skipped', () => {
    writeSettings('settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
    const base = { HOME: home, CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDECODE: '1' };
    const isolated = buildClaudeEnvOverlay(base, { loadsUserSettings: false });
    expect(isolated.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    expect('CLAUDE_CODE_MESSAGING_TOKEN' in isolated && isolated.CLAUDE_CODE_MESSAGING_TOKEN === undefined).toBe(true);
    expect('CLAUDECODE' in isolated && isolated.CLAUDECODE === undefined).toBe(true);
    const inherited = buildClaudeEnvOverlay(base, { loadsUserSettings: true });
    expect(inherited.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
