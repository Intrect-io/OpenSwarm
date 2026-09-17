import { describe, expect, it } from 'vitest';
import { buildWorkerEnv } from './envPath.js';

describe('buildWorkerEnv human-surface boundary', () => {
  it('scrubs human-surface credentials from delegated CLI env without removing model or DevOps access', () => {
    const env = buildWorkerEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/worker',
      ANTHROPIC_API_KEY: 'keep',
      OPENAI_API_KEY: 'keep',
      GITHUB_TOKEN: 'keep',
      AWS_PROFILE: 'keep',
      POSTGRES_DSN: 'keep',
      SLACK_BOT_TOKEN: 'drop',
      NOTION_API_KEY: 'drop',
      TELEGRAM_BOT_TOKEN: 'drop',
      GOOGLE_CALENDAR_TOKEN: 'drop',
      MS_GRAPH_TOKEN: 'drop',
    });

    expect(env).toMatchObject({
      HOME: '/home/worker',
      ANTHROPIC_API_KEY: 'keep',
      OPENAI_API_KEY: 'keep',
      GITHUB_TOKEN: 'keep',
      AWS_PROFILE: 'keep',
      POSTGRES_DSN: 'keep',
    });
    expect(env).not.toHaveProperty('SLACK_BOT_TOKEN');
    expect(env).not.toHaveProperty('NOTION_API_KEY');
    expect(env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(env).not.toHaveProperty('GOOGLE_CALENDAR_TOKEN');
    expect(env).not.toHaveProperty('MS_GRAPH_TOKEN');
  });
});

describe('buildWorkerEnv withholds credentials the daemon found dead (AGT-4028)', () => {
  it('drops a key marked dead and leaves everything else, until the mark is cleared', async () => {
    const { buildWorkerEnv, markWorkerEnvKeyDead, clearDeadWorkerEnvKeys, deadWorkerEnvKeyReasons } = await import('./envPath.js');
    try {
      markWorkerEnvKeyDead('LINEAR_API_KEY', 'HTTP 401: Authentication required');
      const env = buildWorkerEnv({ PATH: '/usr/bin', LINEAR_API_KEY: 'dead', OPENROUTER_API_KEY: 'alive' });
      expect(env.LINEAR_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBe('alive');
      expect(deadWorkerEnvKeyReasons().get('LINEAR_API_KEY')).toMatch(/401/);
    } finally {
      clearDeadWorkerEnvKeys();
    }
    expect(buildWorkerEnv({ PATH: '/usr/bin', LINEAR_API_KEY: 'now-fine' }).LINEAR_API_KEY).toBe('now-fine');
  });
});
