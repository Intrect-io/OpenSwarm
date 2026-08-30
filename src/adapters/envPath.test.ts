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
  });
});
