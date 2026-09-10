import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export interface ServiceInstanceLock {
  readonly path: string;
  release(): void;
}

/**
 * Acquire a process-lifetime SQLite writer lock (`BEGIN IMMEDIATE`).
 * Used for the daemon instance lock and, during AGT-4024, the task-state
 * store mutex at `~/.openswarm/task-state-lock.db`.
 *
 * Port probing alone is a check-then-bind TOCTOU: two processes can both
 * observe a free port and connect side-effecting services before one loses
 * the later listen(2). SQLite's writer lock is kernel-owned and is released on
 * crash, so it does not need unsafe stale-PID deletion.
 */
export function acquireServiceInstanceLock(
  path = process.env.OPENSWARM_SERVICE_LOCK_FILE
    ?? join(homedir(), '.openswarm', 'service-instance-lock.db'),
): ServiceInstanceLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: 0 });
  chmodSync(path, 0o600);
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
      throw new Error('Another OpenSwarm service process owns the instance lock', { cause: error });
    }
    throw error;
  }

  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try { db.exec('ROLLBACK'); } finally { db.close(); }
    },
  };
}
