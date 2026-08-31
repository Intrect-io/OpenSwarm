// ============================================
// OpenSwarm - `openswarm provider [name]`
// ============================================
//
// Show or switch the active AI provider from the terminal.
//
// The dashboard has had a provider toggle since INT-1901 (POST /api/provider
// switches the LIVE daemon and persists the choice), but the CLI could only
// READ the override (cli.ts). An operator whose provider ran out of quota had
// to open a browser or hand-edit provider-override.json and restart the daemon.
//
//   openswarm provider          → interactive picker (current provider preselected)
//   openswarm provider claude   → switch straight to the `claude -p` delegate
//
// A running daemon is switched in place; with no daemon we only record the
// override, which service.ts re-applies on the next boot.

import { isKnownAdapter, listAdapterNames } from '../adapters/index.js';
import type { AdapterName } from '../adapters/types.js';
import { readProviderOverride, writeProviderOverride } from '../core/providerOverride.js';
import { loadConfig } from '../core/config.js';
import { daemonAuthHeaders, daemonBaseUrl as baseUrl } from './daemonEndpoint.js';
import { DAEMON_PORT } from './daemon.js';

/**
 * One-line hints for the interactive picker. Names always come from the live
 * adapter registry — a hardcoded provider list is exactly what made the
 * dashboard reject `claude` in INT-1901 — so a registered adapter with no hint
 * here still shows up, just without a description.
 */
const PROVIDER_HINTS: Partial<Record<AdapterName, string>> = {
  'codex-responses': 'ChatGPT subscription (OAuth) — Codex models, native loop',
  codex: 'External codex CLI (delegated)',
  claude: 'Claude Code CLI (claude -p) — opt-in fallback',
  gpt: 'OpenAI ChatGPT OAuth (chat/completions)',
  openrouter: 'OpenRouter API key or OAuth (any model)',
  atlascloud: 'Atlas Cloud API key (OpenAI-compatible models)',
  lmstudio: 'Local LM Studio server (no account)',
  local: 'Local Ollama models (no account)',
};

/** Where the reported provider came from, in precedence order. */
export type ProviderSource = 'daemon' | 'override' | 'config';

export interface RoleSummary {
  role: string;
  adapter?: string;
  model?: string;
}

export interface ProviderStatus {
  active: AdapterName;
  source: ProviderSource;
  daemonRunning: boolean;
  /** Per-role adapter/model as the daemon currently sees it (daemon source only). */
  roles: RoleSummary[];
}

interface StatsAdapters {
  defaultAdapter?: string;
  [role: string]: unknown;
}


