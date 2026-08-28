import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { enableWalWithRetry } from '../support/sqliteWal.js';
import { defaultAutomationDbPath } from './automationDbPath.js';
import {
  ACTIVE_LEASE_STATES, ALLOWED_TRANSITIONS, AUTOMATION_SCHEMA_VERSION,
  CLAIMABLE_STATES, NON_FAILURE_RESULT_STATUSES, RUN_STATES,
} from './runLedgerTypes.js';
import { admitsConflictScope } from './runLedgerScope.js';
import { migrateAutomationSchema } from './runLedgerSchema.js';
import type {
  AttemptResultInput,
  ClaimOptions,
  EffectClaim,
  EffectInput,
  EffectRecord,
  EffectStatus,
  ImportRunInput,
  LedgerMetrics,
  RegisterRunInput,
  RunClaim,
  RunLedgerOptions,
  RunRecord,
  RunState,
  TransitionPatch,
} from './runLedgerTypes.js';

export { AUTOMATION_SCHEMA_VERSION, RUN_STATES, NON_FAILURE_RESULT_STATUSES } from './runLedgerTypes.js';

export type {
  AttemptResultInput,
  ClaimOptions,
  EffectClaim,
  EffectInput,
  EffectRecord,
  EffectStatus,
  ImportRunInput,
  LedgerMetrics,
  RegisterRunInput,
  RunClaim,
  RunLedgerMode,
  RunLedgerOptions,
  RunRecord,
  RunState,
  TransitionPatch,
} from './runLedgerTypes.js';

interface RunRow {
  issue_id: string;
  source: string;
  identifier: string | null;
  title: string | null;
  project_path: string;
  state: string;
  state_version: number;
  attempt_no: number;
  owner_instance_id: string | null;
  lease_token: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  retry_at: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  head_sha: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  discovered_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  metadata_json: string | null;
}

interface EffectRow {
  id: number;
  issue_id: string;
  attempt_no: number;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  status: EffectStatus;
  attempts: number;
  available_at: number;
  owner_instance_id: string | null;
  delivery_token: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

function parseJson(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function assertRunState(value: string): asserts value is RunState {
  if (!(RUN_STATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown automation run state: ${value}`);
  }
}

export { defaultAutomationDbPath } from './automationDbPath.js';

/**
 * Durable execution truth for the issue-driven loop.
 *
 * Every mutating operation is a single SQLite transaction or compare-and-swap.
 * Execution callbacks must present the current lease token + monotonically
 * increasing epoch, so a timed-out worker cannot commit state after replacement.
 */
export class RunLedger {
  private readonly db: Database.Database;
  private closed = false;

  constructor(dbPath = defaultAutomationDbPath(), options: RunLedgerOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error('busyTimeoutMs must be a non-negative safe integer');
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      // Install the wait policy before WAL/schema pragmas: overlapping launchd
      // generations can contend as soon as journal_mode is negotiated.
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      enableWalWithRetry(this.db, busyTimeoutMs);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = FULL');
      migrateAutomationSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }


  registerRun(input: RegisterRunInput, now = Date.now()): RunRecord {
    if (!input.issueId.trim()) throw new Error('issueId is required');
    if (!input.projectPath.trim()) throw new Error('projectPath is required');
    const initialState: RunState = input.ready === false ? 'DISCOVERED' : 'READY';
    const register = this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO automation_runs(
          issue_id, source, identifier, title, project_path, state,
          discovered_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.issueId,
        input.source,
        input.identifier ?? null,
        input.title ?? null,
        input.projectPath,
        initialState,
        now,
        now,
        stringifyJson(input.metadata),
      );

      if (inserted.changes === 1) {
        this.insertEvent(input.issueId, 0, 'registered', null, initialState, input.metadata, now);
      } else {
        // Discovery may refresh descriptive fields, but never rewinds execution.
        this.db.prepare(`
          UPDATE automation_runs
          SET source = ?, identifier = COALESCE(?, identifier), title = COALESCE(?, title),
              project_path = CASE
                WHEN owner_instance_id IS NULL AND state NOT IN ('SYNC_PENDING', 'NEEDS_RECONCILE') THEN ?
                ELSE project_path
              END,
              metadata_json = COALESCE(?, metadata_json), updated_at = ?
          WHERE issue_id = ?
        `).run(
          input.source,
          input.identifier ?? null,
          input.title ?? null,
          input.projectPath,
          stringifyJson(input.metadata),
          now,
          input.issueId,
        );
      }
    });
    register.immediate();
    return this.getRun(input.issueId)!;
  }

  /**
   * Lazy, per-issue cutover from legacy JSON/task-state projections. Import is
   * insert-only: once any durable record exists, legacy state can no longer
   * overwrite it. Active lease states and SYNC_PENDING are intentionally not
   * importable because legacy files cannot prove ownership or remote effects.
   */
  importRun(input: ImportRunInput, now = Date.now()): { record: RunRecord; imported: boolean } {
    if (!input.issueId.trim()) throw new Error('issueId is required');
    if (!input.projectPath.trim()) throw new Error('projectPath is required');
    const importState = this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO automation_runs(
          issue_id, source, identifier, title, project_path, state,
          retry_at, branch_name, worktree_path, last_error_code, last_error_message,
          discovered_at, updated_at, completed_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.issueId,
        input.source,
        input.identifier ?? null,
        input.title ?? null,
        input.projectPath,
        input.state,
        input.state === 'RETRY_AT' ? (input.retryAt ?? now) : null,
        input.branchName ?? null,
        input.worktreePath ?? null,
        input.errorCode ?? 'legacy_import',
        input.errorMessage ?? 'Imported from legacy runner/task state',
        now,
        now,
        ['DONE', 'DECOMPOSED', 'CANCELLED'].includes(input.state) ? now : null,
        stringifyJson(input.metadata),
      );
      if (inserted.changes === 1) {
        this.insertEvent(input.issueId, 0, 'legacy_imported', null, input.state, input.metadata, now);
      }
      return inserted.changes === 1;
    });
    const imported = importState.immediate();
    return { record: this.getRun(input.issueId)!, imported };
  }

  getRun(issueId: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
    return row ? this.toRun(row) : null;
  }

  listRuns(states?: readonly RunState[]): RunRecord[] {
    const rows = states && states.length > 0
      ? this.db.prepare(`SELECT * FROM automation_runs WHERE state IN (${placeholders(states)}) ORDER BY updated_at`).all(...states) as RunRow[]
      : this.db.prepare('SELECT * FROM automation_runs ORDER BY updated_at').all() as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  markReady(issueId: string, now = Date.now()): boolean {
    const eligible: readonly RunState[] = [
      'DISCOVERED', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_SPEC', 'NEEDS_ENV',
      'NEEDS_HUMAN', 'NEEDS_RECONCILE', 'DONE', 'DECOMPOSED', 'CANCELLED',
    ];
    return this.unfencedTransition(issueId, eligible, 'READY', {}, now);
  }

  /**
   * Promote a run only while it is still parked on the operator.
   *
   * The park is re-read inside the promoting transaction rather than trusted from
   * the caller. Between a caller's read and this write the parked attempt can end
   * and a new one fail for its own reasons, and pulling *that* one forward is the
   * fast-retry loop the backoff exists to prevent.
   */
  readmitParkedRun(issueId: string, parkCode: string, now = Date.now()): boolean {
    return this.unfencedTransition(issueId, ['RETRY_AT'], 'READY', {}, now, parkCode);
  }

  /** Release a lost lease only after its executor has actually returned. */
  confirmExecutorExit(
    ownership: Pick<RunClaim,
      'issueId' | 'ownerInstanceId' | 'leaseToken' | 'leaseEpoch' | 'attemptNo'>,
    now = Date.now(),
  ): boolean {
    const confirm = this.db.transaction(() => {
      let row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(ownership.issueId) as RunRow | undefined;
      if (
        !row
        || row.owner_instance_id !== ownership.ownerInstanceId
        || row.lease_token !== ownership.leaseToken
        || row.lease_epoch !== ownership.leaseEpoch
        || row.attempt_no !== ownership.attemptNo
      ) return false;
      assertRunState(row.state);

      if (ACTIVE_LEASE_STATES.includes(row.state) && (row.lease_expires_at == null || row.lease_expires_at <= now)) {
        if (this.reconcileExpiredRows([row], now).length !== 1) return false;
        row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(ownership.issueId) as RunRow;
      }
      if (row.state !== 'NEEDS_RECONCILE') return false;

      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET owner_instance_id = NULL, lease_token = NULL, updated_at = ?
        WHERE issue_id = ? AND state = 'NEEDS_RECONCILE'
          AND owner_instance_id = ? AND lease_token = ? AND lease_epoch = ?
          AND attempt_no = ?
      `).run(
        now,
        ownership.issueId,
        ownership.ownerInstanceId,
        ownership.leaseToken,
        ownership.leaseEpoch,
        ownership.attemptNo,
      );
      if (updated.changes !== 1) return false;
      this.insertEvent(ownership.issueId, ownership.attemptNo, 'executor_exited',
        'NEEDS_RECONCILE', 'NEEDS_RECONCILE',
        { ownerInstanceId: ownership.ownerInstanceId, leaseEpoch: ownership.leaseEpoch }, now);
      return true;
    });
    return confirm.immediate();
  }

