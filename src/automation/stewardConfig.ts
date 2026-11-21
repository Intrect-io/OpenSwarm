// Created: 2026-11-21
// Purpose: operator-owned merge steward config (merge switch, automation accounts, token env), fail-closed (AGT-4803)
// Dependencies: node:fs, node:os, node:path, zod
// Test Status: stewardConfig.test.ts

/**
 * Read from `OPENSWARM_STEWARD_CONFIG`, else `~/.openswarm/steward/config.json`.
 * Never the target repository or the cwd, so a PR cannot configure the steward.
 *
 * Any problem with the file (missing, unreadable, invalid JSON, schema-invalid,
 * relative path) yields the defaults as a whole: a bad file is never partially
 * merged, so `mergeEnabled` can only become true from a fully valid file holding
 * the literal boolean `true`. Fields left out of a valid file take their defaults.
 * This module is the only source of `automationAccounts` for the steward write.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

export type StewardMergeMethod = 'squash' | 'merge' | 'rebase';

export interface StewardConfig {
  mergeEnabled: boolean;
  /** GitHub logins of the automation accounts. */
  automationAccounts: readonly string[];
  /** Name of the env var holding the steward token (never the token itself). */
  tokenEnv: string;
  mergeMethod: StewardMergeMethod;
}

export interface StewardConfigLoad {
  config: StewardConfig;
  source: 'file' | 'default';
  reason: string;
  path: string;
}

export interface LoadStewardConfigOptions {
  /** Config file; defaults to `defaultStewardConfigPath()`. */
  path?: string;
  /** Injected for tests; defaults to a UTF-8 `readFileSync`. */
  readFile?: (path: string) => string;
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Env vars that hold ambient GitHub credentials (gh, Actions, Copilot tooling).
 * The steward token must be a dedicated variable: naming one of these would let
 * whatever token the process happens to inherit perform the merge.
 */
export const AMBIENT_GITHUB_TOKEN_ENVS: readonly string[] = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_PAT',
]);

/** True when `name` is an ambient GitHub token env var the steward must never read. */
export function isAmbientGithubTokenEnv(name: string): boolean {
  return AMBIENT_GITHUB_TOKEN_ENVS.includes(name.toUpperCase());
}

export const STEWARD_CONFIG_DEFAULTS: Readonly<StewardConfig> = Object.freeze({
  mergeEnabled: false,
  automationAccounts: Object.freeze([]) as readonly string[],
  tokenEnv: 'OPENSWARM_STEWARD_GH_TOKEN',
  mergeMethod: 'squash',
});

/** Unknown keys are rejected so a typo cannot pass silently. */
export const stewardConfigSchema = z
  .object({
    mergeEnabled: z.boolean().optional(),
    automationAccounts: z.array(z.string().regex(GITHUB_LOGIN, 'not a GitHub login')).optional(),
    tokenEnv: z
      .string()
      .regex(ENV_NAME, 'not an env var name')
      .refine((name) => !isAmbientGithubTokenEnv(name), 'names an ambient GitHub token env var; use a dedicated steward variable')
      .optional(),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).optional(),
  })
  .strict();

/** The operator's steward config file. */
export function defaultStewardConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENSWARM_STEWARD_CONFIG;
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.openswarm', 'steward', 'config.json');
}

function defaults(): StewardConfig {
  return { ...STEWARD_CONFIG_DEFAULTS, automationAccounts: [] };
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

/** Never throws. */
export function loadStewardConfig(options: LoadStewardConfigOptions = {}): StewardConfigLoad {
  const path = options.path ?? defaultStewardConfigPath();
  const fallback = (reason: string): StewardConfigLoad => ({ config: defaults(), source: 'default', reason, path });
  if (!isAbsolute(path)) return fallback(`steward config path ${JSON.stringify(path)} is not absolute; using defaults`);
  let raw: string;
  try {
    raw = (options.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path);
  } catch (err) {
    const code = errorCode(err);
    return fallback(
      code === 'ENOENT'
        ? `no steward config at ${path}; using defaults`
        : `steward config at ${path} is unreadable (${code}); using defaults`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return fallback(`steward config at ${path} is invalid JSON (${errorCode(err)}); using defaults`);
  }
  const parsed = stewardConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    return fallback(`steward config at ${path} is invalid (${issues}); using defaults`);
  }
  const d = parsed.data;
  const config: StewardConfig = {
    mergeEnabled: d.mergeEnabled === true,
    automationAccounts: [...(d.automationAccounts ?? [])],
    tokenEnv: d.tokenEnv ?? STEWARD_CONFIG_DEFAULTS.tokenEnv,
    mergeMethod: d.mergeMethod ?? STEWARD_CONFIG_DEFAULTS.mergeMethod,
  };
  return { config, source: 'file', reason: `loaded steward config from ${path}`, path };
}
