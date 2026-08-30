import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';

const commitAndCreatePRWithHead = vi.hoisted(() => vi.fn());
vi.mock('../support/worktreeManager.js', () => ({ commitAndCreatePRWithHead }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));

import { publishApprovedWork, shouldPublishParkedWork } from './publishOnPark.js';

beforeEach(() => {
  commitAndCreatePRWithHead.mockReset();
});

describe('shouldPublishParkedWork (AGT-4076)', () => {
  it('publishes when a run parks for the operator with a worktree', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'waiting_on_operator' })).toBe(true);
  });

  it('does not publish an approved run — the normal path already does', () => {
    // Publishing here too would open a second PR for the same branch.
    expect(shouldPublishParkedWork(true, { finalStatus: 'approved' })).toBe(false);
  });

  it('does not publish a failed run', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'failed' })).toBe(false);
  });

  it('does not publish a superseded run — admission was refused, so nothing ran', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'superseded' })).toBe(false);
  });

  it('does not publish twice when a PR already exists', () => {
    expect(shouldPublishParkedWork(true, {
      finalStatus: 'waiting_on_operator', prUrl: 'https://github.com/o/r/pull/1',
    })).toBe(false);
  });

  it('does not publish without a worktree — there is nothing to publish from', () => {
    expect(shouldPublishParkedWork(false, { finalStatus: 'waiting_on_operator' })).toBe(false);
  });
});

describe('publication identity (AGT-4145)', () => {
  it('durably attaches the exact head returned by a successful reviewed publication', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({
      prUrl: 'https://github.com/o/r/pull/17',
      headSha: 'head-b',
    });
    const onPublication = vi.fn(async () => true);
    const durability = {
      beforePublish: vi.fn(async () => true),
      onPublication,
    } as unknown as ExecutionDurabilityHooks;
    const result: { success: boolean; finalStatus: string; prUrl?: string } = {
      success: true,
      finalStatus: 'approved',
    };

    await publishApprovedWork(
      { worktreePath: '/tmp/w', originalPath: '/tmp/r', branchName: 'swarm/AGT-4145', issueId: 'AGT-4145' },
      { id: 'task-1', issueIdentifier: 'AGT-4145', title: 'Preserve publication identity' },
      result,
      durability,
    );

    expect(result.prUrl).toBe('https://github.com/o/r/pull/17');
    expect(onPublication).toHaveBeenCalledWith('https://github.com/o/r/pull/17', 'head-b');
  });
});
