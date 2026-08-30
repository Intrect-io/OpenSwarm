import { describe, expect, it, vi } from 'vitest';
import {
  IntegrationCoordinator,
  type IntegrationConflictEvidence,
  type MergedPREvent,
} from './integrationCoordinator.js';
import type { OwnedPR } from './prOwnership.js';
import type { PRInfo } from '../github/index.js';

const event: MergedPREvent = {
  repo: 'owner/repo',
  prNumber: 10,
  branch: 'swarm/merged',
  baseBranch: 'main',
  mergeCommitOid: 'merge-10',
};

function sibling(number: number, branch = `swarm/task-${number}`): PRInfo {
  return {
    repo: 'owner/repo', number, branch, baseBranch: 'main', title: `PR ${number}`,
    createdAt: '2026-08-30T00:00:00.000Z', url: `https://example.test/${number}`,
  };
}

function owned(pr: PRInfo): OwnedPR {
  return {
    repo: pr.repo,
    prNumber: pr.number,
    branch: pr.branch,
    issueIdentifier: `AGT-${pr.number}`,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
}

function nonAncestor(): Error & { code: number } {
  return Object.assign(new Error('not ancestor'), { code: 1 });
}

describe('IntegrationCoordinator (AGT-4078)', () => {
  it('rebases in a detached scratch worktree and pushes with an exact lease', async () => {
    const pr = sibling(11);
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = vi.fn(async (cwd: string, ...args: string[]) => {
      calls.push({ cwd, args });
      if (args[0] === 'worktree' && args[1] === 'list') return '';
      if (args[0] === 'rev-parse' && args[1].endsWith('/head')) return 'old-head\n';
      if (args[0] === 'rev-parse' && args[1].endsWith('/base')) return 'new-base\n';
      if (args[0] === 'merge-base') throw nonAncestor();
      return '';
    });
    const coordinator = new IntegrationCoordinator({
      git,
      listOpenPRs: vi.fn(async () => [pr]),
      readMergeability: vi.fn(async () => 'MERGEABLE'),
      getActiveLeaseBranches: vi.fn(() => []),
      getActiveLeaseIdentifiers: vi.fn(() => []),
      routeConflict: vi.fn(),
    });

    const result = await coordinator.integrate(event, '/repo', [owned(pr)]);

    expect(result.complete).toBe(true);
    expect(result.results[0]).toMatchObject({ status: 'rebased', mergeability: 'MERGEABLE' });
    expect(calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'add' && args[2] === '--detach')).toBe(true);
    expect(calls.some(({ args }) => args[0] === 'push'
      && args.includes('HEAD:refs/heads/swarm/task-11')
      && args.includes('--force-with-lease=refs/heads/swarm/task-11:old-head'))).toBe(true);
    expect(calls.some(({ cwd, args }) => cwd === '/repo' && args[0] === 'checkout')).toBe(false);
  });

  it('skips before fetch when the branch has a live lease or active worktree', async () => {
    const leased = sibling(11, 'swarm/leased');
    const checkedOut = sibling(12, 'swarm/checked-out');
    const git = vi.fn(async (_cwd: string, ...args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return 'worktree /repo-wt\nHEAD abc\nbranch refs/heads/swarm/checked-out\n\n';
      }
      return '';
    });
    const coordinator = new IntegrationCoordinator({
      git,
      listOpenPRs: vi.fn(async () => [leased, checkedOut]),
      // A claim can be live before attachWorktree records branchName; the
      // owning issue identifier must still fence it.
      getActiveLeaseBranches: vi.fn(() => []),
      getActiveLeaseIdentifiers: vi.fn(() => ['AGT-11']),
      routeConflict: vi.fn(),
    });

    const result = await coordinator.integrate(event, '/repo', [owned(leased), owned(checkedOut)]);

    expect(result.results.map((item) => item.status)).toEqual(['skipped-active', 'skipped-active']);
    expect(git.mock.calls.some(([, command]) => command === 'fetch')).toBe(false);
  });

  it('routes rebase conflict evidence to the owning issue and continues', async () => {
    const conflicted = sibling(11);
    const clean = sibling(12);
    const routeConflict = vi.fn(async (_evidence: IntegrationConflictEvidence) => undefined);
    const git = vi.fn(async (_cwd: string, ...args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') return '';
      if (args[0] === 'fetch' && args.some((arg) => arg.includes('pull/12/head'))) {
        throw new Error('network failure for one sibling');
      }
      if (args[0] === 'rev-parse' && args[1].endsWith('/head')) return 'old-head\n';
      if (args[0] === 'rev-parse' && args[1].endsWith('/base')) return 'new-base\n';
      if (args[0] === 'merge-base') throw nonAncestor();
      if (args[0] === 'rebase' && args[1] !== '--abort') throw new Error('CONFLICT');
      if (args[0] === 'diff') return 'src/shared.ts\n';
      return '';
    });
    const coordinator = new IntegrationCoordinator({
      git,
      listOpenPRs: vi.fn(async () => [conflicted, clean]),
      getActiveLeaseBranches: vi.fn(() => []),
      getActiveLeaseIdentifiers: vi.fn(() => []),
      routeConflict,
    });

    const result = await coordinator.integrate(event, '/repo', [owned(conflicted), owned(clean)]);

    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ prNumber: 11, status: 'conflict-routed', conflictFiles: ['src/shared.ts'] }),
      expect.objectContaining({ prNumber: 12, status: 'failed', error: 'network failure for one sibling' }),
    ]));
    expect(routeConflict).toHaveBeenCalledWith(expect.objectContaining({
      issueIdentifier: 'AGT-11', mergeCommitOid: 'merge-10', conflictFiles: ['src/shared.ts'],
    }));
  });

  it('keeps UNKNOWN distinct and pending until GitHub computes mergeability', async () => {
    const pr = sibling(11);
    const wait = vi.fn(async () => undefined);
    const coordinator = new IntegrationCoordinator({
      git: vi.fn(async (_cwd: string, ...args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse' && args[1].endsWith('/head')) return 'same-head\n';
        if (args[0] === 'rev-parse' && args[1].endsWith('/base')) return 'base\n';
        return '';
      }),
      listOpenPRs: vi.fn(async () => [pr]),
      readMergeability: vi.fn(async () => 'UNKNOWN'),
      getActiveLeaseBranches: vi.fn(() => []),
      getActiveLeaseIdentifiers: vi.fn(() => []),
      routeConflict: vi.fn(),
      wait,
      mergeabilityAttempts: 3,
    });

    const result = await coordinator.integrate(event, '/repo', [owned(pr)]);

    expect(result.complete).toBe(false);
    expect(result.results[0]).toMatchObject({ status: 'mergeability-unknown', mergeability: 'UNKNOWN' });
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
