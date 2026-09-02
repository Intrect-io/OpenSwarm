import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';

const commitAndCreatePRWithHead = vi.hoisted(() => vi.fn());
vi.mock('../support/worktreeManager.js', () => ({ commitAndCreatePRWithHead }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));

import { PublicationScopeMismatchError } from '../support/publicationScopeFence.js';
import { PUBLICATION_SCOPE_PARK_REASON, WORKER_NO_CHANGES_PARK_REASON, publishApprovedWork, publishParkedIfNeeded, publishParkedWork, publishStuckWork, shouldPublishParkedWork } from './publishOnPark.js';

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

describe('parked-work draft publication', () => {
  const info = { worktreePath: '/tmp/w', originalPath: '/tmp/r', branchName: 'swarm/AGT-3844-ci-1', issueId: 'AGT-3844' };
  const publishable = { id: 'task-1', issueIdentifier: 'AGT-3844', title: 'CI suite reserve', fileScope: ['tests/'], fileScopeSource: 'drafted' as const };

  // The draft exists so the operator can see the branch. Enforcing the write
  // scope here only hides it: AGT-3844 parked on that fence (2026-09-02)
  // holding 42 commits whose net diff is four files, and published nothing.
  it('publishes the branch without the write-scope fence', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/21', headSha: 'abc' });

    await publishParkedWork(info, publishable, undefined);

    expect(commitAndCreatePRWithHead).toHaveBeenCalledWith(
      info, publishable.title, 'AGT-3844', expect.any(String),
      { draft: true, committedOnly: true },
    );
  });

  it('publishes a park once, whichever side of the approved publish it happened on', async () => {
    commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/22', headSha: 'abc' });
    const parked = { finalStatus: 'failed', operatorPark: { code: 'publication_scope_mismatch', reason: 'r' } };

    expect(await publishParkedIfNeeded(info, publishable, parked, undefined)).toBe(true);
    expect(await publishParkedIfNeeded(info, publishable, { finalStatus: 'failed' }, undefined)).toBe(false);
    expect(await publishParkedIfNeeded(null, publishable, parked, undefined)).toBe(false);
    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
  });

  it('treats an operator park as a run that stopped for a person', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'failed', operatorPark: { code: 'worker_no_changes', reason: 'r' } })).toBe(true);
    expect(shouldPublishParkedWork(true, { finalStatus: 'waiting_on_operator' })).toBe(true);
    expect(shouldPublishParkedWork(true, { finalStatus: 'failed' })).toBe(false);
    // A published run and a quarantined sandbox outcome still never publish.
    expect(shouldPublishParkedWork(true, { finalStatus: 'waiting_on_operator', prUrl: 'https://x/1' })).toBe(false);
    expect(shouldPublishParkedWork(true, { finalStatus: 'waiting_on_operator', workerResult: { executionOutcomeUnknown: true } })).toBe(false);
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

  it('counts a branch with nothing to publish as the attempt failing, not the infrastructure', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new Error('No commits to create PR from - branch has no changes compared to main'));
    const result: { success: boolean; finalStatus: string; failureDetail?: string; operatorPark?: unknown } = { success: true, finalStatus: 'approved' };

    await publishApprovedWork(info, publishable, result, undefined);

    expect(result).toMatchObject({ success: false, finalStatus: 'failed', failureDetail: expect.stringContaining('No commits to create PR from') });
    expect(result.operatorPark).toBeUndefined();
  });

  // cgf-portal AX-874, 2026-09-02: four consecutive attempts ended "No commits"
  // and were counted as failures; the worker's own noChangesReason never
  // reached the ledger, the Linear comment, or the operator.
  it('parks a worker that finished with an explicit noChangesReason and nothing to publish', async () => {
    commitAndCreatePRWithHead.mockRejectedValue(new Error('No commits to create PR from - branch has no changes compared to main'));
    const result: { success: boolean; finalStatus: string; failureDetail?: string; operatorPark?: { code: string; reason: string }; workerResult?: { noChangesReason?: string } } = {
      success: true,
      finalStatus: 'approved',
      workerResult: { noChangesReason: 'settlement tags are already split in ledger.py' },
    };

    await publishApprovedWork(info, publishable, result, undefined);

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(result.operatorPark).toEqual({
      code: WORKER_NO_CHANGES_PARK_REASON,
      reason: 'Worker finished without edits: settlement tags are already split in ledger.py',
    });
    expect(result.failureDetail).toBe('publication: No commits to create PR from - branch has no changes compared to main — worker: settlement tags are already split in ledger.py');
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

  // This used to enforce a declared scope and drop an inferred one. Both now
  // publish: the worktree is deleted moments after this call, so a fenced
  // refusal does not protect the operator's instruction — it destroys the work
  // that would have shown them it was broken. A draft PR merges nothing.
  it('publishes the branch as a draft without a write-scope fence, whatever the scope source', async () => {
    for (const fileScopeSource of ['declared', 'drafted', 'inferred'] as const) {
      commitAndCreatePRWithHead.mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/9', headSha: 'sha' });

      await publishStuckWork(ctx, { ...task, fileScope: ['src/a.ts'], fileScopeSource }, 'stuck');

      expect(commitAndCreatePRWithHead.mock.calls.at(-1)?.[4]).toEqual({ draft: true });
    }
  });
});
