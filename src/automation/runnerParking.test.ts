import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const worktree = vi.hoisted(() => ({ removePreservedWorktreeAt: vi.fn() }));
const publish = vi.hoisted(() => ({ publishStuckWork: vi.fn() }));
const store = vi.hoisted(() => ({ upsertTaskState: vi.fn() }));

vi.mock('../support/worktreeManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/worktreeManager.js')>()),
  removePreservedWorktreeAt: worktree.removePreservedWorktreeAt,
}));
vi.mock('./publishOnPark.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./publishOnPark.js')>()),
  publishStuckWork: publish.publishStuckWork,
}));
vi.mock('../taskState/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../taskState/store.js')>()),
  upsertTaskState: store.upsertTaskState,
}));

import * as runner from './autonomousRunner.js';
import { OPERATOR_PARK_REASON } from '../coordination/operatorAnswers.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import {
  parkRunForHuman,
  publishAndCleanupStuckWorktree,
  setOperatorPark,
  setSandboxOutcomePark,
  stuckPullRequestSection,
} from './runnerParking.js';

const task = { id: 'issue-1', title: 'issue-1' } as unknown as TaskItem;
const ctx = { worktreePath: '/repo/worktree/x', repoRoot: '/repo', branchName: 'x' };

beforeEach(() => {
  vi.clearAllMocks();
  // Run the pre-cleanup publish hook the way the lifecycle lock would.
  worktree.removePreservedWorktreeAt.mockImplementation(
    async (_path: string, hook?: (c: typeof ctx) => Promise<void>) => { await hook?.(ctx); },
  );
  publish.publishStuckWork.mockResolvedValue('https://github.com/o/r/pull/1');
});

describe('runnerParking (AGT-4867 slice 2)', () => {
  it('parkRunForHuman stays re-exported from autonomousRunner for existing importers', () => {
    expect(runner.parkRunForHuman).toBe(parkRunForHuman);
  });

  it('does not publish when the durable park is refused', async () => {
    const durableRuns = { isPrimary: true, markNeedsHuman: vi.fn(() => false) };
    const ownsRun = parkRunForHuman(durableRuns, 'issue-1', 'retries exhausted');

    const prUrl = await publishAndCleanupStuckWorktree(task, '/repo/worktree/x', 'retries exhausted', ownsRun);

    expect(ownsRun).toBe(false);
    expect(prUrl).toBeUndefined();
    expect(worktree.removePreservedWorktreeAt).toHaveBeenCalledWith('/repo/worktree/x', undefined);
    expect(publish.publishStuckWork).not.toHaveBeenCalled();
  });

  it('publishes the stuck work before cleanup when the run is owned', async () => {
    const prUrl = await publishAndCleanupStuckWorktree(task, '/repo/worktree/x', 'retries exhausted', true);

    expect(publish.publishStuckWork).toHaveBeenCalledWith(ctx, task, 'retries exhausted');
    expect(prUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('swallows a cleanup failure and reports no PR', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    worktree.removePreservedWorktreeAt.mockRejectedValue(new Error('lock busy'));

    await expect(publishAndCleanupStuckWorktree(task, '/repo/worktree/x', 'r', true)).resolves.toBeUndefined();
  });

  it('records and retires the operator and sandbox park reasons, best effort', () => {
    setOperatorPark('issue-1', true);
    setOperatorPark('issue-1', false);
    setSandboxOutcomePark('issue-2', true);
    expect(store.upsertTaskState.mock.calls).toEqual([
      ['issue-1', { execution: { blockedReason: OPERATOR_PARK_REASON } }],
      ['issue-1', { execution: { blockedReason: undefined } }],
      ['issue-2', { execution: { blockedReason: SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } }],
    ]);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.upsertTaskState.mockImplementation(() => { throw new Error('db locked'); });
    expect(() => setOperatorPark('issue-1', true)).not.toThrow();
    expect(() => setSandboxOutcomePark('issue-1', true)).not.toThrow();
  });

  it('links the draft PR in the tracker comment only when one exists', () => {
    expect(stuckPullRequestSection(undefined)).toBe('');
    expect(stuckPullRequestSection('https://x/pull/2')).toBe('\n\n**Draft PR with the work so far:** https://x/pull/2');
  });
});
