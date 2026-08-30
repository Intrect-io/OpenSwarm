import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ACTIVE_LEASE_STATES,
  type IntegrationReservationClaim,
  type IntegrationReservationOptions,
} from './runLedgerTypes.js';

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function deleteExpired(db: Database.Database, now: number): void {
  db.prepare(`
    DELETE FROM automation_integration_reservations WHERE lease_expires_at <= ?
  `).run(now);
}

/** Called inside claimRun()'s IMMEDIATE transaction. */
export function integrationReservationBlocksClaim(
  db: Database.Database,
  run: { projectPath: string; branchName?: string; issueId: string; issueIdentifier?: string },
  now: number,
): boolean {
  deleteExpired(db, now);
  const reservation = db.prepare(`
    SELECT 1 AS reserved
    FROM automation_integration_reservations AS reservation
    WHERE reservation.project_path = ? AND reservation.lease_expires_at > ?
      AND (
        reservation.branch_name = ?
        OR reservation.issue_identifier = ?
        OR reservation.issue_identifier = ?
      )
    LIMIT 1
  `).get(
    run.projectPath,
    now,
    run.branchName ?? '',
    run.issueIdentifier ?? '',
    run.issueId,
  ) as { reserved: number } | undefined;
  return reservation !== undefined;
}

export function acquireIntegrationReservationInDb(
  db: Database.Database,
  projectPath: string,
  branchName: string,
  issueIdentifier: string,
  options: IntegrationReservationOptions,
): IntegrationReservationClaim | null {
  const now = options.now ?? Date.now();
  const reservationToken = randomUUID();
  const leaseExpiresAt = now + options.leaseMs;
  const reserve = db.transaction((): IntegrationReservationClaim | null => {
    deleteExpired(db, now);
    const activeWorker = db.prepare(`
      SELECT 1 AS active
      FROM automation_runs
      WHERE project_path = ?
        AND state IN (${placeholders(ACTIVE_LEASE_STATES)})
        AND lease_expires_at > ?
        AND (branch_name = ? OR identifier = ? OR issue_id = ?)
      LIMIT 1
    `).get(
      projectPath,
      ...ACTIVE_LEASE_STATES,
      now,
      branchName,
      issueIdentifier,
      issueIdentifier,
    ) as { active: number } | undefined;
    if (activeWorker) return null;

    const inserted = db.prepare(`
      INSERT OR IGNORE INTO automation_integration_reservations(
        project_path, branch_name, issue_identifier, owner_instance_id,
        reservation_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectPath,
      branchName,
      issueIdentifier,
      options.ownerInstanceId,
      reservationToken,
      leaseExpiresAt,
      now,
      now,
    );
    if (inserted.changes !== 1) return null;
    return {
      projectPath,
      branchName,
      issueIdentifier,
      ownerInstanceId: options.ownerInstanceId,
      reservationToken,
      leaseExpiresAt,
    };
  });
  return reserve.immediate();
}

export function renewIntegrationReservationInDb(
  db: Database.Database,
  reservation: IntegrationReservationClaim,
  leaseMs: number,
  now: number,
): IntegrationReservationClaim | null {
  const leaseExpiresAt = now + leaseMs;
  const renewed = db.prepare(`
    UPDATE automation_integration_reservations
    SET lease_expires_at = ?, updated_at = ?
    WHERE project_path = ? AND branch_name = ? AND issue_identifier = ?
      AND owner_instance_id = ? AND reservation_token = ?
      AND lease_expires_at > ?
  `).run(
    leaseExpiresAt,
    now,
    reservation.projectPath,
    reservation.branchName,
    reservation.issueIdentifier,
    reservation.ownerInstanceId,
    reservation.reservationToken,
    now,
  );
  return renewed.changes === 1 ? { ...reservation, leaseExpiresAt } : null;
}

export function releaseIntegrationReservationInDb(
  db: Database.Database,
  reservation: IntegrationReservationClaim,
): boolean {
  const released = db.prepare(`
    DELETE FROM automation_integration_reservations
    WHERE project_path = ? AND branch_name = ? AND issue_identifier = ?
      AND owner_instance_id = ? AND reservation_token = ?
  `).run(
    reservation.projectPath,
    reservation.branchName,
    reservation.issueIdentifier,
    reservation.ownerInstanceId,
    reservation.reservationToken,
  );
  return released.changes === 1;
}