/** Ask the running daemon which adapter it is actually using right now. */
async function fetchDaemonAdapters(port: number, timeoutMs = 1500): Promise<StatsAdapters | null> {
  try {
    const res = await fetch(`${baseUrl(port)}/api/stats`, { headers: daemonAuthHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const stats = await res.json() as { adapters?: StatsAdapters };
    return stats.adapters ?? null;
  } catch {
    return null;
  }
}

function readRoles(adapters: StatsAdapters): RoleSummary[] {
  const roles: RoleSummary[] = [];
  for (const [role, value] of Object.entries(adapters)) {
    if (role === 'defaultAdapter' || value === null || typeof value !== 'object') continue;
    const entry = value as { adapter?: unknown; model?: unknown; enabled?: unknown };
    if (entry.enabled === false) continue;
    roles.push({
      role,
      adapter: typeof entry.adapter === 'string' ? entry.adapter : undefined,
      model: typeof entry.model === 'string' ? entry.model : undefined,
    });
  }
  return roles;
}

/** Same precedence the CLI boot path uses: live daemon → persisted override → config.yaml. */
export async function getProviderStatus(port = DAEMON_PORT): Promise<ProviderStatus> {
  const adapters = await fetchDaemonAdapters(port);
  const live = adapters?.defaultAdapter;
  if (typeof live === 'string' && isKnownAdapter(live)) {
    return { active: live, source: 'daemon', daemonRunning: true, roles: readRoles(adapters!) };
  }

  const override = readProviderOverride();
  if (override) return { active: override, source: 'override', daemonRunning: false, roles: [] };

  let configured: string | undefined;
  try {
    configured = loadConfig().adapter;
  } catch {
    // No readable config yet (fresh install) — fall through to the registry default.
  }
  const active = configured && isKnownAdapter(configured) ? configured : 'codex';
  return { active, source: 'config', daemonRunning: false, roles: [] };
}

export interface ApplyResult {
  /** True when a running daemon accepted the switch and is already using it. */
  live: boolean;
  /** Set when a reachable daemon refused the switch; nothing was persisted. */
  error?: string;
}

/**
 * Switch the active provider. A reachable daemon is switched in place so the
 * change applies to work already in flight; otherwise the override file alone
 * carries the choice into the next boot.
 */
export async function applyProvider(next: AdapterName, port = DAEMON_PORT): Promise<ApplyResult> {
  let reachable = false;
  try {
    const res = await fetch(`${baseUrl(port)}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...daemonAuthHeaders() },
      body: JSON.stringify({ provider: next }),
      signal: AbortSignal.timeout(5000),
    });
    reachable = true;
    if (!res.ok) {
      // The daemon is up but refused. Persisting the override anyway would leave
      // the file describing a provider the live process is not using.
      const detail = await res.text().catch(() => '');
      return {
        live: false,
        error: `daemon rejected the switch (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
  } catch {
    // Unreachable — no daemon to update, so the override file is the whole job.
  }

  // The daemon persists this itself via switchProvider(), but only when an
  // autonomous runner is attached. Writing here too is idempotent and covers
  // the dashboard-only daemon as well as the no-daemon case.
  writeProviderOverride(next);
  return { live: reachable };
}

function describeStatus(status: ProviderStatus): string[] {
  const where = status.source === 'daemon'
    ? 'live daemon'
    : status.source === 'override'
      ? 'saved override (daemon not running)'
      : 'config.yaml (daemon not running)';
  const lines = [`Provider: ${status.active}  (${where})`];
  for (const role of status.roles) {
    lines.push(`  ${role.role}: ${role.adapter ?? '?'}${role.model ? ` / ${role.model}` : ''}`);
  }
  return lines;
}

async function pickProvider(current: AdapterName): Promise<AdapterName | null> {
  const { select } = await import('@inquirer/prompts');
  try {
    return await select<AdapterName>({
      message: 'Select the AI provider',
      default: current,
      choices: listAdapterNames().map(name => ({
        name: name === current ? `${name} (current)` : name,
        value: name,
        description: PROVIDER_HINTS[name],
      })),
    });
  } catch {
    // Ctrl+C / Esc — @inquirer throws ExitPromptError rather than resolving.
    return null;
  }
}

/**
 * Entry point for `openswarm provider [name]`. Returns the process exit code
 * so cli.ts stays a thin registration layer.
 */
export async function runProviderCommand(requested?: string): Promise<number> {
  const status = await getProviderStatus();
  let target = requested;

  if (target === undefined) {
    // A picker needs a terminal. Piped/CI invocations get the status instead of
    // a prompt that would hang or render as garbage.
    if (!process.stdin.isTTY) {
      for (const line of describeStatus(status)) console.log(line);
      console.log(`\nPass a name to switch: openswarm provider <${listAdapterNames().join('|')}>`);
      return 0;
    }
    for (const line of describeStatus(status)) console.log(line);
    console.log('');
    const picked = await pickProvider(status.active);
    if (picked === null) {
      console.log('Cancelled — provider unchanged.');
      return 0;
    }
    target = picked;
  }

  if (!isKnownAdapter(target)) {
    console.error(`Unknown provider "${target}". Valid: ${listAdapterNames().join(', ')}`);
    return 1;
  }

  if (target === status.active && status.source === 'daemon') {
    console.log(`Already running on "${target}" — nothing to do.`);
    return 0;
  }

  const result = await applyProvider(target);
  if (result.error) {
    console.error(`Provider switch failed: ${result.error}`);
    return 1;
  }

  if (result.live) {
    console.log(`Provider switched to "${target}" — the running daemon is using it now.`);
  } else {
    console.log(`Provider set to "${target}". No daemon is running; it applies on the next start.`);
  }
  return 0;
}
