// Created: 2026-11-21
// Purpose: The transient origin-lookup backoff is capped: after MAX_TRANSIENT_FAILURES the run parks NEEDS_HUMAN.
// Dependencies: vitest, ./missingWorktreeReconciler.js
// Test Status: passing

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TRANSIENT_FAILURES, memoryBackoffStore, originLookupBackoffMs, reconcileMissingWorktrees,
  resetOriginLookupBackoffForTests, type MissingWorktreeReconcileDeps,
} from './missingWorktreeReconciler.js';

type Ledger = MissingWorktreeReconcileDeps['durableRuns'];
type Run = ReturnType<Ledger['listRuns']>[number];

const HOUR = 60 * 60_000;

function transientError(): Error {
  return Object.assign(new Error('Command failed: git ls-remote\nfatal: Could not resolve host: github.com'),
    { stderr: 'fatal: Could not resolve host: github.com' });
}

/** A ledger whose rows change like the real one: a needs_human park clears the pointer. */
function harness(lsRemote: NonNullable<MissingWorktreeReconcileDeps['lsRemote']>) {
  let clock = 1_000_000;
  const row: Run = {
    issueId: 'INT-77', identifier: 'INT-77', state: 'RETRY_AT', stateVersion: 1,
    worktreePath: '/gone/INT-77', branchName: 'swarm/INT-77', projectPath: '/repo',
  };
  const reasons: string[] = [];
  const reconcile = vi.fn<Ledger['reconcileMissingWorktree']>((_run, disposition, reason) => {
    reasons.push(reason);
    if (disposition === 'needs_human') {
      row.state = 'NEEDS_HUMAN';
      row.worktreePath = undefined;
      row.stateVersion += 1;
    }
    return true;
  });
  const log = { log: vi.fn(), warn: vi.fn() };
  const store = memoryBackoffStore();
  const findPullRequestForBranch = vi.fn<MissingWorktreeReconcileDeps['findPullRequestForBranch']>(async () => null);
  const deps: MissingWorktreeReconcileDeps = {
    durableRuns: { isPrimary: true, listRuns: () => [row], reconcileMissingWorktree: reconcile },
    stopping: () => false,
    findPullRequestForBranch,
    findDuplicateIssuePRs: async () => [],
    lsRemote,
    worktreeExists: () => false,
    store,
    now: () => clock,
    log,
  };
  // One heartbeat after the current backoff (or right away when there is none).
  const pass = async () => {
    const backoff = store.get(row.issueId);
    if (backoff) clock = Math.max(clock, backoff.nextAt) + 1;
    await reconcileMissingWorktrees(deps);
  };
  return { deps, row, reconcile, reasons, log, store, findPullRequestForBranch, pass, advance: (ms: number) => { clock += ms; } };
}

describe('missing-worktree reconciliation: transient failure cap', () => {
  afterEach(() => resetOriginLookupBackoffForTests());

  it('parks a missing worktree for a human after MAX_TRANSIENT_FAILURES origin lookups', async () => {
    const lsRemote = vi.fn(async (): Promise<string> => { throw transientError(); });
    const h = harness(lsRemote);

    for (let i = 0; i < MAX_TRANSIENT_FAILURES; i++) await h.pass();

    expect(lsRemote).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const [, disposition, reason, clearHeadSha] = h.reconcile.mock.calls[0];
    expect(disposition).toBe('needs_human');
    expect(clearHeadSha).toBe(false);
    expect(reason).toContain('Could not resolve host: github.com');
    expect(reason).toContain(`${MAX_TRANSIENT_FAILURES} times`);
    expect(h.row.state).toBe('NEEDS_HUMAN');
    expect(h.row.worktreePath).toBeUndefined();
    expect(h.store.get('INT-77')).toBeUndefined();
    // One warn for the first failure, one for the park.
    expect(h.log.warn).toHaveBeenCalledTimes(2);
    expect(String(h.log.warn.mock.calls[1][0])).toContain('parked for a person');

    // Fail closed: later passes never probe it again.
    for (let i = 0; i < 5; i++) {
      h.advance(24 * HOUR);
      await reconcileMissingWorktrees(h.deps);
    }
    expect(lsRemote).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('a success before the cap clears the count, so the cap needs a fresh run of failures', async () => {
    let succeedNext = false;
    const lsRemote = vi.fn(async (): Promise<string> => {
      if (succeedNext) { succeedNext = false; return ''; }
      throw transientError();
    });
    const h = harness(lsRemote);
    // The GitHub lookup fails once, so the successful probe keeps the pointer.
    h.findPullRequestForBranch.mockRejectedValueOnce(new Error('gh: network down'));

    for (let i = 0; i < MAX_TRANSIENT_FAILURES - 1; i++) await h.pass();
    expect(h.store.get('INT-77')).toMatchObject({ failures: MAX_TRANSIENT_FAILURES - 1 });

    succeedNext = true;
    await h.pass();
    expect(h.store.get('INT-77')).toBeUndefined();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.row.worktreePath).toBe('/gone/INT-77');

    // The count restarts at one with the short delay, and the cap is not hit early.
    await h.pass();
    expect(h.store.get('INT-77')).toMatchObject({ failures: 1 });
    expect(originLookupBackoffMs(1)).toBe(5 * 60_000);
    for (let i = 1; i < MAX_TRANSIENT_FAILURES - 1; i++) await h.pass();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.row.state).toBe('RETRY_AT');

    await h.pass();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile.mock.calls[0][1]).toBe('needs_human');
    expect(lsRemote).toHaveBeenCalledTimes(2 * MAX_TRANSIENT_FAILURES);
  });

  it('keeps the failure count when the park loses a ledger race', async () => {
    const lsRemote = vi.fn(async (): Promise<string> => { throw transientError(); });
    const h = harness(lsRemote);
    // The row changed under the reconciler: the first park is refused and nothing moves.
    h.reconcile.mockImplementationOnce((_run, disposition) => {
      expect(disposition).toBe('needs_human');
      return false;
    });

    for (let i = 0; i < MAX_TRANSIENT_FAILURES; i++) await h.pass();

    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.row.state).toBe('RETRY_AT');
    expect(h.row.worktreePath).toBe('/gone/INT-77');
    const kept = h.store.get('INT-77');
    expect(kept).toMatchObject({ failures: MAX_TRANSIENT_FAILURES });
    // Only the first-failure warn: no park was reported.
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn.mock.calls.some((c) => String(c[0]).includes('parked for a person'))).toBe(false);

    // Inside the backoff nothing happens.
    await reconcileMissingWorktrees(h.deps);
    expect(lsRemote).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES);
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    // The next pass after nextAt probes once more and parks with the next count.
    await h.pass();
    expect(lsRemote).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES + 1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    const [, disposition, reason] = h.reconcile.mock.calls[1];
    expect(disposition).toBe('needs_human');
    expect(reason).toContain(`${MAX_TRANSIENT_FAILURES + 1} times`);
    expect(h.row.state).toBe('NEEDS_HUMAN');
    expect(h.store.get('INT-77')).toBeUndefined();
    expect(h.log.warn).toHaveBeenCalledTimes(2);
    expect(String(h.log.warn.mock.calls[1][0])).toContain(`origin lookup failed ${MAX_TRANSIENT_FAILURES + 1} times`);
  });
});
