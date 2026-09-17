import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';

const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-pidspace-'));
  roots.push(root);
  return join(root, 'automation.db');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// AGT-4072: the row carries the writer's pid space, so "our pid under
// another instance id" proves a prior generation only when the numbering
// is ours. Two containers on one ledger both run as pid 7; without the
// space the same rule would free a LIVE peer's row.
describe('pid-space proof (AGT-4072)', () => {
  function fencedRow(ledger: RunLedger, issueId: string, ownerInstanceId: string, ownerPidSpace?: string) {
    ledger.registerRun({ issueId, source: 'linear', projectPath: '/repo' }, 1_000);
    const claim = ledger.claimRun(issueId, { ownerInstanceId, ownerPidSpace, leaseMs: 3_000, now: 1_000 })!;
    expect(ledger.transition(claim, 'EXECUTING', {}, 1_100)).toBe(true);
    return claim;
  }

  it('stamps the claimer pid space on the row', () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, instanceId: `${process.pid}-me`, pidSpace: 'pidns:boot:ns' });
    ledger.registerRun({ issueId: 'STAMP', source: 'linear', projectPath: '/repo' }, 1_000);
    expect(ledger.claimRun('STAMP', { ownerInstanceId: 'x', ownerPidSpace: 'pidns:boot:ns', leaseMs: 3_000, now: 1_000 })).not.toBeNull();
    expect(ledger.getRun('STAMP')?.ownerPidSpace).toBe('pidns:boot:ns');
    coordinator.close();
    ledger.close();
  });

  it('releases a prior generation in our own pid space immediately, with no timer', () => {
    const ledger = new RunLedger(dbPath());
    fencedRow(ledger, 'PRIOR-GEN', `${process.pid}-prior-generation`, 'pidns:boot:ns');
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: `${process.pid}-current-generation`, pidSpace: 'pidns:boot:ns',
      processIsAlive: () => true, // the pid IS alive — it is us
      reconcileAbandonMs: 60 * 60_000,
    });
    // Still leased: the active-state loop releases it on proof alone, and
    // the NEEDS_RECONCILE loop of the same sweep reopens it (nothing was
    // published) — freed and claimable again with no timer involved.
    const reconciled = coordinator.reconcile(2_000);
    expect(reconciled.map((run) => run.state)).toEqual(['NEEDS_RECONCILE', 'READY']);
    expect(ledger.getRun('PRIOR-GEN')).toMatchObject({ state: 'READY', ownerInstanceId: undefined, leaseToken: undefined });
    coordinator.close();
    ledger.close();
  });

  it('releases a fenced NEEDS_RECONCILE prior generation on the first sweep after lease expiry', () => {
    const ledger = new RunLedger(dbPath());
    fencedRow(ledger, 'PRIOR-NR', `${process.pid}-prior-generation`, 'pidns:boot:ns');
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: `${process.pid}-current-generation`, pidSpace: 'pidns:boot:ns',
      processIsAlive: () => true,
      reconcileAbandonMs: 60 * 60_000,
    });
    // Lease expired at 4_000 → NEEDS_RECONCILE; the same sweep frees the owner by proof, age 0.
    coordinator.reconcile(4_001);
    expect(ledger.getRun('PRIOR-NR')).toMatchObject({ state: 'NEEDS_RECONCILE', ownerInstanceId: undefined, leaseToken: undefined });
    coordinator.close();
    ledger.close();
  });

  it.each([
    ['absent', undefined],
    ['foreign', 'pidns:other-boot:other-ns'],
  ])('a row whose space is %s still waits for reconcileAbandonMs even under our own pid', (_label, space) => {
    const ledger = new RunLedger(dbPath());
    fencedRow(ledger, 'FAIL-CLOSED', `${process.pid}-some-generation`, space);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: `${process.pid}-current-generation`, pidSpace: 'pidns:boot:ns',
      processIsAlive: () => false, // even a "dead" probe answer must not be trusted across spaces
      reconcileAbandonMs: 5_000,
    });
    coordinator.reconcile(2_000);
    expect(ledger.getRun('FAIL-CLOSED')).toMatchObject({ state: 'EXECUTING', ownerInstanceId: `${process.pid}-some-generation` });
    coordinator.reconcile(4_001); // lease expiry → NEEDS_RECONCILE, still owned
    coordinator.reconcile(4_001 + 4_999);
    expect(ledger.getRun('FAIL-CLOSED')).toMatchObject({ state: 'NEEDS_RECONCILE', ownerInstanceId: `${process.pid}-some-generation` });
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('FAIL-CLOSED')).toMatchObject({ state: 'NEEDS_RECONCILE', ownerInstanceId: undefined });
    coordinator.close();
    ledger.close();
  });

  it('a writer that could not name its own space judges nothing and waits for the timer', () => {
    const ledger = new RunLedger(dbPath());
    fencedRow(ledger, 'NO-OWN-SPACE', `${process.pid}-prior-generation`, 'pidns:boot:ns');
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: `${process.pid}-current-generation`, pidSpace: undefined,
      processIsAlive: () => false,
      reconcileAbandonMs: 5_000,
    });
    coordinator.reconcile(4_001);
    expect(ledger.getRun('NO-OWN-SPACE')).toMatchObject({ state: 'NEEDS_RECONCILE', ownerInstanceId: `${process.pid}-prior-generation` });
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('NO-OWN-SPACE')).toMatchObject({ ownerInstanceId: undefined });
    coordinator.close();
    ledger.close();
  });

  it('never releases a live sibling in our own space', () => {
    const ledger = new RunLedger(dbPath());
    fencedRow(ledger, 'SIBLING', '31337-sibling', 'pidns:boot:ns');
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: `${process.pid}-me`, pidSpace: 'pidns:boot:ns',
      processIsAlive: (pid) => pid === 31337,
      reconcileAbandonMs: 60 * 60_000,
    });
    coordinator.reconcile(2_000);
    coordinator.reconcile(4_001);
    coordinator.reconcile(60_000);
    expect(ledger.getRun('SIBLING')).toMatchObject({ state: 'NEEDS_RECONCILE', ownerInstanceId: '31337-sibling' });
    coordinator.close();
    ledger.close();
  });
});
