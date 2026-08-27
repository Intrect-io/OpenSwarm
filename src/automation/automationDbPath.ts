// ============================================
// OpenSwarm - Automation database path
// ============================================
//
// A leaf module with no native dependencies, so consumers can learn where the
// automation database lives without importing `runLedger` — which pulls in
// better-sqlite3 eagerly and would defeat any lazy loading around it.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Absolute path of the automation database, honouring the test override. */
export function defaultAutomationDbPath(): string {
  return process.env.OPENSWARM_AUTOMATION_DB
    ? resolve(process.env.OPENSWARM_AUTOMATION_DB)
    : resolve(homedir(), '.openswarm', 'automation.db');
}
