import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';

const commitAndCreatePRWithHead = vi.hoisted(() => vi.fn());
vi.mock('../support/worktreeManager.js', () => ({ commitAndCreatePRWithHead }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));

import { PublicationScopeMismatchError } from '../support/publicationScopeFence.js';
import { PUBLICATION_SCOPE_PARK_REASON, publishApprovedWork, publishStuckWork, shouldPublishParkedWork } from './publishOnPark.js';

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

  it('does not publish a worktree whose sandbox command outcome is unknown', () => {
    expect(shouldPublishParkedWork(true, {
      finalStatus: 'waiting_on_operator',
      workerResult: { executionOutcomeUnknown: true },
    })).toBe(false);
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

// vela 2026-09-02: AGT-3844 (48 attempts), AX-868 (23), AGT-4158 (15) — every
// one a publication-scope rejection of files an EARLIER attempt had already
// committed, turned into a 15-minute infra retry with a blank ledger message.
describe('afterPublication hook (per-repository fresh review)', () => {
  const info = { worktreePath: '/tmp/w', originalPath: '/tmp/r', branchName: 'swarm/AGT-1', issueId: 'AGT-1' };
  const publishable = { id: 'task-1', issueIdentifier: 'AGT-1', title: 'Hooked' };

  it('runs once, after the publication is durably recorded, with the PR identity', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'head-9' });
    const calls: string[] = [];
    const durability = {
      beforePublish: vi.fn(async () => true),
      onPublication: vi.fn(async () => { calls.push('recorded'); return true; }),
    } as unknown as ExecutionDurabilityHooks;
    const hook = vi.fn(async (p: { prUrl: string; headSha: string }) => { calls.push(`hook:${p.prUrl}:${p.headSha}`); });
    const result: { success: boolean; finalStatus: string; prUrl?: string } = { success: true, finalStatus: 'approved' };

    await publishApprovedWork(info, publishable, result, durability, hook);

    expect(calls).toEqual(['recorded', 'hook:https://github.com/o/r/pull/9:head-9']);
    expect(result).toMatchObject({ success: true, finalStatus: 'approved', prUrl: 'https://github.com/o/r/pull/9' });
  });

  it('keeps the publication a success when the review itself fails', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/10', headSha: 'head-10' });
    const result: { success: boolean; finalStatus: string; prUrl?: string } = { success: true, finalStatus: 'approved' };

    await publishApprovedWork(info, publishable, result, undefined, async () => { throw new Error('reviewer adapter down'); });

    expect(result).toMatchObject({ success: true, finalStatus: 'approved', prUrl: 'https://github.com/o/r/pull/10' });
  });
});

describe('publication failure classification', () => {
  const info = { worktreePath: '/tmp/w', originalPath: '/tmp/r', branchName: 'swarm/AGT-4158', issueId: 'AGT-4158' };
  const publishable = { id: 'task-1', issueIdentifier: 'AGT-4158', title: 'Artifact cohort producer', fileScope: ['src/vega_plugins/eval/'], fileScopeSource: 'drafted' as const };

  it('parks a publication-scope rejection for the operator instead of retrying it', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new PublicationScopeMismatchError(['benchmarks/artifact_cohort.py', 'uv.lock']));
    const result: { success: boolean; finalStatus: string; failureDetail?: string; operatorPark?: { code: string; reason: string } } = { success: true, finalStatus: 'approved' };

    await publishApprovedWork(info, publishable, result, undefined);

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(result.operatorPark).toEqual({
      code: PUBLICATION_SCOPE_PARK_REASON,
      reason: expect.stringContaining('benchmarks/artifact_cohort.py, uv.lock'),
    });
    expect(result.failureDetail).toMatch(/^publication: publication-scope: /);
  });

  it('keeps every other publication failure a retryable infra error, with the cause recorded', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new Error('gh: HTTP 502 Bad Gateway'));
    const result: { success: boolean; finalStatus: string; failureDetail?: string; operatorPark?: unknown } = { success: true, finalStatus: 'approved' };

    await publishApprovedWork(info, publishable, result, undefined);

    expect(result).toMatchObject({ success: false, finalStatus: 'infra_error', failureDetail: 'publication: gh: HTTP 502 Bad Gateway' });
    expect(result.operatorPark).toBeUndefined();
  });
});

describe('publishStuckWork — terminal parks publish instead of holding', () => {
  const ctx = { worktreePath: '/tmp/w', repoRoot: '/tmp/r', branchName: 'swarm/AGT-1' };
  const task = { id: 'task-1', issueId: 'issue-1', issueIdentifier: 'AGT-1', title: 'Do the thing' };

  it('opens a draft PR for a run that exhausted its retries', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'sha' });

    const prUrl = await publishStuckWork(ctx, task, 'autonomous execution failed 4 times');

    expect(prUrl).toBe('https://github.com/o/r/pull/9');
    const [info, title, identifier, body, options] = commitAndCreatePRWithHead.mock.calls[0];
    expect(info).toMatchObject({ worktreePath: '/tmp/w', originalPath: '/tmp/r', branchName: 'swarm/AGT-1' });
    expect(title).toBe('Do the thing');
    expect(identifier).toBe('AGT-1');
    // The park reason belongs in the PR body: it is why a human is being asked to look.
    expect(body).toContain('autonomous execution failed 4 times');
    // Never ready: nothing reviewed this, and CI must not run on known-incomplete work.
    expect(options).toMatchObject({ draft: true });
  });

  it('sweeps up uncommitted work, because this worktree is about to be deleted', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'sha' });

    await publishStuckWork(ctx, task, 'stuck');

    // committedOnly would publish only what the pre-cleanup WIP commit managed
    // to capture — and that commit swallows its own failures.
    expect(commitAndCreatePRWithHead.mock.calls[0][4]).not.toMatchObject({ committedOnly: true });
  });

  it('reports no URL, and does not throw, when the run produced no commits', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new Error('No commits to create PR from - branch has no changes'));

    await expect(publishStuckWork(ctx, task, 'reviewer rejected 3 attempts')).resolves.toBeUndefined();
  });

  it('swallows a publication failure — cleanup and the park must proceed regardless', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new Error('gh: could not reach github.com'));

    await expect(publishStuckWork(ctx, task, 'stuck')).resolves.toBeUndefined();
  });

  it('drops an inferred file scope, which is advisory and would block publication', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'sha' });

    await publishStuckWork(ctx, { ...task, fileScope: ['src/a.ts'], fileScopeSource: 'inferred' }, 'stuck');

    expect(commitAndCreatePRWithHead.mock.calls[0][4]).toMatchObject({ fileScope: undefined });
  });

  it('enforces a declared file scope', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'sha' });

    await publishStuckWork(ctx, { ...task, fileScope: ['src/a.ts'], fileScopeSource: 'declared' }, 'stuck');

    expect(commitAndCreatePRWithHead.mock.calls[0][4]).toMatchObject({ fileScope: ['src/a.ts'] });
  });
});
