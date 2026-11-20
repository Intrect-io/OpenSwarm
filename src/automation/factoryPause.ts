// ============================================
// OpenSwarm - Factory kill switch (durable pause flag)
// ============================================
//
// On 2026-10-21 the only way to stop the factory for one repository was to
// comment it out of `autonomous.allowedProjects` and restart the daemon
// (AGT-4808). An unattended factory needs a stop that is one action and needs
// no restart, so the flag lives in the automation database:
//
// - it survives a daemon restart, because it is a row, not process memory;
// - every process that claims work sees it, because `RunLedger.claimRun`
//   reads it inside the same IMMEDIATE transaction as the claim
//   (the daemon, `openswarm work`, and `openswarm exec` all claim there);
// - the CLI and the dashboard write the same row, so either can lift it.
//
// Scope is either the whole factory (`*`) or one repository, keyed by the
// same `normalizeProjectPath` the ledger stores in `automation_runs.project_path`
// so a trailing slash or a relative path cannot miss.
//
// Mode says what happens to runs already in flight:
// - `drain`: they finish; nothing new is claimed.
// - `now`:   the daemon cancels them on its next heartbeat.
//
// Reads used by dispatch fail CLOSED: a kill switch that silently reads "not
// paused" whenever the database hiccups is not a kill switch. The ledger itself
// lives in this file, so an unreadable database already stops claims.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';

/** The scope key for a factory-wide pause. */
export const GLOBAL_PAUSE_SCOPE = '*';

export type PauseMode = 'drain' | 'now';

export interface FactoryPause {
  /** `*` for the whole factory, otherwise a normalized repository path. */
  scope: string;
  mode: PauseMode;
  reason: string;
  /** Who set it: `cli:<user>`, `dashboard`, `auto:<signal>`. */
  actor: string;
  createdAt: number;
}

export const PAUSE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS automation_pauses (
    scope TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('drain', 'now')),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_pause_lifts (
    scope TEXT PRIMARY KEY,
    lifted_at INTEGER NOT NULL
  );
