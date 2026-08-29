import { describe, expect, it } from 'vitest';
import { hasStrandedWork, worktreeIsPublishable } from './autonomousRunner.js';

describe('hasStrandedWork (AGT-4076)', () => {
  // The shape these have to match was read off the deployed daemon: all 26
  // NEEDS_HUMAN rows there carry a branch, a worktree, and no PR.
  it('accepts a parked run whose branch was never published', () => {
    expect(hasStrandedWork({ branchName: 'swarm/AX-1030-x', worktreePath: '/w/1030' })).toBe(true);
  });

  it('skips a run that already has a PR', () => {
    expect(hasStrandedWork({
      prUrl: 'https://github.com/o/r/pull/1', branchName: 'swarm/AX-1030-x', worktreePath: '/w/1030',
    })).toBe(false);
  });

  it('skips a run with no branch', () => {
    expect(hasStrandedWork({ worktreePath: '/w/875' })).toBe(false);
  });

  it('skips a run with no worktree to publish from', () => {
    expect(hasStrandedWork({ branchName: 'swarm/AX-1030-x' })).toBe(false);
  });
});

describe('worktreeIsPublishable (AGT-4076)', () => {
  it('permits a preserved worktree — the run kept its own work', () => {
    expect(worktreeIsPublishable('preserved')).toBe(true);
  });

  it('permits an orphaned worktree — its writer is provably gone', () => {
    expect(worktreeIsPublishable('orphaned')).toBe(true);
  });

  it('refuses an actively owned worktree', () => {
    // Writing here would race a live executor; this is the verdict that kept
    // AX-1030/863/885 parked on the deployed daemon.
    expect(worktreeIsPublishable('active_owner')).toBe(false);
  });

  it('refuses an ambiguous worktree', () => {
    expect(worktreeIsPublishable('ambiguous')).toBe(false);
  });

  it('refuses a missing worktree — nothing to publish from', () => {
    expect(worktreeIsPublishable('missing')).toBe(false);
  });
});
