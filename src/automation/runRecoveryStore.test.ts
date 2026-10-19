import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunLedger, type RunClaim } from './runLedger.js';
import type { ExecutionContract, ProgressSnapshot } from './loopRecoveryTypes.js';
import { recoveryHash } from './runRecoveryStore.js';

let root: string, ledger: RunLedger, claim: RunClaim;
let clock = 100_000;
const contract: ExecutionContract = { version: 1, issueId: 'task', repository: '/repo', taskHash: 'task-v1', policyHash: 'policy', acceptance: ['Required behavior'], allowedFiles: ['src'] };
const observation = (over: Partial<ProgressSnapshot> = {}): Omit<ProgressSnapshot, 'consecutiveNoProgress'> => ({
  stage: 'reviewer', artifactDigest: 'tree', checks: ['observed-test'], cause: 'infra', failureFingerprint: 'same',
  observedAt: clock, observability: 'stage', ...over,
});
const hooks = () => ledger.recovery.forClaim(() => claim, () => clock);
beforeEach(() => {
  clock = 100_000; root = mkdtempSync(join(tmpdir(), 'recovery-ledger-'));
  ledger = new RunLedger(join(root, 'automation.db'));
  ledger.registerRun({ issueId: 'task', source: 'local', projectPath: '/repo' }, clock);
  claim = ledger.claimRun('task', { ownerInstanceId: 'first', leaseMs: 60_000, now: clock })!;
  expect(claim).toBeTruthy(); expect(ledger.transition(claim, 'EXECUTING', {}, clock)).toBe(true);
  hooks().contract(contract);
});
afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });

