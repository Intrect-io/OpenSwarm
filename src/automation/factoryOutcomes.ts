// ============================================
// OpenSwarm - Recorded run outcomes for the factory digest (AGT-4810)
// ============================================
//
// Three facts the digest's KPIs need and the ledger did not keep:
// - the GitHub state of a run's PR, recorded every time the merge sweep
//   (reconcileMergedPublications) reads it. A change counts as completed only
//   when GitHub said MERGED; the tracker's Done is never used for that;
// - post-merge defects: a revert or a hotfix linked to the run whose merge it
//   repairs, recorded by the operator (`openswarm outcome defect`);
// - wrong dispatches: a run the operator marks "should not have run"
//   (`openswarm outcome wrong-dispatch`).
//
// The tables are additive (CREATE IF NOT EXISTS), created by the schema
// migration and again by every writer, so a CLI against an older database
// still works. Readers must check the table exists: the digest opens the
// database read-only.

import Database from 'better-sqlite3';

export const OUTCOME_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS automation_pr_states (
    pr_url TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'MERGED')),
    merged_at INTEGER,
    merge_commit TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_pr_states_merged
    ON automation_pr_states(state, merged_at);
  CREATE TABLE IF NOT EXISTS automation_run_defects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('revert', 'hotfix')),
    at INTEGER NOT NULL,
    ref TEXT,
    actor TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_run_defects_issue
    ON automation_run_defects(issue_id, at);
  CREATE TABLE IF NOT EXISTS automation_dispatch_marks (
    issue_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    marked_at INTEGER NOT NULL
  );
`;

export type DefectKind = 'revert' | 'hotfix';
export const DEFECT_KINDS: readonly DefectKind[] = ['revert', 'hotfix'];

/** What the merge sweep read from GitHub (a subset of PRLifecycle). */
export interface PullRequestStateObservation {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string;
  mergeCommitOid?: string;
}

/**
 * Upsert the PR's latest GitHub state for a run. Never throws: a ledger write
 * failure must not stop the sweep from moving the tracker, so it is logged and
 * reported as `false`. A MERGED row without GitHub's merge time keeps the time
 * it was first observed merged, so it still falls in exactly one digest day.
 */
export function recordPullRequestStateInDb(
  db: Database.Database,
  issueId: string,
  prUrl: string,
  pr: PullRequestStateObservation,
  now = Date.now(),
): boolean {
  try {
    db.exec(OUTCOME_TABLE_DDL);
    const parsed = pr.mergedAt ? Date.parse(pr.mergedAt) : Number.NaN;
    const mergedAt = pr.state !== 'MERGED' ? null : Number.isNaN(parsed) ? now : parsed;
    db.prepare(`
      INSERT INTO automation_pr_states(pr_url, issue_id, state, merged_at, merge_commit, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_url) DO UPDATE SET
        issue_id = excluded.issue_id,
        state = excluded.state,
        merged_at = COALESCE(automation_pr_states.merged_at, excluded.merged_at),
        merge_commit = COALESCE(excluded.merge_commit, automation_pr_states.merge_commit),
        observed_at = excluded.observed_at
    `).run(prUrl, issueId, pr.state, mergedAt, pr.mergeCommitOid ?? null, now);
    return true;
  } catch (error) {
    console.warn(`[FactoryOutcomes] Could not record PR state of ${prUrl}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/** Resolve a run by issue id or tracker identifier (AGT-123). */
function resolveRunId(db: Database.Database, issue: string): string {
  const row = db.prepare('SELECT issue_id AS id FROM automation_runs WHERE issue_id = ? OR identifier = ? ORDER BY issue_id = ? DESC LIMIT 1')
    .get(issue, issue, issue) as { id: string } | undefined;
  if (!row) throw new Error(`no run for '${issue}' in the automation database`);
  return row.id;
}

export function recordDefectInDb(
  db: Database.Database,
  input: { issue: string; kind: DefectKind; at: number; ref?: string; actor: string },
  now = Date.now(),
): { issueId: string } {
  if (!DEFECT_KINDS.includes(input.kind)) throw new Error(`defect kind must be one of ${DEFECT_KINDS.join(', ')}`);
  if (!Number.isFinite(input.at)) throw new Error('defect time is invalid');
  db.exec(OUTCOME_TABLE_DDL);
  const issueId = resolveRunId(db, input.issue);
  db.prepare('INSERT INTO automation_run_defects(issue_id, kind, at, ref, actor, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(issueId, input.kind, input.at, input.ref ?? null, input.actor, now);
  return { issueId };
}

/** Mark a run "should not have run". One mark per run; marking again replaces the reason. */
export function markWrongDispatchInDb(
  db: Database.Database,
  input: { issue: string; reason: string; actor: string },
  now = Date.now(),
): { issueId: string } {
  if (!input.reason.trim()) throw new Error('a reason is required');
  db.exec(OUTCOME_TABLE_DDL);
  const issueId = resolveRunId(db, input.issue);
  db.prepare(`
    INSERT INTO automation_dispatch_marks(issue_id, reason, actor, marked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET reason = excluded.reason, actor = excluded.actor, marked_at = excluded.marked_at
  `).run(issueId, input.reason, input.actor, now);
  return { issueId };
}

/** Open the existing automation database for one CLI write (the daemon may hold it too). */
export function openOutcomeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.exec(OUTCOME_TABLE_DDL);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
