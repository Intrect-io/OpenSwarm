// Created: 2026-11-21
// Purpose: Withhold gh credentials from a delegated CLI child under forbidPublication (AGT-4414).
// Dependencies: none
// Test Status: covered by src/adapters/delegatedPublicationEnv.test.ts

/** Token variables gh (and GitHub tooling) read for authentication. */
export const PUBLICATION_TOKEN_ENV_KEYS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  // Read by the GitHub MCP server, which a delegated claude CLI may load from user settings.
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_PAT',
];

/** Prefix of the empty per-run gh config directory. */
export const EMPTY_GH_CONFIG_DIR_PREFIX = 'osw-gh-empty-';

/**
 * Copy `env` without gh tokens and point GH_CONFIG_DIR at an empty directory,
 * so a plain gh call in the child finds neither a token nor the operator's stored
 * login. This is not a sandbox: the child keeps HOME, so it can still reach ssh
 * keys, git credential helpers or an explicitly chosen GH_CONFIG_DIR.
 * Apply after any adapter overlay so the overlay cannot re-add a token.
 * The input is never mutated.
 */
export function withoutPublicationCredentials(
  env: NodeJS.ProcessEnv,
  emptyGhConfigDir: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of PUBLICATION_TOKEN_ENV_KEYS) delete out[key];
  out.GH_CONFIG_DIR = emptyGhConfigDir;
  return out;
}