  /** Back off only an unowned claim candidate. A concurrent winner changes the
   * state/version first, so this CAS cannot suspend another daemon's lease. */
  deferUnclaimedRun(issueId: string, retryAt: number, reason: string, now = Date.now()): boolean {
    if (!Number.isFinite(retryAt) || retryAt <= now) throw new Error('retryAt must be in the future');
    const defer = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || !['READY', 'RETRY_AT'].includes(row.state)) return false;
      assertRunState(row.state);
      if (!ALLOWED_TRANSITIONS[row.state].includes('RETRY_AT')) return false;
      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'RETRY_AT', state_version = state_version + 1,
            retry_at = ?, last_error_code = 'claim_deferred',
            last_error_message = ?, updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND state = ?
          AND owner_instance_id IS NULL AND lease_token IS NULL
      `).run(retryAt, reason, now, issueId, row.state_version, row.state);
      if (updated.changes !== 1) return false;
      this.insertEvent(issueId, row.attempt_no, 'claim_deferred', row.state as RunState, 'RETRY_AT', {
        retryAt,
        reason,
      }, now);
      return true;
    });
    return defer.immediate();
  }

  /** Return the active repository-circuit deadline blocking this issue. */
  getCircuitOpenUntil(issueId: string, now = Date.now()): number | undefined {
    const row = this.db.prepare(`
      SELECT c.open_until
      FROM automation_runs r
      JOIN automation_repo_circuits c ON c.project_path = r.project_path
      WHERE r.issue_id = ? AND c.open_until > ?
    `).get(issueId, now) as { open_until: number } | undefined;
    return row?.open_until;
  }

  /** Explicit operator recovery from NEEDS_HUMAN. A dead external effect resumes
   * synchronization; only implementation failures return to READY. */
  resumeNeedsHuman(issueId: string, now = Date.now()): RunState | null {
    const resume = this.db.transaction((): RunState | null => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || row.state !== 'NEEDS_HUMAN') return null;
      const deadEffects = (this.db.prepare(`
        SELECT COUNT(*) AS count FROM automation_effects
        WHERE issue_id = ? AND status = 'dead'
      `).get(issueId) as { count: number }).count;
      const to: RunState = deadEffects > 0 ? 'SYNC_PENDING' : 'READY';
      if (!ALLOWED_TRANSITIONS.NEEDS_HUMAN.includes(to)) return null;

      if (deadEffects > 0) {
        this.db.prepare(`
          UPDATE automation_effects
          SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL,
              owner_instance_id = NULL, delivery_token = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE issue_id = ? AND status = 'dead'
        `).run(now, now, issueId);
      }
      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = ?, state_version = state_version + 1,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE issue_id = ? AND state = 'NEEDS_HUMAN' AND state_version = ?
      `).run(to, now, issueId, row.state_version);
      if (updated.changes !== 1) return null;
      this.insertEvent(issueId, row.attempt_no, 'operator_resumed', 'NEEDS_HUMAN', to, {
        deadEffectsReset: deadEffects,
      }, now);
      return to;
    });
    return resume.immediate();
  }

  claimRun(issueId: string, options: ClaimOptions): RunClaim | null {
    assertPositiveDuration(options.leaseMs, 'leaseMs');
    const now = options.now ?? Date.now();
    const maxActive = Math.max(1, Math.floor(options.maxActiveForProject ?? 1));
    const token = randomUUID();

    const claim = this.db.transaction((): RunClaim | null => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row) return null;
      assertRunState(row.state);

      // Do not let a dead owner remain an invisible permanent admission block,
      // and do not solve that liveness problem by simply ignoring its lease.
      // Atomically park every expired owner in this repository first. The
      // resulting NEEDS_RECONCILE row continues to consume a repository slot
      // until artifact/owner evidence proves that new work is safe.
      const expiredOwners = this.db.prepare(`
        SELECT * FROM automation_runs
        WHERE project_path = ?
          AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY updated_at
      `).all(row.project_path, ...ACTIVE_LEASE_STATES, now) as RunRow[];
      if (expiredOwners.length > 0) {
        this.reconcileExpiredRows(expiredOwners, now);
        return null;
      }

      if (!CLAIMABLE_STATES.includes(row.state)) return null;
      if (row.state === 'RETRY_AT' && row.retry_at != null && row.retry_at > now) return null;

      const circuit = this.db.prepare(`
        SELECT reason, open_until FROM automation_repo_circuits WHERE project_path = ?
      `).get(row.project_path) as { reason: string; open_until: number } | undefined;
      if (circuit && circuit.open_until > now) return null;
      if (circuit) {
        this.db.prepare('DELETE FROM automation_repo_circuits WHERE project_path = ?').run(row.project_path);
      }

      const openCircuit = (reason: string): void => {
        const cooldownMs = Math.max(60_000, options.circuitCooldownMs ?? 60 * 60_000);
        this.db.prepare(`
          INSERT INTO automation_repo_circuits(project_path, reason, opened_at, open_until, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_path) DO UPDATE SET
            reason = excluded.reason, opened_at = excluded.opened_at,
            open_until = excluded.open_until, updated_at = excluded.updated_at
        `).run(row.project_path, reason, now, now + cooldownMs, now);
      };

      const hourAgo = now - 60 * 60_000;
      if (options.maxAttemptsPerHour != null) {
        const attempts = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ?
            AND COALESCE(a.result_status, '') != 'operator_remediated'
        `).get(row.project_path, hourAgo) as { count: number }).count;
        if (attempts >= Math.max(1, options.maxAttemptsPerHour)) {
          openCircuit(`attempt budget exhausted: ${attempts}/${options.maxAttemptsPerHour} in 1h`);
          return null;
        }
      }

      if (options.maxFailuresPerHour != null) {
        const failures = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ? AND a.success = 0
            AND COALESCE(a.result_status, '') NOT IN (${placeholders(NON_FAILURE_RESULT_STATUSES)})
        `).get(row.project_path, hourAgo, ...NON_FAILURE_RESULT_STATUSES) as { count: number }).count;
        if (failures >= Math.max(1, options.maxFailuresPerHour)) {
          openCircuit(`failure circuit open: ${failures}/${options.maxFailuresPerHour} in 1h`);
          return null;
        }
      }

      if (options.maxCostUsdPerDay != null) {
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);
        const cost = (this.db.prepare(`
          SELECT COALESCE(SUM(a.cost_usd), 0) AS cost
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ?
        `).get(row.project_path, dayStart.getTime()) as { cost: number }).cost;
        if (cost >= options.maxCostUsdPerDay) {
          openCircuit(`daily cost budget exhausted: $${cost.toFixed(4)}/$${options.maxCostUsdPerDay.toFixed(4)}`);
          return null;
        }
      }

      const activeRows = this.db.prepare(`
        SELECT issue_id, state, metadata_json FROM automation_runs
        WHERE project_path = ?
          AND (
            state IN (${placeholders(ACTIVE_LEASE_STATES)})
            OR state = 'NEEDS_RECONCILE'
          )
          AND issue_id <> ?
      `).all(row.project_path, ...ACTIVE_LEASE_STATES, issueId) as Array<Pick<RunRow, 'issue_id' | 'state' | 'metadata_json'>>;
      if (activeRows.length >= maxActive) return null;

      // The cap controls capacity; the write scope controls safety inside that
      // capacity. Both checks happen in the same SQLite transaction as the
      // claim, so two daemon instances cannot race disjoint scheduler views.
      // An omitted conflictScope explicitly means the caller relies on isolated
      // worktrees and wants capacity-only admission. An explicitly supplied but
      // empty/unknown scope still fails closed inside admitsConflictScope().
      if (maxActive > 1 && options.conflictScope !== undefined) {
        const activeScopes = activeRows
          .filter(active => ACTIVE_LEASE_STATES.includes(active.state as RunState))
          .map(active => parseJson(active.metadata_json));
        if (!admitsConflictScope(options.conflictScope, activeScopes)) return null;
      }

      const epoch = row.lease_epoch + 1;
      const attemptNo = row.attempt_no + 1;
      const leaseExpiresAt = now + options.leaseMs;
      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'CLAIMED', state_version = state_version + 1,
            attempt_no = ?, owner_instance_id = ?, lease_token = ?,
            lease_epoch = ?, lease_expires_at = ?, retry_at = NULL,
            started_at = COALESCE(started_at, ?), updated_at = ?, completed_at = NULL
        WHERE issue_id = ? AND state = ? AND state_version = ?
      `).run(
        attemptNo,
        options.ownerInstanceId,
        token,
        epoch,
        leaseExpiresAt,
        now,
        now,
        issueId,
        row.state,
        row.state_version,
      );
      if (updated.changes !== 1) return null;

      this.db.prepare(`
        INSERT INTO automation_attempts(
          issue_id, attempt_no, lease_epoch, status, stage, started_at
        ) VALUES (?, ?, ?, 'running', 'CLAIMED', ?)
      `).run(issueId, attemptNo, epoch, now);
      this.insertEvent(issueId, attemptNo, 'claimed', row.state, 'CLAIMED', {
        ownerInstanceId: options.ownerInstanceId,
        leaseEpoch: epoch,
      }, now);

      return {
        issueId,
        ownerInstanceId: options.ownerInstanceId,
        leaseToken: token,
        leaseEpoch: epoch,
        attemptNo,
        leaseExpiresAt,
      };
    });

    return claim.immediate();
  }

  renewLease(claim: RunClaim, leaseMs: number, now = Date.now()): RunClaim | null {
    assertPositiveDuration(leaseMs, 'leaseMs');
    const leaseExpiresAt = now + leaseMs;
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET lease_expires_at = ?, updated_at = ?
      WHERE issue_id = ? AND owner_instance_id = ? AND lease_token = ?
        AND lease_epoch = ? AND lease_expires_at > ?
        AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
    `).run(
      leaseExpiresAt,
      now,
      claim.issueId,
      claim.ownerInstanceId,
      claim.leaseToken,
      claim.leaseEpoch,
      now,
      ...ACTIVE_LEASE_STATES,
    );
    return result.changes === 1 ? { ...claim, leaseExpiresAt } : null;
  }

  isClaimCurrent(claim: RunClaim, now = Date.now()): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS current FROM automation_runs
      WHERE issue_id = ? AND owner_instance_id = ? AND lease_token = ?
        AND lease_epoch = ? AND lease_expires_at > ?
        AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
    `).get(
      claim.issueId,
      claim.ownerInstanceId,
      claim.leaseToken,
      claim.leaseEpoch,
      now,
      ...ACTIVE_LEASE_STATES,
    ) as { current: number } | undefined;
    return row?.current === 1;
  }

  recordAttemptResult(claim: RunClaim, input: AttemptResultInput, now = Date.now()): boolean {
    const record = this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE automation_attempts
        SET result_status = ?, success = ?, cost_usd = ?, result_json = ?
        WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ?
          AND result_status IS NULL
          AND EXISTS (
            SELECT 1 FROM automation_runs r
            WHERE r.issue_id = automation_attempts.issue_id
              AND r.owner_instance_id = ? AND r.lease_token = ?
              AND r.lease_epoch = ? AND r.lease_expires_at > ?
          )
      `).run(
        input.finalStatus,
        input.success ? 1 : 0,
        input.costUsd ?? null,
        stringifyJson(input.result),
        claim.issueId,
        claim.attemptNo,
        claim.leaseEpoch,
        claim.ownerInstanceId,
        claim.leaseToken,
        claim.leaseEpoch,
        now,
      );
      if (updated.changes !== 1) return false;

      const countsAsFailure = !input.success
        && !NON_FAILURE_RESULT_STATUSES.includes(input.finalStatus);
      if (countsAsFailure && input.maxFailuresPerHour != null) {
        const run = this.db.prepare('SELECT project_path FROM automation_runs WHERE issue_id = ?')
          .get(claim.issueId) as { project_path: string };
        const failures = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ? AND a.success = 0
            AND COALESCE(a.result_status, '') NOT IN (${placeholders(NON_FAILURE_RESULT_STATUSES)})
        `).get(run.project_path, now - 60 * 60_000, ...NON_FAILURE_RESULT_STATUSES) as { count: number }).count;
        if (failures >= Math.max(1, input.maxFailuresPerHour)) {
          const cooldownMs = Math.max(60_000, input.circuitCooldownMs ?? 60 * 60_000);
          const reason = `failure circuit open: ${failures}/${input.maxFailuresPerHour} in 1h`;
          this.db.prepare(`
            INSERT INTO automation_repo_circuits(project_path, reason, opened_at, open_until, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET
              reason = excluded.reason, opened_at = excluded.opened_at,
              open_until = excluded.open_until, updated_at = excluded.updated_at
          `).run(run.project_path, reason, now, now + cooldownMs, now);
        }
      }
      return true;
    });
    return record.immediate();
  }

  /**
   * Operator acknowledgement that a recorded failure's external/root cause was
   * fixed. Preserve the attempt and its error evidence, but exclude it from the
   * rolling failure circuit so the repaired repository can be retried now.
   */
  markAttemptRemediated(issueId: string, attemptNo: number, reason: string, now = Date.now()): boolean {
    if (!reason.trim()) throw new Error('remediation reason is required');
    const remediate = this.db.transaction(() => {
      const run = this.db.prepare('SELECT project_path FROM automation_runs WHERE issue_id = ?')
        .get(issueId) as { project_path: string } | undefined;
      if (!run) return false;
      const updated = this.db.prepare(`
        UPDATE automation_attempts
        SET result_status = 'operator_remediated'
        WHERE issue_id = ? AND attempt_no = ? AND COALESCE(success, 0) = 0
          AND COALESCE(result_status, '') NOT IN ('cancelled', 'superseded', 'rate_limited', 'operator_remediated')
      `).run(issueId, attemptNo);
      if (updated.changes !== 1) return false;
      this.db.prepare('DELETE FROM automation_repo_circuits WHERE project_path = ?').run(run.project_path);
      this.insertEvent(issueId, attemptNo, 'operator_remediated', null, null, { reason }, now);
      return true;
    });
    return remediate.immediate();
  }

  transition(claim: RunClaim, to: RunState, patch: TransitionPatch = {}, now = Date.now()): boolean {
    const transition = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(claim.issueId) as RunRow | undefined;
      if (!row) return false;
      assertRunState(row.state);
      if (!ALLOWED_TRANSITIONS[row.state].includes(to)) return false;
      if (
        row.owner_instance_id !== claim.ownerInstanceId
        || row.lease_token !== claim.leaseToken
        || row.lease_epoch !== claim.leaseEpoch
        || row.lease_expires_at == null
        || row.lease_expires_at <= now
      ) return false;

      const terminal = to === 'DONE' || to === 'DECOMPOSED' || to === 'CANCELLED';
      const releasesLease = terminal || to === 'SYNC_PENDING' || to === 'RETRY_AT' || to === 'WAITING_EXTERNAL'
        || to === 'NEEDS_SPEC' || to === 'NEEDS_ENV' || to === 'NEEDS_HUMAN'
        || to === 'NEEDS_RECONCILE';
      const result = this.db.prepare(`
        UPDATE automation_runs
        SET state = ?, state_version = state_version + 1,
            retry_at = ?, branch_name = COALESCE(?, branch_name),
            worktree_path = COALESCE(?, worktree_path), pr_url = COALESCE(?, pr_url),
            head_sha = COALESCE(?, head_sha), last_error_code = ?,
            last_error_message = ?, metadata_json = COALESCE(?, metadata_json),
            owner_instance_id = ?, lease_token = ?, lease_expires_at = ?,
            completed_at = ?, updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND owner_instance_id = ?
          AND lease_token = ? AND lease_epoch = ? AND lease_expires_at > ?
      `).run(
        to,
        patch.retryAt ?? null,
        patch.branchName ?? null,
        patch.worktreePath ?? null,
        patch.prUrl ?? null,
        patch.headSha ?? null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        stringifyJson(patch.metadata),
        releasesLease ? null : claim.ownerInstanceId,
        releasesLease ? null : claim.leaseToken,
        releasesLease ? null : row.lease_expires_at,
        terminal ? now : null,
        now,
        claim.issueId,
        row.state_version,
        claim.ownerInstanceId,
        claim.leaseToken,
        claim.leaseEpoch,
        now,
      );
      if (result.changes !== 1) return false;

      this.db.prepare(`
        UPDATE automation_attempts
        SET stage = ?, status = ?, finished_at = ?, error_code = ?, error_message = ?
        WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ?
      `).run(
        to,
        releasesLease ? (terminal ? 'completed' : 'suspended') : 'running',
        releasesLease ? now : null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        claim.issueId,
        claim.attemptNo,
        claim.leaseEpoch,
      );
      this.insertEvent(claim.issueId, claim.attemptNo, 'transition', row.state, to, patch.eventData, now);
      return true;
    });
    return transition.immediate();
  }

  attachWorktree(claim: RunClaim, worktreePath: string, branchName: string, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET worktree_path = ?, branch_name = ?, updated_at = ?
      WHERE issue_id = ? AND owner_instance_id = ? AND lease_token = ?
        AND lease_epoch = ? AND lease_expires_at > ?
    `).run(
      worktreePath,
      branchName,
      now,
      claim.issueId,
      claim.ownerInstanceId,
      claim.leaseToken,
      claim.leaseEpoch,
      now,
    );
    return result.changes === 1;
  }

  attachPublication(claim: RunClaim, patch: Pick<TransitionPatch, 'prUrl' | 'headSha'>, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET pr_url = COALESCE(?, pr_url), head_sha = COALESCE(?, head_sha), updated_at = ?
      WHERE issue_id = ? AND owner_instance_id = ? AND lease_token = ?
        AND lease_epoch = ? AND lease_expires_at > ?
    `).run(
      patch.prUrl ?? null,
      patch.headSha ?? null,
      now,
      claim.issueId,
      claim.ownerInstanceId,
      claim.leaseToken,
      claim.leaseEpoch,
      now,
    );
    return result.changes === 1;
  }

  reconcileExpiredLeases(now = Date.now()): RunRecord[] {
    const reconcile = this.db.transaction(() => {
      const expired = this.db.prepare(`
        SELECT * FROM automation_runs
        WHERE state IN (${placeholders(ACTIVE_LEASE_STATES)})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY updated_at
      `).all(...ACTIVE_LEASE_STATES, now) as RunRow[];
      const reconciledIssueIds = this.reconcileExpiredRows(expired, now);
      return reconciledIssueIds.map((issueId) => this.getRun(issueId)!).filter(Boolean);
    });
    return reconcile.immediate();
  }

  /**
   * Fence an active lease immediately when the local owner process is proven
   * dead. The owner/token/epoch CAS prevents a stale observer from fencing a
   * replacement executor that has already reclaimed the run.
   */
  reconcileDeadOwner(
    ownership: Pick<RunClaim, 'issueId' | 'ownerInstanceId' | 'leaseToken' | 'leaseEpoch' | 'attemptNo'>,
    now = Date.now(),
  ): boolean {
    const reconcile = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?')
        .get(ownership.issueId) as RunRow | undefined;
      if (
        !row
        || !ACTIVE_LEASE_STATES.includes(row.state as RunState)
        || row.owner_instance_id !== ownership.ownerInstanceId
        || row.lease_token !== ownership.leaseToken
        || row.lease_epoch !== ownership.leaseEpoch
        || row.attempt_no !== ownership.attemptNo
      ) return false;
      assertRunState(row.state);

      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'NEEDS_RECONCILE', state_version = state_version + 1,
            lease_expires_at = NULL,
            last_error_code = 'owner_process_exited',
            last_error_message = 'Executor owner process exited before a terminal transition',
            updated_at = ?
        WHERE issue_id = ? AND state_version = ?
          AND owner_instance_id = ? AND lease_token = ? AND lease_epoch = ?
          AND attempt_no = ? AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
      `).run(
        now,
        ownership.issueId,
        row.state_version,
        ownership.ownerInstanceId,
        ownership.leaseToken,
        ownership.leaseEpoch,
        ownership.attemptNo,
        ...ACTIVE_LEASE_STATES,
      );
      if (updated.changes !== 1) return false;
      this.db.prepare(`
        UPDATE automation_attempts
        SET status = 'orphaned', finished_at = ?, error_code = 'owner_process_exited',
            error_message = 'Executor owner process exited before a terminal transition'
        WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ? AND status = 'running'
      `).run(now, ownership.issueId, ownership.attemptNo, ownership.leaseEpoch);
      this.insertEvent(ownership.issueId, ownership.attemptNo, 'owner_process_exited',
        row.state, 'NEEDS_RECONCILE', { ownerInstanceId: ownership.ownerInstanceId }, now);
      return true;
    });
    return reconcile.immediate();
  }

  getProtectedWorktreePaths(projectPath?: string): Set<string> {
    const terminal: readonly RunState[] = ['DONE', 'DECOMPOSED', 'CANCELLED'];
    const sql = `
      SELECT worktree_path FROM automation_runs
      WHERE worktree_path IS NOT NULL AND state NOT IN (${placeholders(terminal)})
      ${projectPath ? 'AND project_path = ?' : ''}
    `;
    const rows = (projectPath
      ? this.db.prepare(sql).all(...terminal, projectPath)
      : this.db.prepare(sql).all(...terminal)) as { worktree_path: string }[];
    return new Set(rows.map((row) => row.worktree_path));
  }

  enqueueEffect(claim: RunClaim, effect: EffectInput, now = Date.now()): EffectRecord | null {
    const enqueue = this.db.transaction(() => {
      const run = this.db.prepare(`
        SELECT state FROM automation_runs
        WHERE issue_id = ? AND owner_instance_id = ? AND lease_token = ?
          AND lease_epoch = ? AND lease_expires_at > ?
      `).get(
        claim.issueId,
        claim.ownerInstanceId,
        claim.leaseToken,
        claim.leaseEpoch,
        now,
      ) as { state: string } | undefined;
      if (!run) return null;

      this.db.prepare(`
        INSERT OR IGNORE INTO automation_effects(
          issue_id, attempt_no, kind, dedupe_key, payload_json,
          status, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        claim.issueId,
        claim.attemptNo,
        effect.kind,
        effect.dedupeKey,
        JSON.stringify(effect.payload),
        effect.availableAt ?? now,
        now,
        now,
      );
      const row = this.db.prepare('SELECT * FROM automation_effects WHERE dedupe_key = ?').get(effect.dedupeKey) as EffectRow;
      const payloadJson = JSON.stringify(effect.payload);
      if (
        row.issue_id !== claim.issueId
        || row.attempt_no !== claim.attemptNo
        || row.kind !== effect.kind
        || row.payload_json !== payloadJson
      ) {
        throw new Error(`Outbox dedupe key collision: ${effect.dedupeKey}`);
      }
      return this.toEffect(row);
    });
    return enqueue.immediate();
  }

  /**
   * Atomically publishes a locally terminal result to the durable sync stage.
   * The outbox row and SYNC_PENDING transition become visible together, so a
   * second daemon can never deliver tracker effects for a still-executing run.
   * The effect kind determines the terminal state after acknowledgement
   * (`tracker.cancel` -> CANCELLED, all other current effects -> DONE).
   */
  commitRunForSync(
    claim: RunClaim,
    effect: EffectInput | undefined,
    patch: Pick<TransitionPatch, 'prUrl' | 'headSha' | 'metadata' | 'eventData'> = {},
    now = Date.now(),
  ): boolean {
    const commit = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(claim.issueId) as RunRow | undefined;
      if (!row) return false;
      assertRunState(row.state);
      if (!ALLOWED_TRANSITIONS[row.state].includes('SYNC_PENDING')) return false;
      if (
        row.owner_instance_id !== claim.ownerInstanceId
        || row.lease_token !== claim.leaseToken
        || row.lease_epoch !== claim.leaseEpoch
        || row.lease_expires_at == null
        || row.lease_expires_at <= now
      ) return false;

      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'SYNC_PENDING', state_version = state_version + 1,
            retry_at = NULL, pr_url = COALESCE(?, pr_url),
            head_sha = COALESCE(?, head_sha),
            last_error_code = NULL, last_error_message = NULL,
            metadata_json = COALESCE(?, metadata_json),
            owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND owner_instance_id = ?
          AND lease_token = ? AND lease_epoch = ? AND lease_expires_at > ?
      `).run(
        patch.prUrl ?? null,
        patch.headSha ?? null,
        stringifyJson(patch.metadata),
        now,
        claim.issueId,
        row.state_version,
        claim.ownerInstanceId,
        claim.leaseToken,
        claim.leaseEpoch,
        now,
      );
      if (updated.changes !== 1) return false;

      if (effect) {
        this.db.prepare(`
          INSERT OR IGNORE INTO automation_effects(
            issue_id, attempt_no, kind, dedupe_key, payload_json,
            status, available_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).run(
          claim.issueId,
          claim.attemptNo,
          effect.kind,
          effect.dedupeKey,
          JSON.stringify(effect.payload),
          effect.availableAt ?? now,
          now,
          now,
        );
        const stored = this.db.prepare(`
          SELECT issue_id, attempt_no, kind, payload_json
          FROM automation_effects WHERE dedupe_key = ?
        `).get(effect.dedupeKey) as {
          issue_id: string;
          attempt_no: number;
          kind: string;
          payload_json: string;
        };
        if (
          stored.issue_id !== claim.issueId
          || stored.attempt_no !== claim.attemptNo
          || stored.kind !== effect.kind
          || stored.payload_json !== JSON.stringify(effect.payload)
        ) {
          throw new Error(`Outbox dedupe key collision: ${effect.dedupeKey}`);
        }
      }

      this.db.prepare(`
        UPDATE automation_attempts
        SET stage = 'SYNC_PENDING', status = 'suspended', finished_at = ?
        WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ?
      `).run(now, claim.issueId, claim.attemptNo, claim.leaseEpoch);
      this.insertEvent(claim.issueId, claim.attemptNo, 'transition', row.state, 'SYNC_PENDING', patch.eventData, now);
      return true;
    });
    return commit.immediate();
  }

  /**
   * Reconciler path for a process that died after publishing but before it could
   * enqueue/ack tracker sync. No execution lease is resurrected; the discovered
   * PR becomes artifact truth and the durable outbox resumes convergence.
   */
  recoverPublishedRun(
    issueId: string,
    publication: { prUrl: string; headSha?: string },
    effect: EffectInput,
    now = Date.now(),
  ): boolean {
    const recoverable: readonly RunState[] = ['NEEDS_RECONCILE', 'WAITING_EXTERNAL'];
    const recover = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || !recoverable.includes(row.state as RunState)) return false;
      if (row.owner_instance_id != null || row.lease_token != null) return false;

      this.db.prepare(`
        INSERT OR IGNORE INTO automation_effects(
          issue_id, attempt_no, kind, dedupe_key, payload_json,
          status, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        issueId,
        row.attempt_no,
        effect.kind,
        effect.dedupeKey,
        JSON.stringify(effect.payload),
        effect.availableAt ?? now,
        now,
        now,
      );
      const stored = this.db.prepare('SELECT issue_id, attempt_no, kind, payload_json FROM automation_effects WHERE dedupe_key = ?')
        .get(effect.dedupeKey) as { issue_id: string; attempt_no: number; kind: string; payload_json: string };
      if (
        stored.issue_id !== issueId
        || stored.attempt_no !== row.attempt_no
        || stored.kind !== effect.kind
        || stored.payload_json !== JSON.stringify(effect.payload)
      ) {
        throw new Error(`Outbox dedupe key collision: ${effect.dedupeKey}`);
      }

      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'SYNC_PENDING', state_version = state_version + 1,
            pr_url = ?, head_sha = COALESCE(?, head_sha),
            owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND state = ?
      `).run(publication.prUrl, publication.headSha ?? null, now, issueId, row.state_version, row.state);
      if (updated.changes !== 1) return false;
      this.insertEvent(issueId, row.attempt_no, 'publication_recovered', row.state as RunState, 'SYNC_PENDING', publication, now);
      return true;
    });
    return recover.immediate();
  }

  markNeedsHuman(issueId: string, reason: string, now = Date.now()): boolean {
    const eligible: readonly RunState[] = [
      'DISCOVERED', 'READY', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_SPEC',
      'NEEDS_ENV', 'NEEDS_RECONCILE', 'SYNC_PENDING',
    ];
    const transition = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || !eligible.includes(row.state as RunState)) return false;
      if (row.owner_instance_id != null || row.lease_token != null) return false;
      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'NEEDS_HUMAN', state_version = state_version + 1,
            owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'needs_human', last_error_message = ?, updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND state = ?
      `).run(reason, now, issueId, row.state_version, row.state);
      if (updated.changes !== 1) return false;
      this.insertEvent(issueId, row.attempt_no, 'parked', row.state as RunState, 'NEEDS_HUMAN', { reason }, now);
      return true;
    });
    return transition.immediate();
  }

  getEffectByDedupeKey(dedupeKey: string): EffectRecord | null {
    const row = this.db.prepare('SELECT * FROM automation_effects WHERE dedupe_key = ?').get(dedupeKey) as EffectRow | undefined;
    return row ? this.toEffect(row) : null;
  }

  claimNextEffect(ownerInstanceId: string, leaseMs: number, now = Date.now()): EffectClaim | null {
    assertPositiveDuration(leaseMs, 'leaseMs');
    const claim = this.db.transaction((): EffectClaim | null => {
      const row = this.db.prepare(`
        SELECT e.* FROM automation_effects e
        JOIN automation_runs r ON r.issue_id = e.issue_id
        WHERE r.state = 'SYNC_PENDING' AND (
          (e.status = 'pending' AND e.available_at <= ?)
          OR (e.status = 'in_flight' AND e.lease_expires_at IS NOT NULL AND e.lease_expires_at <= ?)
        )
        ORDER BY e.available_at, e.id
        LIMIT 1
      `).get(now, now) as EffectRow | undefined;
      if (!row) return null;

      const token = randomUUID();
      const epoch = row.lease_epoch + 1;
      const leaseExpiresAt = now + leaseMs;
      const updated = this.db.prepare(`
        UPDATE automation_effects
        SET status = 'in_flight', owner_instance_id = ?, delivery_token = ?,
            lease_epoch = ?, lease_expires_at = ?, attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND lease_epoch = ? AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'in_flight' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      `).run(ownerInstanceId, token, epoch, leaseExpiresAt, now, row.id, row.lease_epoch, now, now);
      if (updated.changes !== 1) return null;
      const claimed = this.db.prepare('SELECT * FROM automation_effects WHERE id = ?').get(row.id) as EffectRow;
      return this.toEffect(claimed) as EffectClaim;
    });
    return claim.immediate();
  }

  renewEffectLease(effect: EffectClaim, leaseMs: number, now = Date.now()): EffectClaim | null {
    assertPositiveDuration(leaseMs, 'leaseMs');
    const leaseExpiresAt = now + leaseMs;
    const result = this.db.prepare(`
      UPDATE automation_effects
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'in_flight' AND owner_instance_id = ?
        AND delivery_token = ? AND lease_epoch = ? AND lease_expires_at > ?
    `).run(
      leaseExpiresAt,
      now,
      effect.id,
      effect.ownerInstanceId,
      effect.deliveryToken,
      effect.leaseEpoch,
      now,
    );
    return result.changes === 1 ? { ...effect, leaseExpiresAt, updatedAt: now } : null;
  }

  ackEffect(effect: Pick<EffectClaim, 'id' | 'ownerInstanceId' | 'deliveryToken' | 'leaseEpoch'>, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE automation_effects
      SET status = 'applied', applied_at = ?, updated_at = ?,
          owner_instance_id = NULL, delivery_token = NULL, lease_expires_at = NULL,
          last_error = NULL
      WHERE id = ? AND status = 'in_flight' AND owner_instance_id = ?
        AND delivery_token = ? AND lease_epoch = ? AND lease_expires_at > ?
    `).run(now, now, effect.id, effect.ownerInstanceId, effect.deliveryToken, effect.leaseEpoch, now);
    return result.changes === 1;
  }

  /**
   * Acknowledge one delivered effect and, when it was the last outstanding
   * effect for the run, commit SYNC_PENDING -> DONE in the same transaction.
   * Splitting these writes leaves a crash window where no effect is claimable
   * but the run remains SYNC_PENDING forever.
   */
  ackEffectAndFinalizeRun(
    effect: Pick<EffectClaim, 'id' | 'ownerInstanceId' | 'deliveryToken' | 'leaseEpoch'>,
    now = Date.now(),
  ): { acknowledged: boolean; finalized: boolean; issueId?: string } {
    const acknowledge = this.db.transaction(() => {
      const stored = this.db.prepare('SELECT issue_id FROM automation_effects WHERE id = ?')
        .get(effect.id) as { issue_id: string } | undefined;
      if (!stored) return { acknowledged: false, finalized: false };

      const acked = this.db.prepare(`
        UPDATE automation_effects
        SET status = 'applied', applied_at = ?, updated_at = ?,
            owner_instance_id = NULL, delivery_token = NULL, lease_expires_at = NULL,
            last_error = NULL
        WHERE id = ? AND status = 'in_flight' AND owner_instance_id = ?
          AND delivery_token = ? AND lease_epoch = ? AND lease_expires_at > ?
      `).run(
        now,
        now,
        effect.id,
        effect.ownerInstanceId,
        effect.deliveryToken,
        effect.leaseEpoch,
        now,
      );
      if (acked.changes !== 1) return { acknowledged: false, finalized: false, issueId: stored.issue_id };

      const finalized = this.finalizeSyncedRunInTransaction(stored.issue_id, now);
      return { acknowledged: true, finalized, issueId: stored.issue_id };
    });
    return acknowledge.immediate();
  }

  retryEffect(
    effect: Pick<EffectClaim, 'id' | 'ownerInstanceId' | 'deliveryToken' | 'leaseEpoch'>,
    error: string,
    availableAt: number,
    options: { dead?: boolean } = {},
    now = Date.now(),
  ): boolean {
    const result = this.db.prepare(`
      UPDATE automation_effects
      SET status = ?, available_at = ?, last_error = ?, updated_at = ?,
          owner_instance_id = NULL, delivery_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'in_flight' AND owner_instance_id = ?
        AND delivery_token = ? AND lease_epoch = ? AND lease_expires_at > ?
    `).run(
      options.dead ? 'dead' : 'pending',
      availableAt,
      error,
      now,
      effect.id,
      effect.ownerInstanceId,
      effect.deliveryToken,
      effect.leaseEpoch,
      now,
    );
    return result.changes === 1;
  }

  finalizeSyncedRun(issueId: string, now = Date.now()): boolean {
    const finalize = this.db.transaction(() => this.finalizeSyncedRunInTransaction(issueId, now));
    return finalize.immediate();
  }

  /** Repair the legacy ACK->DONE crash gap before attempting new deliveries. */
  finalizeReadySyncedRuns(now = Date.now()): string[] {
    const finalize = this.db.transaction(() => {
      const issueIds = (this.db.prepare(`
        SELECT r.issue_id
        FROM automation_runs r
        WHERE r.state = 'SYNC_PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM automation_effects e
            WHERE e.issue_id = r.issue_id AND e.status <> 'applied'
          )
        ORDER BY r.updated_at
      `).all() as Array<{ issue_id: string }>).map((row) => row.issue_id);
      return issueIds.filter((issueId) => this.finalizeSyncedRunInTransaction(issueId, now));
    });
    return finalize.immediate();
  }

  /** Attempts in a row (most recent first) sharing this error code, stopped at
   * the first that doesn't or at `sinceMs` — the last operator-answer time (AGT-4042). */
  consecutiveAttemptsWithErrorCode(issueId: string, errorCode: string, sinceMs?: number): number {
    const rows = this.db.prepare(
      'SELECT error_code, started_at FROM automation_attempts WHERE issue_id = ? ORDER BY attempt_no DESC',
    ).all(issueId) as { error_code: string | null; started_at: number }[];
    const stopped = rows.findIndex((row) =>
      row.error_code !== errorCode || (sinceMs !== undefined && row.started_at <= sinceMs));
    return stopped === -1 ? rows.length : stopped;
  }

  getMetrics(now = Date.now()): LedgerMetrics {
    const byState: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS count FROM automation_runs GROUP BY state').all() as { state: string; count: number }[]) {
      byState[row.state] = row.count;
    }
    const effectsByStatus: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS count FROM automation_effects GROUP BY status').all() as { status: string; count: number }[]) {
      effectsByStatus[row.status] = row.count;
    }
    const expiredActiveLeases = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM automation_runs
      WHERE state IN (${placeholders(ACTIVE_LEASE_STATES)})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).get(...ACTIVE_LEASE_STATES, now) as { count: number }).count;
    const oldest = this.db.prepare(`
      SELECT MIN(created_at) AS created_at FROM automation_effects
      WHERE status IN ('pending', 'in_flight')
    `).get() as { created_at: number | null };
    const openCircuits = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM automation_repo_circuits WHERE open_until > ?
    `).get(now) as { count: number }).count;
    return {
      byState,
      effectsByStatus,
      expiredActiveLeases,
      oldestPendingEffectAgeMs: oldest.created_at == null ? 0 : Math.max(0, now - oldest.created_at),
      openCircuits,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Caller must already hold a SQLite writer transaction. */
  private reconcileExpiredRows(rows: readonly RunRow[], now: number): string[] {
    const reconciledIssueIds: string[] = [];
    for (const row of rows) {
      assertRunState(row.state);
      const updated = this.db.prepare(`
        UPDATE automation_runs
        SET state = 'NEEDS_RECONCILE', state_version = state_version + 1,
            lease_expires_at = NULL,
            last_error_code = 'lease_expired',
            last_error_message = 'Execution lease expired before a terminal transition',
            updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND lease_epoch = ?
          AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).run(
        now,
        row.issue_id,
        row.state_version,
        row.lease_epoch,
        ...ACTIVE_LEASE_STATES,
        now,
      );
      if (updated.changes !== 1) continue;
      reconciledIssueIds.push(row.issue_id);
      this.db.prepare(`
        UPDATE automation_attempts
        SET status = 'orphaned', finished_at = ?, error_code = 'lease_expired',
            error_message = 'Execution lease expired before a terminal transition'
        WHERE issue_id = ? AND attempt_no = ? AND lease_epoch = ? AND status = 'running'
      `).run(now, row.issue_id, row.attempt_no, row.lease_epoch);
      this.insertEvent(row.issue_id, row.attempt_no, 'lease_expired', row.state, 'NEEDS_RECONCILE', {
        leaseEpoch: row.lease_epoch,
      }, now);
    }
    return reconciledIssueIds;
  }

  private unfencedTransition(
    issueId: string,
    from: readonly RunState[],
    to: RunState,
    patch: TransitionPatch,
    now: number,
    requireErrorCode?: string,
  ): boolean {
    const transition = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || !from.includes(row.state as RunState)) return false;
      // Read under the transaction's write lock, so what is checked here is what
      // the UPDATE below acts on.
      if (requireErrorCode !== undefined && row.last_error_code !== requireErrorCode) return false;
      assertRunState(row.state);
      if (row.owner_instance_id != null || row.lease_token != null) return false;
      if (!ALLOWED_TRANSITIONS[row.state].includes(to)) return false;
      const result = this.db.prepare(`
        UPDATE automation_runs
        SET state = ?, state_version = state_version + 1, retry_at = ?, updated_at = ?
        WHERE issue_id = ? AND state_version = ? AND state = ?
          AND owner_instance_id IS NULL AND lease_token IS NULL
      `).run(to, patch.retryAt ?? null, now, issueId, row.state_version, row.state);
      if (result.changes !== 1) return false;
      this.insertEvent(issueId, row.attempt_no, 'transition', row.state, to, patch.eventData, now);
      return true;
    });
    return transition.immediate();
  }

  /** Caller must already hold a SQLite writer transaction. */
  private finalizeSyncedRunInTransaction(issueId: string, now: number): boolean {
    const run = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
    if (!run || run.state !== 'SYNC_PENDING') return false;
    const outstanding = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM automation_effects
      WHERE issue_id = ? AND status <> 'applied'
    `).get(issueId) as { count: number }).count;
    if (outstanding > 0) return false;

    // Scope the terminal decision to the current attempt. A reopened issue can
    // retain applied effects from older attempts, and those must not influence
    // the new result. Cancellation is deliberately finalized only after its
    // tracker effect is acknowledged, closing the CANCELLED+Todo reopen race.
    const currentKinds = this.db.prepare(`
      SELECT kind FROM automation_effects
      WHERE issue_id = ? AND attempt_no = ?
      ORDER BY id
    `).all(issueId, run.attempt_no) as Array<{ kind: string }>;
    const terminalState: Extract<RunState, 'DONE' | 'CANCELLED'> =
      currentKinds.some((effect) => effect.kind === 'tracker.cancel') ? 'CANCELLED' : 'DONE';
    if (!ALLOWED_TRANSITIONS.SYNC_PENDING.includes(terminalState)) return false;
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET state = ?, state_version = state_version + 1,
          owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE issue_id = ? AND state_version = ? AND state = 'SYNC_PENDING'
    `).run(terminalState, now, now, issueId, run.state_version);
    if (result.changes !== 1) return false;
    this.db.prepare(`
      UPDATE automation_attempts
      SET status = ?, stage = ?, finished_at = ?
      WHERE issue_id = ? AND attempt_no = ?
    `).run(
      terminalState === 'CANCELLED' ? 'cancelled' : 'completed',
      terminalState,
      now,
      issueId,
      run.attempt_no,
    );
    this.insertEvent(issueId, run.attempt_no, 'effects_applied', 'SYNC_PENDING', terminalState, undefined, now);
    return true;
  }

  private insertEvent(
    issueId: string,
    attemptNo: number,
    kind: string,
    from: RunState | null,
    to: RunState | null,
    data: unknown,
    now: number,
  ): void {
    this.db.prepare(`
      INSERT INTO automation_events(
        issue_id, attempt_no, kind, from_state, to_state, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(issueId, attemptNo, kind, from, to, stringifyJson(data), now);
  }

  private toRun(row: RunRow): RunRecord {
    assertRunState(row.state);
    return {
      issueId: row.issue_id,
      source: row.source,
      identifier: row.identifier ?? undefined,
      title: row.title ?? undefined,
      projectPath: row.project_path,
      state: row.state,
      stateVersion: row.state_version,
      attemptNo: row.attempt_no,
      ownerInstanceId: row.owner_instance_id ?? undefined,
      leaseToken: row.lease_token ?? undefined,
      leaseEpoch: row.lease_epoch,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      retryAt: row.retry_at ?? undefined,
      branchName: row.branch_name ?? undefined,
      worktreePath: row.worktree_path ?? undefined,
      prUrl: row.pr_url ?? undefined,
      headSha: row.head_sha ?? undefined,
      lastErrorCode: row.last_error_code ?? undefined,
      lastErrorMessage: row.last_error_message ?? undefined,
      discoveredAt: row.discovered_at,
      startedAt: row.started_at ?? undefined,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      metadata: parseJson(row.metadata_json),
    };
  }

  private toEffect(row: EffectRow): EffectRecord {
    return {
      id: row.id,
      issueId: row.issue_id,
      attemptNo: row.attempt_no,
      kind: row.kind,
      dedupeKey: row.dedupe_key,
      payload: parseJson(row.payload_json),
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      ownerInstanceId: row.owner_instance_id ?? undefined,
      deliveryToken: row.delivery_token ?? undefined,
      leaseEpoch: row.lease_epoch,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at ?? undefined,
    };
  }
}
