// ============================================
// OpenSwarm - adapter discovery/execution boundary
// ============================================

import type { CliAdapter } from './types.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

/**
 * Strict human-surface mode can inspect or execute only adapters whose tool
 * loop remains inside OpenSwarm's policy layer.  Apply this to discovery and
 * model-catalog calls too: delegated adapters may implement those "read" APIs
 * by launching the same PATH-resolved CLI that execution later rejects.
 */
export function adapterCanRunUnderHumanSurfaceBoundary(adapter: CliAdapter): boolean {
  return !isHumanSurfaceReadOnlyEnabled()
    || (typeof adapter.run === 'function' && adapter.capabilities.enforcesHumanSurfaceReadOnly === true);
}

export function assertAdapterCanRunUnderHumanSurfaceBoundary(adapter: CliAdapter): void {
  if (adapterCanRunUnderHumanSurfaceBoundary(adapter)) return;
  const reason = adapter.run
    ? 'does not declare enforcement of the strict human-surface boundary'
    : 'delegates to an external CLI with its own tool loop';
  throw new Error(
    `HUMAN_SURFACE_READ_ONLY: Adapter '${adapter.name}' ${reason}; `
    + 'arbitrary program execution is disabled while humanSurfaceReadOnly.enabled is true. '
    + 'Use a native OpenSwarm-loop adapter.',
  );
}

/** Return unavailable without invoking an unsafe delegated adapter probe. */
export async function probeAdapterAvailability(adapter: CliAdapter): Promise<boolean> {
  if (!adapterCanRunUnderHumanSurfaceBoundary(adapter)) return false;
  return adapter.isAvailable();
}

/** Resolve a model only after proving its adapter is allowed to perform I/O. */
export async function resolveBoundarySafeDefaultModel(adapter: CliAdapter): Promise<string> {
  assertAdapterCanRunUnderHumanSurfaceBoundary(adapter);
  return adapter.getDefaultModel();
}

/** List live models only after proving its adapter is allowed to perform I/O. */
export async function listBoundarySafeModels(adapter: CliAdapter): Promise<string[]> {
  assertAdapterCanRunUnderHumanSurfaceBoundary(adapter);
  return typeof adapter.listModels === 'function' ? adapter.listModels() : [];
}