describe('durable recovery ownership and progress', () => {
  it('keeps advisor parks out of idle fill and consumes the stop only on explicit operator resume', () => {
    const advice = hooks().reserveAdvice('stop', 'active', 2)!;
    hooks().finishAdvice(advice.id, { status: 'completed', applied: true, decision: { action: 'stop', diagnosis: 'Needs a decision', evidence: ['failure'], condition: 'Operator changes the input', verification: 'Run the required checks' } });
    expect(ledger.transition(claim, 'NEEDS_HUMAN', { errorCode: 'recovery_advisor_park' }, clock)).toBe(true);
    expect(ledger.resumeNeedsHuman('task', clock, 'idle_fill')).toBeNull();
    expect(ledger.recovery.status('task', clock).advice?.applied).toBe(true);
    expect(ledger.resumeNeedsHuman('task', clock)).toBe('READY');
    expect(ledger.recovery.status('task', clock).advice?.applied).toBe(false);
  });
  it('keeps failure evidence across successful other stages and a database reopen', () => {
    expect(hooks().observe(observation()).consecutiveNoProgress).toBe(1);
    hooks().observe(observation({ stage: 'worker', cause: undefined, failureFingerprint: undefined }));
    ledger.close(); ledger = new RunLedger(join(root, 'automation.db'));
    expect(hooks().observe(observation()).consecutiveNoProgress).toBe(2);
    expect(hooks().observe(observation({ artifactDigest: 'changed-tree' })).consecutiveNoProgress).toBe(1);
    expect(hooks().observe(observation({ artifactDigest: 'changed-tree', checks: ['new-ground-truth'] })).consecutiveNoProgress).toBe(1);
    expect(hooks().observe(observation({ artifactDigest: 'changed-tree', checks: ['new-ground-truth'], environmentDigest: 'new-runtime' })).consecutiveNoProgress).toBe(1);
  });

  it('rejects expired and stale owner observations, checkpoints and late advice', () => {
    const stale = hooks(); const advice = stale.reserveAdvice('input', 'active', 2)!;
    clock += 60_001;
    expect(() => stale.observe(observation())).toThrow('lease fence');
    expect(stale.finishAdvice(advice.id, { status: 'completed', applied: true })).toBe(false);
    expect(() => stale.reserveAdvice('again', 'active', 2)).toThrow('lease fence');
    expect(ledger.recovery.status('task', clock).advice?.status).toBe('interrupted');
  });

  it('reserves once per evidence across two connections, failures and restart', () => {
    const first = hooks().reserveAdvice('evidence-a', 'shadow', 2)!;
    const peer = new RunLedger(join(root, 'automation.db'));
    expect(peer.recovery.forClaim(() => claim, () => clock).reserveAdvice('evidence-a', 'shadow', 2)).toBeUndefined();
    peer.close();
    expect(hooks().finishAdvice(first.id, { status: 'unavailable', reason: 'provider unavailable', applied: false })).toBe(true);
    ledger.close(); ledger = new RunLedger(join(root, 'automation.db'));
    expect(hooks().reserveAdvice('evidence-a', 'active', 2)).toBeUndefined();
    expect(hooks().reserveAdvice('evidence-b', 'active', 2)).toBeTruthy();
    expect(hooks().reserveAdvice('evidence-c', 'active', 2)).toBeUndefined();
    const db = new Database(join(root, 'automation.db'));
    db.prepare('UPDATE automation_advice SET created_at=?').run(clock - 24 * 60 * 60_000 - 1); db.close();
    expect(hooks().reserveAdvice('evidence-c', 'active', 2)).toBeTruthy();
    expect(hooks().reserveAdvice('evidence-a', 'active', 2)).toBeUndefined();
  });

  it('does not consult behind an external execution hold', () => {
    const db = new Database(join(root, 'automation.db'));
    db.exec('CREATE TABLE automation_exec_runs(issue_id TEXT PRIMARY KEY,actor TEXT,created_at INTEGER,updated_at INTEGER)');
    db.prepare('INSERT INTO automation_exec_runs VALUES (?,?,?,?)').run('task', 'external-director', clock, clock); db.close();
    expect(hooks().reserveAdvice('held', 'active', 2)).toBeUndefined();
    expect(ledger.getRun('task')?.state).toBe('EXECUTING');
  });

  it('only resumes checkpoints bound to contract, artifact, environment and an allowed recovery boundary', () => {
    const checkpoint = { contractHash: recoveryHash(contract), artifactDigest: 'tree', environmentHash: 'env',
      stage: 'worker' as const, result: { stage: 'worker' as const, success: true,
        result: { success: true, filesChanged: ['src/a.ts'], summary: 'Changed behavior' }, startedAt: 1, completedAt: 2, duration: 1 } };
    hooks().checkpoint(checkpoint);
    expect(hooks().resume(recoveryHash(contract), 'tree', 'env')).toEqual([]);
    hooks().resumable('reviewer');
    expect(hooks().resume(recoveryHash(contract), 'tree', 'env')).toHaveLength(1);
    for (const args of [['wrong', 'tree', 'env'], [recoveryHash(contract), 'changed', 'env'], [recoveryHash(contract), 'tree', 'different']]) {
      expect(hooks().resume(args[0], args[1], args[2])).toEqual([]);
    }
    hooks().contract({ ...contract, taskHash: 'new-user-intent' });
    hooks().resumable('reviewer');
    expect(hooks().resume(recoveryHash(contract), 'tree', 'env')).toEqual([]);
  });

  it('reports exact scoped counts and keeps observations separate from authority', () => {
    hooks().observe(observation()); hooks().observe(observation());
    hooks().reserveAdvice('pending', 'active', 2);
    expect(ledger.recovery.summary(undefined, clock)).toMatchObject({ tracked: 1, noProgress: 1, advising: 1 });
    expect(ledger.recovery.summary(() => false)).toMatchObject({ tracked: 0, noProgress: 0, advising: 0 });
    expect(ledger.recovery.status('not-found')).toEqual({ contract: undefined, progress: undefined, advice: undefined, nextAction: undefined, reason: undefined });
    expect(ledger.getRun('not-found')).toBeNull();
  });
});