`;

/** Normalize a CLI/dashboard scope argument into the stored key. */
export function pauseScopeKey(projectPath: string | undefined | null): string {
  if (projectPath == null || projectPath === GLOBAL_PAUSE_SCOPE) return GLOBAL_PAUSE_SCOPE;
  if (!projectPath.trim()) throw new Error('project path must not be empty');
  return normalizeProjectPath(projectPath);
}

interface PauseRow {
  scope: string;
  mode: PauseMode;
  reason: string;
  actor: string;
  created_at: number;
}

function toPause(row: PauseRow): FactoryPause {
  return { scope: row.scope, mode: row.mode, reason: row.reason, actor: row.actor, createdAt: row.created_at };
}

/** Every pause row, global first. Throws on a read failure; callers decide how to fail. */
export function listPausesInDb(db: Database.Database): FactoryPause[] {
  db.exec(PAUSE_TABLE_DDL);
  const rows = db.prepare(`
    SELECT scope, mode, reason, actor, created_at FROM automation_pauses
    ORDER BY CASE WHEN scope = '${GLOBAL_PAUSE_SCOPE}' THEN 0 ELSE 1 END, scope
  `).all() as PauseRow[];
  return rows.map(toPause);
}

/**
 * The pause that blocks this repository, if any. A global pause wins over a
 * per-project one. `projectPath` must already be normalized (ledger rows are).
 */
export function pauseBlockingInDb(db: Database.Database, normalizedProjectPath: string): FactoryPause | undefined {
  const rows = db.prepare(`
    SELECT scope, mode, reason, actor, created_at FROM automation_pauses
    WHERE scope IN ('${GLOBAL_PAUSE_SCOPE}', ?)
    ORDER BY CASE WHEN scope = '${GLOBAL_PAUSE_SCOPE}' THEN 0 ELSE 1 END
    LIMIT 1
  `).all(normalizedProjectPath) as PauseRow[];
  return rows[0] ? toPause(rows[0]) : undefined;
}

export interface SetPauseInput {
  projectPath?: string | null;
  mode?: PauseMode;
  reason?: string;
  actor: string;
}

/**
 * Write or replace a pause. Returns the stored row and whether a pause already
 * existed for that scope (so an auto-pause can alert only on the first trip).
 */
export function setPauseInDb(db: Database.Database, input: SetPauseInput, now = Date.now()): { pause: FactoryPause; existed: boolean } {
  db.exec(PAUSE_TABLE_DDL);
  const scope = pauseScopeKey(input.projectPath);
  const mode: PauseMode = input.mode ?? 'drain';
  if (mode !== 'drain' && mode !== 'now') throw new Error(`unknown pause mode: ${String(mode)}`);
  const reason = (input.reason ?? '').trim() || 'paused by operator';
  return db.transaction(() => {
    const prior = db.prepare('SELECT scope FROM automation_pauses WHERE scope = ?').get(scope);
    db.prepare(`
      INSERT INTO automation_pauses(scope, mode, reason, actor, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        mode = excluded.mode, reason = excluded.reason, actor = excluded.actor
    `).run(scope, mode, reason, input.actor, now);
    const row = db.prepare('SELECT scope, mode, reason, actor, created_at FROM automation_pauses WHERE scope = ?').get(scope) as PauseRow;
    return { pause: toPause(row), existed: !!prior };
  }).immediate();
}

/**
 * Lift a pause. Returns whether a row was removed. The lift time is kept so the
 * anomaly monitor (AGT-4809) does not re-trip on history it already acted on.
 */
export function clearPauseInDb(db: Database.Database, projectPath?: string | null, now = Date.now()): boolean {
  db.exec(PAUSE_TABLE_DDL);
  const scope = pauseScopeKey(projectPath);
  return db.transaction(() => {
    const removed = db.prepare('DELETE FROM automation_pauses WHERE scope = ?').run(scope).changes > 0;
    if (removed) {
      db.prepare(`
        INSERT INTO automation_pause_lifts(scope, lifted_at) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET lifted_at = excluded.lifted_at
      `).run(scope, now);
    }
    return removed;
  }).immediate();
}

// --------------------------------------------
// Process-level store (daemon heartbeat, CLI, dashboard)
// --------------------------------------------

/**
 * A handle on the automation database's pause table. Opened per use by the
 * CLI, and held by the daemon. The path is whatever the process configured
 * through `setAutomationDbPath` (or `OPENSWARM_AUTOMATION_DB`), which is the
 * same file the run ledger claims from.
 */
export class FactoryPauseStore {
  private db: Database.Database | undefined;

  constructor(private readonly dbPath: string = defaultAutomationDbPath()) {}

  get path(): string { return this.dbPath; }

  private connect(): Database.Database {
    if (this.db) return this.db;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.exec(PAUSE_TABLE_DDL);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  list(): FactoryPause[] { return listPausesInDb(this.connect()); }

  blocking(projectPath: string): FactoryPause | undefined {
    return pauseBlockingInDb(this.connect(), normalizeProjectPath(projectPath));
  }

  set(input: SetPauseInput, now = Date.now()): { pause: FactoryPause; existed: boolean } {
    return setPauseInDb(this.connect(), input, now);
  }

  clear(projectPath?: string | null): boolean { return clearPauseInDb(this.connect(), projectPath); }

  close(): void {
    if (this.db) { try { this.db.close(); } catch { /* already closed */ } }
    this.db = undefined;
  }
}

/**
 * What the heartbeat needs from the pause table, read once per heartbeat.
 * `unreadable` is set instead of throwing: dispatch then holds (fail closed)
 * but maintenance in the heartbeat keeps running.
 */
export interface PauseSnapshot {
  global?: FactoryPause;
  projects: Map<string, FactoryPause>;
  unreadable?: string;
}

export function readPauseSnapshot(store: Pick<FactoryPauseStore, 'list'>): PauseSnapshot {
  try {
    const pauses = store.list();
    const projects = new Map<string, FactoryPause>();
    let global: FactoryPause | undefined;
    for (const pause of pauses) {
      if (pause.scope === GLOBAL_PAUSE_SCOPE) global = pause;
      else projects.set(pause.scope, pause);
    }
    return { global, projects };
  } catch (error) {
    return { projects: new Map(), unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/** The pause, from a snapshot, that blocks this repository. */
export function snapshotBlocks(snapshot: PauseSnapshot, projectPath: string): FactoryPause | undefined {
  return snapshot.global ?? snapshot.projects.get(normalizeProjectPath(projectPath));
}

/** One heartbeat log line for a pause. */
export function formatPauseLine(pause: FactoryPause, now = Date.now()): string {
  const scope = pause.scope === GLOBAL_PAUSE_SCOPE ? 'factory' : pause.scope.split('/').pop() || pause.scope;
  const minutes = Math.max(0, Math.round((now - pause.createdAt) / 60_000));
  return `⏸ Paused (${scope}, ${pause.mode}) for ${minutes}m by ${pause.actor}: ${pause.reason}`;
}
