// ============================================
// OpenSwarm - recoverPublishedRun idempotency
// ============================================
//
// Split from runLedger.test.ts, which sits at the repository's 1500-line gate.
// The subject here is one rule: recovering a run whose PR was found on GitHub
// must be idempotent against a completion effect the run already enqueued.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLedger, type RunClaim } from './runLedger.js';

const roots: string[] = [];

function createDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-run-ledger-recovery-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function register(ledger: RunLedger, issueId: string, projectPath = '/repo'): void {
  ledger.registerRun({
    issueId,
    source: 'linear',
    identifier: issueId,
    title: `Task ${issueId}`,
    projectPath,
  }, 1_000);
}

function claim(ledger: RunLedger, issueId: string, owner: string, now = 2_000): RunClaim {
  const result = ledger.claimRun(issueId, {
    ownerInstanceId: owner,
    leaseMs: 1_000,
    // This suite is about dedupe-key scoping, not repository admission; a high
    // cap keeps the second claim from being refused by the per-project limit.
    maxActiveForProject: 10,
    now,
  });
  expect(result).not.toBeNull();
  return result!;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('RunLedger recoverPublishedRun idempotency (AGT-4518)', () => {
  it('does not throw when the run already enqueued its own completion effect', () => {
    // The recovery path recomputes a completion effect for the SAME issue and
    // attempt the run enqueued when it published. The dedupe key is
    // `complete:<issueId>:attempt:<N>`, so the two effects share a key; the
    // payloads differ (the original carries the real worker stats, the recovery
    // a synthetic `recovered-publication-<n>` result), so comparing payloads
    // made recovery of an already-enqueued completion throw
    // `Outbox dedupe key collision` — and, running inside heartbeat()'s try
    // with no per-row catch, that killed the whole heartbeat before any task
    // was selected.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-4518');
    const runClaim = claim(ledger, 'AGT-4518', 'executor', 2_000);
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_100)).toBe(true);
    expect(ledger.transition(runClaim, 'PUBLISHING', {}, 2_200)).toBe(true);
    const published = {
      kind: 'tracker.complete',
      dedupeKey: 'complete:AGT-4518:attempt:1',
      payload: { stats: { real: true } },
    };
    expect(ledger.enqueueEffect(runClaim, published, 2_250)).not.toBeNull();

    // The process dies before the tracker write; the row is reclaimed as
    // NEEDS_RECONCILE by the next owner and the PR is found on GitHub.
    expect(ledger.reconcileExpiredLeases(3_001)).toHaveLength(1);
    expect(ledger.confirmExecutorExit(runClaim, 3_002)).toBe(true);
    expect(ledger.getRun('AGT-4518')?.state).toBe('NEEDS_RECONCILE');

    const recovered = {
      kind: 'tracker.complete',
      dedupeKey: 'complete:AGT-4518:attempt:1',
      payload: { stats: { recovered: true } },
    };
    let threw: Error | undefined;
    let recoveredOk = false;
    try {
      recoveredOk = ledger.recoverPublishedRun(
        'AGT-4518',
        { prUrl: 'https://github.test/pull/918', headSha: 'abc918' },
        recovered,
        3_100,
      );
    } catch (error) {
      threw = error as Error;
    }

    expect({ threw: threw?.message, recoveredOk }).toEqual({ threw: undefined, recoveredOk: true });
    expect(ledger.getRun('AGT-4518')).toMatchObject({
      state: 'SYNC_PENDING', prUrl: 'https://github.test/pull/918', headSha: 'abc918',
    });
    // The effect originally enqueued is the one that survives — recovery must
    // not overwrite the real stats with its synthetic ones.
    expect(ledger.getEffectByDedupeKey('complete:AGT-4518:attempt:1')?.payload).toEqual({ stats: { real: true } });
    ledger.close();
  });

  it('still rejects a key that belongs to a different issue', () => {
    // Idempotency is scoped to THIS run: the same key for another issue is a
    // real collision and must still be refused, not silently accepted.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-4518-A');
    const other = claim(ledger, 'AGT-4518-A', 'executor', 2_000);
    expect(ledger.transition(other, 'EXECUTING', {}, 2_100)).toBe(true);
    // A stale row already holds this key, but it belongs to a DIFFERENT issue.
    expect(ledger.enqueueEffect(other, {
      kind: 'tracker.complete',
      dedupeKey: 'complete:AGT-4518-B:attempt:1',
      payload: { stats: {} },
    }, 2_150)).not.toBeNull();

    register(ledger, 'AGT-4518-B');
    const runClaim = claim(ledger, 'AGT-4518-B', 'executor2', 2_000);
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_100)).toBe(true);
    expect(ledger.transition(runClaim, 'PUBLISHING', {}, 2_200)).toBe(true);
    expect(ledger.reconcileExpiredLeases(3_001)).toHaveLength(2);
    expect(ledger.confirmExecutorExit(runClaim, 3_002)).toBe(true);
    expect(ledger.getRun('AGT-4518-B')?.state).toBe('NEEDS_RECONCILE');

    expect(() => ledger.recoverPublishedRun(
      'AGT-4518-B',
      { prUrl: 'https://github.test/pull/919' },
      { kind: 'tracker.complete', dedupeKey: 'complete:AGT-4518-B:attempt:1', payload: { stats: { other: true } } },
      3_100,
    )).toThrow(/dedupe key collision/i);
    ledger.close();
  });
});
