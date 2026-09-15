import { describe, expect, it } from 'vitest';
import { validateConfig } from './config.js';
import type { SwarmConfig } from './types.js';

const baseConfig: SwarmConfig = {
  language: 'en',
  discordToken: '',
  discordChannelId: '',
  linearApiKey: '',
  linearTeamId: '',
  agents: [],
  defaultHeartbeatInterval: 30_000,
};

describe('validateConfig GitHub repository path segments', () => {
  it.each(['./repo', '../..', 'owner/.', 'owner/..'])('rejects %s', (repo) => {
    const result = validateConfig({ ...baseConfig, githubRepos: [repo] });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      `Invalid GitHub repo format: ${repo} (expected: owner/repo)`,
    );
  });
});
