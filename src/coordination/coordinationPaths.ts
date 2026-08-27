// ============================================
// OpenSwarm - Coordination state paths
// ============================================
//
// A leaf module on purpose. `coordinationStore` sits in an import cycle with
// the event hub, and consumers that reach these helpers through the store were
// getting an uninitialised binding depending on which module the suite loaded
// first ("coordinationStateDir is not a function"). Nothing here imports
// anything from the project, so the cycle cannot reach it.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Absolute path of the coordination board file, honouring the test override. */
export function coordinationFilePath(): string {
  return resolve(process.env.OPENSWARM_COORDINATION_FILE ?? join(homedir(), '.openswarm', 'coordination.json'));
}

/**
 * Directory holding coordination state.
 *
 * Sibling state — the periodic-review locks — resolves through here so a test
 * that redirects the board also redirects everything beside it, instead of
 * reaching into the operator's real home directory.
 */
export function coordinationStateDir(): string {
  return dirname(coordinationFilePath());
}
