// ============================================
// OpenSwarm - Run ledger schema
// ============================================
//
// Table/index definitions and the forward migration for automation.db. Kept
// beside the ledger rather than inside it so the ~130 lines of DDL do not
// crowd out the run-state logic that actually changes.

import type Database from 'better-sqlite3';
import { AUTOMATION_SCHEMA_VERSION } from './runLedgerTypes.js';

export function migrateAutomationSchema(db: Database.Database): void {
    const migrate = db.transaction(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS automation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        issue_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        identifier TEXT,
        title TEXT,
        project_path TEXT NOT NULL,
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1,
        attempt_no INTEGER NOT NULL DEFAULT 0,
        owner_instance_id TEXT,
        lease_token TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        retry_at INTEGER,
        branch_name TEXT,
        worktree_path TEXT,
        pr_url TEXT,
        head_sha TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        discovered_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        tracker_state TEXT,
        tracker_state_type TEXT,
        tracker_checked_at INTEGER,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS automation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        lease_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        result_status TEXT,
        success INTEGER,
        cost_usd REAL,
        UNIQUE(issue_id, attempt_no),
        FOREIGN KEY (issue_id) REFERENCES automation_runs(issue_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS automation_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        owner_instance_id TEXT,
        delivery_token TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        FOREIGN KEY (issue_id) REFERENCES automation_runs(issue_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS automation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        attempt_no INTEGER,
        kind TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        data_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES automation_runs(issue_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS automation_repo_circuits (
        project_path TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        open_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_integration_reservations (
        project_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,
        reservation_token TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_path, branch_name),
        UNIQUE(project_path, issue_identifier)
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_state_retry
        ON automation_runs(state, retry_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_project_state
        ON automation_runs(project_path, state, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_worktree
        ON automation_runs(worktree_path) WHERE worktree_path IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_automation_effects_delivery
        ON automation_effects(status, available_at, lease_expires_at, id);
      CREATE INDEX IF NOT EXISTS idx_automation_events_issue
        ON automation_events(issue_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_automation_integration_reservations_expiry
        ON automation_integration_reservations(lease_expires_at);
    `);

    // v1 -> v2 is additive and safe under WAL. SQLite has no ADD COLUMN IF NOT
    // EXISTS, so inspect first for idempotent crash-restart migration.
      const attemptColumns = new Set(
        (db.pragma('table_info(automation_attempts)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!attemptColumns.has('result_status')) db.exec('ALTER TABLE automation_attempts ADD COLUMN result_status TEXT');
      if (!attemptColumns.has('success')) db.exec('ALTER TABLE automation_attempts ADD COLUMN success INTEGER');
      if (!attemptColumns.has('cost_usd')) db.exec('ALTER TABLE automation_attempts ADD COLUMN cost_usd REAL');
      // Distinguishes an infra_error caused by the repository itself (disk
      // full, a stale .git lock, a corrupt repo) from one caused by an
      // adapter timeout, tooling failure, or network blip — only the former
      // should count toward the repository failure circuit (AGT-4038).
      if (!attemptColumns.has('repository_infra')) db.exec('ALTER TABLE automation_attempts ADD COLUMN repository_infra INTEGER');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_attempts_budget
        ON automation_attempts(started_at, success, cost_usd)`);

      // v2 -> v3: cache explicit tracker observations beside the run they
      // reconcile. A still-open issue is then rechecked on a bounded cadence
      // instead of spending one Linear request on every heartbeat (AGT-4127).
      const runColumns = new Set(
        (db.pragma('table_info(automation_runs)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!runColumns.has('tracker_state')) db.exec('ALTER TABLE automation_runs ADD COLUMN tracker_state TEXT');
      if (!runColumns.has('tracker_state_type')) db.exec('ALTER TABLE automation_runs ADD COLUMN tracker_state_type TEXT');
      if (!runColumns.has('tracker_checked_at')) db.exec('ALTER TABLE automation_runs ADD COLUMN tracker_checked_at INTEGER');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_tracker_reconcile
        ON automation_runs(source, state, tracker_checked_at, updated_at)`);

      const current = db.prepare('SELECT value FROM automation_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
      if (current && Number(current.value) > AUTOMATION_SCHEMA_VERSION) {
        throw new Error(`automation.db schema ${current.value} is newer than supported ${AUTOMATION_SCHEMA_VERSION}`);
      }
      db.prepare(`
        INSERT INTO automation_meta(key, value) VALUES('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(AUTOMATION_SCHEMA_VERSION));
    });
    // Schema inspection + ALTER must be one writer-serialized unit. Two daemon
    // generations can overlap during launchd restart; a deferred migration lets
    // both observe the old schema and race the same ADD COLUMN.
    migrate.immediate();
}
