// ============================================
// OpenSwarm - CLI Adapter Registry
// Barrel exports + adapter lookup
// ============================================

export type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  AdapterName,
  WorkerResult,
  ReviewResult,
  ProcessContext,
} from './types.js';

export { spawnCli } from './base.js';
export { CodexCliAdapter } from './codex.js';
export { CodexResponsesAdapter } from './codexResponses.js';
export { GptCliAdapter } from './gpt.js';
export { LocalModelAdapter } from './local.js';
export { LmStudioAdapter } from './lmstudio.js';
export { OpenRouterCliAdapter } from './openrouter.js';
export { AtlasCloudCliAdapter } from './atlascloud.js';
export { ClaudeCliAdapter } from './claude.js';
export { CcRouterAdapter } from './ccRouter.js';
export { CursorCliAdapter } from './cursor.js';
export { registerProcess, getProcess, getAllProcesses, killProcess, startHealthChecker, stopHealthChecker } from './processRegistry.js';

import { CodexCliAdapter } from './codex.js';
import { CodexResponsesAdapter } from './codexResponses.js';
import { GptCliAdapter } from './gpt.js';
import { LocalModelAdapter } from './local.js';
import { LmStudioAdapter } from './lmstudio.js';
import { OpenRouterCliAdapter } from './openrouter.js';
import { AtlasCloudCliAdapter } from './atlascloud.js';
import { ClaudeCliAdapter } from './claude.js';
import { CcRouterAdapter } from './ccRouter.js';
import { CursorCliAdapter } from './cursor.js';
import type { AdapterName, CliAdapter } from './types.js';

const adapters: Record<string, CliAdapter> = {
  codex: new CodexCliAdapter(),
  'codex-responses': new CodexResponsesAdapter(),
  gpt: new GptCliAdapter(),
  local: new LocalModelAdapter(),
  lmstudio: new LmStudioAdapter(),
  openrouter: new OpenRouterCliAdapter(),
  atlascloud: new AtlasCloudCliAdapter(),
  // claude -p CLI delegate — opt-in fallback (Anthropic hasn't blocked it). Offered
  // by `openswarm init` and the dashboard provider switch, so it must be registered.
  claude: new ClaudeCliAdapter(),
  'cc-router': new CcRouterAdapter(),
  cursor: new CursorCliAdapter(),
};

let defaultAdapter: AdapterName = 'codex';

/**
 * Get an adapter by name. Defaults to 'codex'.
 */
export function getAdapter(name: string = defaultAdapter): CliAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
}

export function setDefaultAdapter(name: AdapterName): void {
  if (!adapters[name]) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  }
  defaultAdapter = name;
}

export function getDefaultAdapterName(): AdapterName {
  return defaultAdapter;
}

/**
 * True if `name` is a currently-registered adapter. Used to reject stale or
 * unknown persisted provider names instead of crashing downstream.
 */
export function isKnownAdapter(name: string): name is AdapterName {
  return Object.prototype.hasOwnProperty.call(adapters, name);
}

/** Names of every registered adapter (for validation messages / UI). */
export function listAdapterNames(): AdapterName[] {
  return Object.keys(adapters) as AdapterName[];
}

/**
 * List adapters that are currently installed and available.
 */
export async function listAvailableAdapters(): Promise<string[]> {
  const results: string[] = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    if (await adapter.isAvailable()) {
      results.push(name);
    }
  }
  return results;
}
