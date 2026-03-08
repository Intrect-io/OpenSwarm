// ============================================
// OpenSwarm - CLI Adapter Registry
// Barrel exports + adapter lookup
// ============================================

export type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
  ProcessContext,
} from './types.js';

export { spawnCli } from './base.js';
export { ClaudeCliAdapter } from './claude.js';
export { registerProcess, getProcess, getAllProcesses, killProcess, startHealthChecker, stopHealthChecker } from './processRegistry.js';

// CryptoQuant adapter exports
export type { USDCNetflowData, RiskOnSignal, CryptoQuantConfig } from './cryptoQuantAdapter.js';
export { CryptoQuantAdapter, initCryptoQuantAdapter, getCryptoQuantAdapter } from './cryptoQuantAdapter.js';

import { ClaudeCliAdapter } from './claude.js';
import type { CliAdapter } from './types.js';

const adapters: Record<string, CliAdapter> = {
  claude: new ClaudeCliAdapter(),
};

/**
 * Get an adapter by name. Defaults to 'claude'.
 */
export function getAdapter(name: string = 'claude'): CliAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
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
