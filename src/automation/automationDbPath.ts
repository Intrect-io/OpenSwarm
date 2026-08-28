// ============================================
// OpenSwarm - Automation database path
// ============================================
//
// A leaf module with no native dependencies, so consumers can learn where the
// automation database lives without importing `runLedger` — which pulls in
// better-sqlite3 eagerly and would defeat any lazy loading around it.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

let configured: string | null = null;

/**
 * Point every automation store at the database this deployment configured.
 *
 * The run ledger is handed its path explicitly, but the coordination trace is
 * not — and since the trace stopped being a pure archive and became what says
 * whether a parked run may be re-admitted, the two have to be the same file. A
 * deployment that relocates its automation database must take the answers with
 * it, or the runs move and what is known about them stays behind.
 *
 * Resolving both through here is what makes that hold by construction, rather
 * than by every new consumer remembering to ask.
 *
 * Declared once per process, at the point the process learns its configuration —
 * a process has one automation database, the same way it has one coordination
 * board. Callers that build a runner without going through that point (tests)
 * redirect every store together with `OPENSWARM_AUTOMATION_DB` instead.
 */
export function setAutomationDbPath(path: string | undefined): void {
  configured = path ? resolve(path) : null;
}

/**
 * Absolute path of the automation database.
 *
 * The environment override wins: tests redirect every automation store at once
 * by setting it, and must not be overruled by whatever config a runner under
 * test was constructed with.
 */
export function defaultAutomationDbPath(): string {
  if (process.env.OPENSWARM_AUTOMATION_DB) return resolve(process.env.OPENSWARM_AUTOMATION_DB);
  return configured ?? resolve(homedir(), '.openswarm', 'automation.db');
}
