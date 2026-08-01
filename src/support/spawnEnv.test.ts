import { afterEach, describe, expect, it } from 'vitest';
import { safeInheritedEnv, CLAUDE_CLI_ENV_KEYS } from './spawnEnv.js';

describe('safeInheritedEnv', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('drops credentials the child was never meant to see', () => {
    // The concrete risk: dev.ts spawns `claude -p --permission-mode
    // bypassPermissions`, an agent with a shell, and the parent process holds
    // keys for every provider plus Linear, npm and GitHub.
    Object.assign(process.env, {
      OPENROUTER_API_KEY: 'or-secret',
      ATLASCLOUD_API_KEY: 'atlas-secret',
      LINEAR_API_KEY: 'linear-secret',
      NPM_TOKENS: 'npm-secret',
      GH_TOKEN: 'gh-secret',
    });

    const env = safeInheritedEnv();

    expect(Object.values(env)).not.toContain('or-secret');
    for (const leaked of ['OPENROUTER_API_KEY', 'ATLASCLOUD_API_KEY', 'LINEAR_API_KEY', 'NPM_TOKENS', 'GH_TOKEN']) {
      expect(env).not.toHaveProperty(leaked);
    }
  });

  it('keeps what a child needs to run at all', () => {
    Object.assign(process.env, { PATH: '/usr/bin', HOME: '/home/x' });
    expect(safeInheritedEnv()).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x' });
  });

  it('admits a named key and a prefix family, and nothing beyond them', () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'anthropic',
      CLAUDE_CODE_THING: 'claude',
      XDG_CONFIG_HOME: '/cfg',
      OPENROUTER_API_KEY: 'or-secret',
    });

    const env = safeInheritedEnv(CLAUDE_CLI_ENV_KEYS);

    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'anthropic', CLAUDE_CODE_THING: 'claude', XDG_CONFIG_HOME: '/cfg' });
    expect(env).not.toHaveProperty('OPENROUTER_API_KEY');
  });

  it('does not let one call site widen another', () => {
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'anthropic' });
    expect(safeInheritedEnv()).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});
