import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { enableWalWithRetry } from '../support/sqliteWal.js';
import {
  OPERATOR_QUESTION_PARK_REASON,
} from '../coordination/operatorAnswers.js';
import { defaultAutomationDbPath } from './automationDbPath.js';
import {
  ACTIVE_LEASE_STATES, ALLOWED_TRANSITIONS, CLAIMABLE_STATES, RUN_STATES,
  NON_FAILURE_RESULT_STATUSES,
} from './runLedgerTypes.js';
import { admitsConflictScope } from './runLedgerScope.js';
import { migrateAutomationSchema } from './runLedgerSchema.js';
import { queueIntegrationRequeueInDb } from './runLedgerIntegration.js';
import { listClaimOwnersInDb } from './runLedgerOwners.js';
import { consecutiveIdenticalInfraFailuresInDb, consecutiveSupersessionsInDb } from './infraFailureCircuit.js';
import {
  acquireIntegrationReservationInDb,
  integrationReservationBlocksClaim,
  releaseIntegrationReservationInDb,
  renewIntegrationReservationInDb,
} from './runLedgerIntegrationReservation.js';
import {
  cacheTrackerObservation as persistTrackerObservation,
  type TrackerTerminalState,
} from './runLedgerTrackerCache.js';
import { toRunRecord, type RunRow } from './runLedgerRows.js';
import type {
  ClaimOptions,
  EffectInput,
  ImportRunInput,
  IntegrationReservationClaim,
  IntegrationReservationOptions,
  ParkResumeTrigger,
  RegisterRunInput,
  RunClaim,
  RunLedgerOptions,
  RunRecord,
  RunState,
  TrackerStateObservation,
  TransitionPatch,
} from './runLedgerTypes.js';

function parseJson(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

export function assertRunState(value: string): asserts value is RunState {
  if (!(RUN_STATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown automation run state: ${value}`);
  }
}

export class RunLedgerBase {
  protected readonly db: Database.Database;
  protected closed = false;

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
    return row ? toRunRecord(row) : null;
  }

  listRuns(states?: readonly RunState[]): RunRecord[] {
    const rows = states && states.length > 0
      ? this.db.prepare(`SELECT * FROM automation_runs WHERE state IN (${placeholders(states)}) ORDER BY updated_at`).all(...states) as RunRow[]
      : this.db.prepare('SELECT * FROM automation_runs ORDER BY updated_at').all() as RunRow[];
    return rows.map(toRunRecord);
  }

  cacheTrackerObservation(
    expected: Pick<RunRecord, 'issueId' | 'state' | 'stateVersion'>,
    observation: TrackerStateObservation,
    terminalState?: TrackerTerminalState,
    now = Date.now(),
  ): boolean {
    return persistTrackerObservation(this.db, expected, observation, terminalState, now);
  }

  markReady(issueId: string, now = Date.now()): boolean {
    const eligible: readonly RunState[] = [
      'DISCOVERED', 'RETRY_AT', 'WAITING_EXTERNAL', 'NEEDS_SPEC', 'NEEDS_ENV',
      'NEEDS_HUMAN', 'NEEDS_RECONCILE', 'DONE', 'DECOMPOSED', 'CANCELLED',
    ];
    return this.unfencedTransition(issueId, eligible, 'READY', {}, now);
  }

  /** Every executor that ever claimed this run, newest first. */
  listClaimOwners(issueId: string): string[] {
    return listClaimOwnersInDb(this.db, issueId);
  }

  /** Finished attempts, newest first, that ended as infra_error with this fingerprint before anything else. */
  consecutiveIdenticalInfraFailures(issueId: string, fingerprint: string): number {
    return consecutiveIdenticalInfraFailuresInDb(this.db, issueId, fingerprint);
  }

  /** Finished attempts, newest first, that ended superseded before anything else. */
  consecutiveSupersessions(issueId: string): number {
    return consecutiveSupersessionsInDb(this.db, issueId);
  }

  queueIntegrationRequeue(issueId: string, expectedStateVersion: number, effect: EffectInput, now = Date.now()): boolean {
    return queueIntegrationRequeueInDb(this.db, issueId, expectedStateVersion, effect, now);
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
  /** @param trigger What re-admitted the run; see ParkResumeTrigger. */
  resumeNeedsHuman(issueId: string, now = Date.now(), trigger: ParkResumeTrigger = 'unspecified'): RunState | null {
    const resume = this.db.transaction((): RunState | null => {
      const row = this.db.prepare('SELECT * FROM automation_runs WHERE issue_id = ?').get(issueId) as RunRow | undefined;
      if (!row || row.state !== 'NEEDS_HUMAN') return null;
      // An ask_human park carries its own exact-correlation resume contract.
      // Linear state changes and generic operator recovery must not bypass it.
      // idle_fill is the exception: empty slots + in-scope work beat the wait
      // (AGT-4257). The cheap-model pool should keep chewing, not sit parked.
      if (row.last_error_code === OPERATOR_QUESTION_PARK_REASON && trigger !== 'idle_fill') return null;
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
        trigger,
        parkedUnder: row.last_error_code ?? undefined,
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

      // A post-merge rebase is about to force-update this run's PR branch.
      // Read and claim share one IMMEDIATE transaction, so a worker cannot
      // appear between the integration coordinator's final check and push.
      if (integrationReservationBlocksClaim(this.db, {
        projectPath: row.project_path,
        branchName: row.branch_name ?? undefined,
        issueId: row.issue_id,
        issueIdentifier: row.identifier ?? undefined,
      }, now)) return null;

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
        // Same exclusion set as the failure circuit. Counting superseded /
        // cancelled / deferred / waiting_on_operator attempts against the
        // budget opened the circuit on claim churn alone — vela measured
        // 88/100 and 67/100 superseded in an hour and parked every runnable
        // card behind Transient admission conflict (AGT-4260).
        const attempts = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ?
            AND COALESCE(a.result_status, '') NOT IN (${placeholders(NON_FAILURE_RESULT_STATUSES)})
        `).get(row.project_path, hourAgo, ...NON_FAILURE_RESULT_STATUSES) as { count: number }).count;
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
            AND (a.result_status != 'infra_error' OR a.repository_infra = 1)
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
        if (!admitsConflictScope(options.conflictScope, activeScopes, options.unknownScopeAdmission)) return null;
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

  acquireIntegrationReservation(
    projectPath: string,
    branchName: string,
    issueIdentifier: string,
    options: IntegrationReservationOptions,
  ): IntegrationReservationClaim | null {
    if (!projectPath.trim()) throw new Error('projectPath is required');
    if (!branchName.trim()) throw new Error('branchName is required');
    if (!issueIdentifier.trim()) throw new Error('issueIdentifier is required');
    assertPositiveDuration(options.leaseMs, 'leaseMs');
    return acquireIntegrationReservationInDb(
      this.db, projectPath, branchName, issueIdentifier, options,
    );
  }

  renewIntegrationReservation(
    reservation: IntegrationReservationClaim,
    leaseMs: number,
    now = Date.now(),
  ): IntegrationReservationClaim | null {
    assertPositiveDuration(leaseMs, 'leaseMs');
    return renewIntegrationReservationInDb(this.db, reservation, leaseMs, now);
  }

  releaseIntegrationReservation(reservation: IntegrationReservationClaim): boolean {
    return releaseIntegrationReservationInDb(this.db, reservation);
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

  /** Caller must already hold a SQLite writer transaction. */
  protected reconcileExpiredRows(rows: readonly RunRow[], now: number): string[] {
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

  protected insertEvent(
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
}
