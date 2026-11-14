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
import type { PipelineResult } from '../agents/pairPipeline.js';

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

/** Lift a pause. Returns whether a row was removed. */
export function clearPauseInDb(db: Database.Database, projectPath?: string | null): boolean {
  db.exec(PAUSE_TABLE_DDL);
  const scope = pauseScopeKey(projectPath);
  return db.prepare('DELETE FROM automation_pauses WHERE scope = ?').run(scope).changes > 0;
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

// --------------------------------------------
// The daemon's side: one object the runner holds
// --------------------------------------------

interface PausableScheduler {
  getRunningTasks(): Array<{ task: { id: string } }>;
  cancelTask(taskId: string): boolean;
  cancelProjectTasks(projectPath: string): number;
}

interface PausedTask {
  issueId?: string;
  issueIdentifier?: string;
  title: string;
}

/**
 * What `AutonomousRunner` does with the pause table, kept out of the runner so
 * the runner only calls it at its three gates: the heartbeat, the candidate
 * loop, and `executeDurably` (a queued task can start minutes after the
 * heartbeat that admitted it, so that gate re-reads the table).
 */
export class RunnerPauseControl {
  private handle: FactoryPauseStore | undefined;
  private snapshot: PauseSnapshot = { projects: new Map() };

  constructor(private readonly resolveDbPath: () => string) {}

  get store(): FactoryPauseStore {
    this.handle ??= new FactoryPauseStore(this.resolveDbPath());
    return this.handle;
  }

  /**
   * Read the table once per heartbeat and act on it. Returns false when nothing
   * may be dispatched this heartbeat (a global pause, or an unreadable table).
   * `now` pauses cancel matching in-flight runs through the scheduler's abort
   * path, the same one disabling a project uses; `drain` pauses let them finish.
   */
  apply(scheduler: PausableScheduler, log: (line: string) => void, now = Date.now()): boolean {
    const snapshot = readPauseSnapshot(this.store);
    this.snapshot = snapshot;
    if (snapshot.unreadable) {
      log(`⏸ Pause table unreadable, holding dispatch: ${snapshot.unreadable}`);
      return false;
    }
    if (snapshot.global) {
      log(formatPauseLine(snapshot.global, now));
      if (snapshot.global.mode === 'now') {
        let cancelled = 0;
        for (const running of scheduler.getRunningTasks()) {
          if (scheduler.cancelTask(running.task.id)) cancelled++;
        }
        if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) (factory paused --now)`);
      }
      return false;
    }
    for (const [projectPath, pause] of snapshot.projects) {
      log(formatPauseLine(pause, now));
      if (pause.mode !== 'now') continue;
      const cancelled = scheduler.cancelProjectTasks(projectPath);
      if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) for paused project ${projectPath.split('/').pop()}`);
    }
    return true;
  }

  /** From the last heartbeat's snapshot: whether this repository is paused. */
  blocks(projectPath: string): boolean {
    return !!snapshotBlocks(this.snapshot, projectPath);
  }

  /**
   * A fresh read for a task about to execute. Returns the non-executing result
   * to hand back, or undefined to proceed. Fails closed.
   */
  pausedResult(task: PausedTask, projectPath: string): PipelineResult | undefined {
    let reason: string | undefined;
    try {
      reason = this.store.blocking(projectPath)?.reason;
    } catch (error) {
      reason = `pause table unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (reason === undefined) return undefined;
    return {
      success: false,
      sessionId: `factory-paused-${Date.now()}`,
      stages: [],
      finalStatus: 'superseded',
      totalDuration: 0,
      iterations: 0,
      taskContext: {
        issueIdentifier: task.issueIdentifier || task.issueId,
        projectPath,
        taskTitle: `${task.title} (factory paused: ${reason})`,
      },
    };
  }

  /** Dashboard read. */
  list(): { pauses: FactoryPause[]; error?: string } {
    try {
      return { pauses: this.store.list() };
    } catch (error) {
      return { pauses: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void {
    this.handle?.close();
    this.handle = undefined;
  }
}
