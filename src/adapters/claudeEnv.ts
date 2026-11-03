// ============================================
// OpenSwarm - environment and setting isolation for `claude -p` children
// ============================================
//
// A headless `claude -p` worker started with the CLI defaults inherits the
// operator's *interactive* setup: ~/.claude/CLAUDE.md (output language, report
// formats), user hooks, plugins, AskUserQuestion with a dialog timeout, the
// personal model/effort. Measured on CLI 2.1.317: a reviewer answered in the
// operator's language, two user hooks fired, and the context doubled
// (37.6k -> 17.1k tokens once isolated).
//
// Isolation is `--setting-sources`, which drops the user settings file — and
// with it any `env` block the operator authenticates through (a proxy
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN is common). So the auth variables,
// and only those, are lifted out of the settings file and handed to the child
// through its process environment. They are never written to disk or logged.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Settings-file env keys that carry Claude CLI authentication. Nothing else is copied. */
export const CLAUDE_AUTH_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;

/**
 * Variables a parent Claude Code session sets for itself. A child that
 * inherits them can mistake itself for part of that session (nested-session
 * guards, the parent's messaging socket, its session id).
 */
const PARENT_SESSION_EXACT = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const;
const PARENT_SESSION_PREFIXES = ['CLAUDE_CODE_MESSAGING_'] as const;

/** Opt-out: run claude children with the operator's full user settings, as before. */
export const INHERIT_USER_SETTINGS_ENV = 'OPENSWARM_CLAUDE_INHERIT_USER_SETTINGS';

export function inheritsUserSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[INHERIT_USER_SETTINGS_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(env.HOME || homedir(), '.claude');
}

function readSettingsEnv(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const env = (parsed as { env?: unknown }).env;
    if (!env || typeof env !== 'object') return {};
    const out: Record<string, string> = {};
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      const value = (env as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export type ClaudeAuthSource = 'env' | 'user-settings' | 'oauth-file' | 'none';

/**
 * Auth variables to inject into a claude child whose user settings are not
 * loaded. Empty when the parent env already authenticates (it wins) or when the
 * user settings carry no auth (the CLI then falls back to its OAuth file).
 * `settings.local.json` overrides `settings.json`, as in the CLI.
 */
export function resolveClaudeAuthEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (baseEnv.ANTHROPIC_API_KEY?.trim() || baseEnv.ANTHROPIC_AUTH_TOKEN?.trim()) return {};
  const dir = claudeConfigDir(baseEnv);
  const merged = { ...readSettingsEnv(join(dir, 'settings.json')), ...readSettingsEnv(join(dir, 'settings.local.json')) };
  if (!merged.ANTHROPIC_API_KEY && !merged.ANTHROPIC_AUTH_TOKEN) return {};
  // A base URL already in the parent env stays; only fill what is missing.
  if (baseEnv.ANTHROPIC_BASE_URL?.trim()) delete merged.ANTHROPIC_BASE_URL;
  return merged;
}

/** Where a claude child would get its credentials from. Names only; never values. */
export function describeClaudeAuthSource(baseEnv: NodeJS.ProcessEnv = process.env): ClaudeAuthSource {
  if (baseEnv.ANTHROPIC_API_KEY?.trim() || baseEnv.ANTHROPIC_AUTH_TOKEN?.trim()) return 'env';
  if (Object.keys(resolveClaudeAuthEnv(baseEnv)).length > 0) return 'user-settings';
  try {
    readFileSync(join(claudeConfigDir(baseEnv), '.credentials.json'));
    return 'oauth-file';
  } catch {
    return 'none';
  }
}

/**
 * Env overlay for a claude child (see `CliCommandSpec.env`): parent-session
 * variables removed, auth injected when user settings are not loaded.
 */
export function buildClaudeEnvOverlay(
  baseEnv: NodeJS.ProcessEnv,
  options: { loadsUserSettings: boolean },
): Record<string, string | undefined> {
  const overlay: Record<string, string | undefined> = {};
  for (const key of PARENT_SESSION_EXACT) overlay[key] = undefined;
  for (const key of Object.keys(baseEnv)) {
    if (PARENT_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) overlay[key] = undefined;
  }
  if (!options.loadsUserSettings) Object.assign(overlay, resolveClaudeAuthEnv(baseEnv));
  return overlay;
}
