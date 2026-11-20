// An approved run whose files overlap an open sibling swarm PR opens no PR and
// is deferred (AGT-4786): on 2026-10-20 cgf-portal #1341 and #1320 were
// published side by side over the same files.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commitAndCreatePRWithHead = vi.hoisted(() => vi.fn(async () => ({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'abc' })));
vi.mock('../support/worktreeManager.js', () => ({
  commitAndCreatePRWithHead,
  resolveBaseRef: async () => ({ remote: 'origin', branch: 'main', ref: 'main' }),
}));
const findOpenPRFileOverlaps = vi.hoisted(() => vi.fn());
vi.mock('../support/openPullRequestOverlaps.js', () => ({ findOpenPRFileOverlaps }));
// Only the own-branch PR lookup goes through `gh` directly.
const gh = vi.hoisted(() => vi.fn(async () => '[]'));
vi.mock('../support/ghPullRequests.js', () => ({ gh }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('./testRemovalGate.js', () => ({ TEST_REMOVAL_PARK_REASON: 'active_tests_removed', testRemovalHold: async () => null }));
vi.mock('../agents/protectedFiles.js', () => ({ computeProtectedFiles: async () => [] }));
vi.mock('./coverageRatchetGate.js', () => ({
  COVERAGE_DROP_PARK_REASON: 'coverage_dropped',
  coverageRatchetHold: async () => ({ status: 'pass' }),
}));

import { publishApprovedWork, publishFinishedRun } from './publishOnPark.js';
import { MAX_LOOKUP_FAILURE_DEFERRALS, MAX_OVERLAP_DEFERRALS, resetSiblingOverlapDeferrals } from './siblingOverlapDefer.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const SIBLING = { number: 1320, url: 'https://github.com/o/r/pull/1320', headRefName: 'swarm/AX-1953-sales', label: 'PR #1320 (swarm/AX-1953-sales)', files: ['src/ledger.ts'] };

describe('approved publication behind an open sibling PR (AGT-4786)', () => {
  let repo = '';
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-overlap-defer-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'swarm/AX-1954-card');
    // Uncommitted, as an approved worker leaves it: the commit happens at publication.
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/ledger.ts'), 'export const fixed = true;\n');
    commitAndCreatePRWithHead.mockClear();
    findOpenPRFileOverlaps.mockReset();
    gh.mockReset().mockResolvedValue('[]');
    resetSiblingOverlapDeferrals();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const info = () => ({ worktreePath: repo, originalPath: repo, branchName: 'swarm/AX-1954-card', issueId: 'i-1954' });
  const task = { id: 't', issueId: 'i-1954', title: 'Card evidence defects', issueIdentifier: 'AX-1954' };
  const approved = () => ({ success: true, finalStatus: 'approved' } as Parameters<typeof publishApprovedWork>[2]);

  it('an approved run overlapping an open sibling PR opens no PR and is deferred', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([SIBLING]);
    const beforePublish = vi.fn(async () => true);
    const result = approved();
    const before = Date.now();

    await publishFinishedRun(info(), task, result, { beforePublish, onPublication: async () => true } as never, () => undefined);

    expect(commitAndCreatePRWithHead).not.toHaveBeenCalled();
    expect(beforePublish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, finalStatus: 'deferred' });
    expect(result.retryAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(result.failureDetail).toContain('https://github.com/o/r/pull/1320');
    expect(result.prUrl).toBeUndefined();
    expect(result.operatorPark).toBeUndefined();
    // The planned set came from the uncommitted tree, and the run's own issue is excluded.
    expect(findOpenPRFileOverlaps).toHaveBeenCalledWith(repo, ['src/ledger.ts'], { selfIssueIdentifier: 'AX-1954' }, { throwOnLookupFailure: true });
  });

  it('publishes when no sibling overlaps, and ignores a non-swarm PR', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([{ ...SIBLING, headRefName: 'feature/human' }]);
    const result = approved();
    await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
    expect(result.prUrl).toBe('https://github.com/o/r/pull/9');
  });

  it('hands the approving verdict\'s coverage to the publisher', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([]);
    const complete = { ...approved(), reviewResult: { decision: 'approve', coverage: 'complete' as const } };
    await publishApprovedWork(info(), task, complete, { beforePublish: async () => true, onPublication: async () => true } as never);
    const unstated = { ...approved(), reviewResult: { decision: 'approve' } };
    await publishApprovedWork(info(), task, unstated, { beforePublish: async () => true, onPublication: async () => true } as never);
    expect(commitAndCreatePRWithHead).toHaveBeenNthCalledWith(1, expect.anything(), task.title, 'AX-1954', '', expect.objectContaining({ coverage: 'complete' }));
    expect(commitAndCreatePRWithHead).toHaveBeenNthCalledWith(2, expect.anything(), task.title, 'AX-1954', '', expect.objectContaining({ coverage: 'unknown' }));
  });

  it('does not gate a branch that already has its own open PR', async () => {
    gh.mockResolvedValue(JSON.stringify([{ url: 'https://github.com/o/r/pull/5' }]));
    findOpenPRFileOverlaps.mockResolvedValue([SIBLING]);
    const result = approved();
    await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
    expect(findOpenPRFileOverlaps).not.toHaveBeenCalled();
  });

  it('defers on a lookup failure, then publishes once the cap is reached', async () => {
    findOpenPRFileOverlaps.mockRejectedValue(new Error('gh: HTTP 502'));
    for (let i = 0; i < MAX_LOOKUP_FAILURE_DEFERRALS; i++) {
      const result = approved();
      await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
      expect(result.finalStatus).toBe('deferred');
      expect(result.failureDetail).toContain('gh: HTTP 502');
    }
    const result = approved();
    await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
  });

  it('backs off each overlap deferral and publishes after the cap', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([SIBLING]);
    const delays: number[] = [];
    for (let i = 0; i < MAX_OVERLAP_DEFERRALS; i++) {
      const result = approved();
      const now = Date.now();
      await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
      expect(result.finalStatus).toBe('deferred');
      delays.push(Math.round((result.retryAt! - now) / 60_000));
    }
    expect(delays).toEqual([30, 60, 120, 240]);
    const result = approved();
    await publishApprovedWork(info(), task, result, { beforePublish: async () => true, onPublication: async () => true } as never);
    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
  });
});
