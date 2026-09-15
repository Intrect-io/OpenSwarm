import { existsSync } from 'node:fs';
import type { SwarmConfig } from './types.js';

const GITHUB_REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function isValidGitHubRepo(repo: string): boolean {
  const segments = repo.split('/');
  return segments.length === 2 && segments.every(
    (segment) =>
      GITHUB_REPO_SEGMENT_PATTERN.test(segment) &&
      segment !== '.' &&
      segment !== '..',
  );
}

/** Validate config with supplementary checks beyond Zod validation. */
export function validateConfig(config: SwarmConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // A missing path is non-fatal: the runner disables only that agent.
  for (const agent of config.agents) {
    if (!existsSync(agent.projectPath)) {
      warnings.push(`Agent "${agent.name}" project path does not exist: ${agent.projectPath} (agent disabled)`);
    }
  }

  for (const repo of config.githubRepos ?? []) {
    if (!isValidGitHubRepo(repo)) {
      errors.push(`Invalid GitHub repo format: ${repo} (expected: owner/repo)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
