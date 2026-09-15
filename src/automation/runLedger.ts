import { randomUUID } from 'node:crypto';
import {
  ACTIVE_LEASE_STATES, ALLOWED_TRANSITIONS, NON_FAILURE_RESULT_STATUSES,
} from './runLedgerTypes.js';
import {
  markNeedsHumanForQuestionsInDb,
  resumeNeedsHumanForQuestionsInDb,
} from './runLedgerOperatorQuestions.js';
import { readLedgerMetrics } from './runLedgerTrackerCache.js';
import { toEffectRecord, type EffectRow, type RunRow } from './runLedgerRows.js';
import type {
  AttemptResultInput,
  EffectClaim,
  EffectInput,
  EffectRecord,
  LedgerMetrics,
  RunClaim,
  RunRecord,
  RunState,
  TransitionPatch,
} from './runLedgerTypes.js';
import {
  RunLedgerBase,
  assertPositiveDuration, assertRunState, placeholders, stringifyJson,
} from './runLedgerBase.js';

export { AUTOMATION_SCHEMA_VERSION, RUN_STATES, NON_FAILURE_RESULT_STATUSES } from './runLedgerTypes.js';

export type {
  AttemptResultInput,
  ClaimOptions,
  EffectClaim,
  EffectInput,
  EffectRecord,
  EffectStatus,
  ImportRunInput,
  IntegrationReservationClaim,
  IntegrationReservationOptions,
  LedgerMetrics,
  ParkResumeTrigger,
  RegisterRunInput,
  RunClaim,
  RunLedgerMode,
  RunLedgerOptions,
  RunRecord,
  RunState,
  TrackerStateObservation,
  TransitionPatch,
} from './runLedgerTypes.js';

export { defaultAutomationDbPath } from './automationDbPath.js';

/**
 * Durable execution truth for the issue-driven loop.
 *
 * Every mutating operation is a single SQLite transaction or compare-and-swap.
 * Execution callbacks must present the current lease token + monotonically
 * increasing epoch, so a timed-out worker cannot commit state after replacement.
 */
export class RunLedger extends RunLedgerBase {
  recordAttemptResult(claim: RunClaim, input: AttemptResultInput, now = Date.now()): boolean {
    const record = this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE automation_attempts
        SET result_status = ?, success = ?, cost_usd = ?, result_json = ?, repository_infra = ?
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
        input.repositoryInfra ? 1 : 0,
        claim.issueId,
        claim.attemptNo,
        claim.leaseEpoch,
        claim.ownerInstanceId,
        claim.leaseToken,
        claim.leaseEpoch,
        now,
      );
      if (updated.changes !== 1) return false;

      const countsAsFailure = !input.success && !NON_FAILURE_RESULT_STATUSES.includes(input.finalStatus)
        && (input.finalStatus !== 'infra_error' || input.repositoryInfra === true);
      if (countsAsFailure && input.maxFailuresPerHour != null) {
        const run = this.db.prepare('SELECT project_path FROM automation_runs WHERE issue_id = ?')
          .get(claim.issueId) as { project_path: string };
        const failures = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM automation_attempts a
          JOIN automation_runs r ON r.issue_id = a.issue_id
          WHERE r.project_path = ? AND a.started_at >= ? AND a.success = 0
            AND COALESCE(a.result_status, '') NOT IN (${placeholders(NON_FAILURE_RESULT_STATUSES)})
            AND (a.result_status != 'infra_error' OR a.repository_infra = 1)
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
          AND COALESCE(result_status, '') NOT IN ('cancelled', 'superseded', 'deferred', 'rate_limited', 'operator_remediated')
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
      this.insertEvent(claim.issueId, claim.attemptNo, patch.eventKind ?? 'transition', row.state, to, patch.eventData, now);
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
      return toEffectRecord(row);
    });
    return enqueue.immediate();
  }

  /**
   * Atomically publishes a locally terminal result to the durable sync stage.
   * The outbox row and SYNC_PENDING transition become visible together, so a
   * second daemon can never deliver tracker effects for a still-executing run.
   * The effect kind determines the terminal state after acknowledgement
   * (`tracker.cancel` -> CANCELLED, `tracker.integration_requeue` -> READY,
   * all other current effects -> DONE).
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

  /**
   * Convert the RETRY_AT written by the completed primary attempt into an
   * immediate NEEDS_HUMAN park tied to exactly the questions that stopped it.
   */
  markNeedsHumanForQuestions(
    issueId: string,
    correlationIds: readonly string[],
    reason: string,
    now = Date.now(),
  ): boolean {
    return markNeedsHumanForQuestionsInDb(this.db, issueId, correlationIds, reason, now);
  }

  /**
   * Resume an ask_human park only when every correlation recorded by the park
   * has a durable completed answer for this same task. Missing trace/schema is
   * unknown and therefore remains parked.
   */
  resumeNeedsHumanForQuestions(issueId: string, now = Date.now()): RunState | null {
    return resumeNeedsHumanForQuestionsInDb(this.db, issueId, now);
  }

  getEffectByDedupeKey(dedupeKey: string): EffectRecord | null {
    const row = this.db.prepare('SELECT * FROM automation_effects WHERE dedupe_key = ?').get(dedupeKey) as EffectRow | undefined;
    return row ? toEffectRecord(row) : null;
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
      return toEffectRecord(claimed) as EffectClaim;
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
    return readLedgerMetrics(this.db, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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
    const targetState: Extract<RunState, 'READY' | 'DONE' | 'CANCELLED'> = currentKinds
      .some((effect) => effect.kind === 'tracker.cancel') ? 'CANCELLED' : currentKinds
        .some((effect) => effect.kind === 'tracker.integration_requeue') ? 'READY' : 'DONE';
    if (!ALLOWED_TRANSITIONS.SYNC_PENDING.includes(targetState)) return false;
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET state = ?, state_version = state_version + 1,
          owner_instance_id = NULL, lease_token = NULL, lease_expires_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE issue_id = ? AND state_version = ? AND state = 'SYNC_PENDING'
    `).run(targetState, targetState === 'READY' ? null : now, now, issueId, run.state_version);
    if (result.changes !== 1) return false;
    if (targetState !== 'READY') {
      this.db.prepare(`
        UPDATE automation_attempts
        SET status = ?, stage = ?, finished_at = ?
        WHERE issue_id = ? AND attempt_no = ?
      `).run(targetState === 'CANCELLED' ? 'cancelled' : 'completed', targetState, now, issueId, run.attempt_no);
    }
    this.insertEvent(issueId, run.attempt_no, 'effects_applied', 'SYNC_PENDING', targetState, undefined, now);
    return true;
  }
}
