// Round-1 redteam B-F3 (2026-11-03): a failed `git ls-remote` for a missing
// worktree was swallowed and re-warned every heartbeat — 32% of a day's log
// on the live daemon (61 issues × 364 lines) — with the cause nowhere.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyOriginLookupFailure, memoryBackoffStore, originLookupBackoffMs, reconcileMissingWorktrees,
  resetOriginLookupBackoffForTests, sqliteBackoffStore, type MissingWorktreeReconcileDeps,
} from './missingWorktreeReconciler.js';

type Run = ReturnType<MissingWorktreeReconcileDeps['durableRuns']['listRuns']>[number];

const MIN = 60_000;

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    issueId: id, identifier: id, state: 'RETRY_AT', stateVersion: 1,
    worktreePath: `/gone/${id}`, branchName: `swarm/${id}`, projectPath: '/repo',
    ...overrides,
  };
}

function gitError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: git -C /repo ls-remote origin refs/heads/x\n${stderr}`), { stderr, ...extra });
}

function harness(runs: Run[], lsRemote: MissingWorktreeReconcileDeps['lsRemote']) {
  let clock = 1_000_000;
  const reconcile = vi.fn<MissingWorktreeReconcileDeps['durableRuns']['reconcileMissingWorktree']>(() => true);
  const log = { log: vi.fn(), warn: vi.fn() };
  const store = memoryBackoffStore();
  const deps: MissingWorktreeReconcileDeps = {
    durableRuns: { isPrimary: true, listRuns: () => runs, reconcileMissingWorktree: reconcile },
    stopping: () => false,
    findPullRequestForBranch: async () => null,
    findDuplicateIssuePRs: async () => [],
    lsRemote,
    worktreeExists: () => false,
    store,
    now: () => clock,
    log,
  };
  return { deps, reconcile, log, store, advance: (ms: number) => { clock += ms; } };
}

describe('missing-worktree reconciliation', () => {
  afterEach(() => resetOriginLookupBackoffForTests());

  it('logs a failed origin lookup once with its cause', async () => {
    const lsRemote = vi.fn(async () => { throw gitError('fatal: unable to access \'https://github.com/o/r/\': Could not resolve host: github.com'); });
    const h = harness([run('INT-1')], lsRemote);

    await reconcileMissingWorktrees(h.deps);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(String(h.log.warn.mock.calls[0][0])).toContain('Could not resolve host: github.com');
    expect(String(h.log.warn.mock.calls[0][0])).toContain('next try in 5 min');
    expect(h.reconcile).not.toHaveBeenCalled();

    // The next failure after the backoff is not logged again.
    h.advance(6 * MIN);
    await reconcileMissingWorktrees(h.deps);
    expect(lsRemote).toHaveBeenCalledTimes(2);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.store.get('INT-1')).toMatchObject({ failures: 2 });

    // Recovery is said once, and the run proceeds to the normal disposition.
    lsRemote.mockResolvedValueOnce('abc123\trefs/heads/swarm/INT-1\n');
    h.advance(11 * MIN);
    await reconcileMissingWorktrees(h.deps);
    expect(h.log.log.mock.calls.some((c) => String(c[0]).includes('works again after 2 failure(s)'))).toBe(true);
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'INT-1' }), 'clear', expect.stringContaining('is on origin'), false);
    expect(h.store.get('INT-1')).toBeUndefined();
  });

  it('skips the lookup during backoff', async () => {
    const lsRemote = vi.fn(async () => { throw gitError('fatal: Connection timed out'); });
    const h = harness([run('INT-2')], lsRemote);

    await reconcileMissingWorktrees(h.deps);
    expect(lsRemote).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) {
      h.advance(10_000); // twenty heartbeats inside the five-minute backoff
      await reconcileMissingWorktrees(h.deps);
    }
    expect(lsRemote).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledTimes(1);

    // The backoff ramps and is capped.
    expect([1, 2, 3, 7, 30].map(originLookupBackoffMs)).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 320 * MIN, 360 * MIN]);
  });

  it('parks a permanently failing lookup for a human with the reason', async () => {
    const lsRemote = vi.fn(async () => { throw gitError('remote: Repository not found.\nfatal: repository \'https://github.com/o/gone/\' not found'); });
    const h = harness([run('INT-3', { state: 'NEEDS_HUMAN' })], lsRemote);

    await reconcileMissingWorktrees(h.deps);

    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const [parked, disposition, reason] = h.reconcile.mock.calls[0];
    expect(parked.issueId).toBe('INT-3');
    expect(disposition).toBe('needs_human');
    expect(reason).toContain('retrying cannot fix it');
    expect(reason).toContain("repository 'https://github.com/o/gone/' not found");
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.store.get('INT-3')).toBeUndefined();
  });

  it('classifies auth, missing remotes and paths as permanent; network and timeouts as transient', () => {
    for (const stderr of [
      'fatal: Authentication failed for \'https://github.com/o/r/\'',
      'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
      'git@github.com: Permission denied (publickey).',
      "fatal: 'origin' does not appear to be a git repository",
      'fatal: cannot change to \'/repo\': No such file or directory',
    ]) expect(classifyOriginLookupFailure(gitError(stderr)).kind).toBe('permanent');
    expect(classifyOriginLookupFailure(gitError('fatal: unable to access: Connection reset by peer')).kind).toBe('transient');
    expect(classifyOriginLookupFailure(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }))).toEqual({ kind: 'transient', cause: 'timed out after 30s' });
    expect(classifyOriginLookupFailure(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })).kind).toBe('permanent');
  });

  it('probes concurrently instead of one 30 s lookup after another', async () => {
    let inFlight = 0;
    let peak = 0;
    const lsRemote = vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return '';
    });
    const h = harness(Array.from({ length: 8 }, (_, i) => run(`INT-${10 + i}`)), lsRemote);
    await reconcileMissingWorktrees(h.deps);
    expect(lsRemote).toHaveBeenCalledTimes(8);
    expect(peak).toBe(4);
  });

  it('keeps the backoff in the automation database across restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-origin-backoff-'));
    try {
      const path = join(root, 'automation.db');
      sqliteBackoffStore(path).set('INT-9', { failures: 3, nextAt: 42, cause: 'Could not resolve host' });
      resetOriginLookupBackoffForTests(); // a new process
      expect(sqliteBackoffStore(path).get('INT-9')).toEqual({ failures: 3, nextAt: 42, cause: 'Could not resolve host' });
      sqliteBackoffStore(path).clear('INT-9');
      expect(sqliteBackoffStore(path).get('INT-9')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
