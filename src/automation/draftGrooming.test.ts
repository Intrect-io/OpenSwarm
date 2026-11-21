import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';

const { findOpenPRFileOverlaps } = vi.hoisted(() => ({ findOpenPRFileOverlaps: vi.fn() }));
vi.mock('../support/worktreeManager.js', () => ({ findOpenPRFileOverlaps }));

import { DRAFT_DUPLICATE_CAP_PER_HOUR, applyDraftGates, resetDraftDuplicateBudget } from './draftGrooming.js';

describe('draft grooming open-PR overlaps (AGT-4423)', () => {
  it('records a reason and one stable Linear comment fingerprint for the overlapping owner/files', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([
      { url: 'https://github.test/42', files: ['src/z.ts', 'src/a.ts'] },
    ]);
    const addComment = vi.fn(async () => undefined);
    const task: TaskItem = {
      id: 'issue-1', issueId: 'issue-1', issueIdentifier: 'AGT-4423', source: 'linear',
      title: 'Avoid overlap', priority: 2, createdAt: 1,
    };
    const options = {
      task, projectPath: '/repo', worktreeMode: true,
      draft: { relevantFiles: ['src/a.ts'], durationMs: 7 },
      source: { kind: 'linear', addComment } as unknown as ITaskSource,
    };

    const first = await applyDraftGates(options);
    const second = await applyDraftGates(options);

    expect(first).toMatchObject({
      success: true, finalStatus: 'superseded',
      failureDetail: 'Existing open PR owns planned files — skipping duplicate worker: https://github.test/42: `src/a.ts`, `src/z.ts`',
    });
    expect(second?.failureDetail).toBe(first?.failureDetail);
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(addComment.mock.calls[0]).toEqual(addComment.mock.calls[1]);
    expect(addComment).toHaveBeenCalledWith(
      'issue-1', expect.stringContaining('https://github.test/42'), expect.stringMatching(/^draft-overlap:[a-f0-9]{24}$/),
    );
  });
});

describe('draft grooming goal scope gate (AGT-4662)', () => {
  const task: TaskItem = {
    id: 'issue-2', issueId: 'issue-2', issueIdentifier: 'AX-1719', source: 'linear',
    title: 'Fix kyte interpreter paths', priority: 2, createdAt: 1,
  };
  const decline = {
    applicable: false as const, kind: 'wrong_repository' as const, confidence: 0.95,
    reason: 'The runtime this task names lives in kyte-portal.',
    evidence: ['no bin/kyte-chat-daemon here', 'no KYTE_PYTHON reference here'],
  };
  const gateOptions = (scope: unknown, extra: Record<string, unknown> = {}) => {
    const addComment = vi.fn(async () => undefined);
    return {
      addComment,
      options: {
        task, projectPath: '/repo', worktreeMode: true, goalScopeGate: true,
        draft: { relevantFiles: [], durationMs: 5, scope },
        source: { kind: 'linear', addComment } as unknown as ITaskSource,
        ...extra,
      },
    };
  };

  it('stops a confidently declined task before any worktree work, and says why on the issue', async () => {
    findOpenPRFileOverlaps.mockClear();
    const { options, addComment } = gateOptions(decline);
    const result = await applyDraftGates(options);
    expect(result).toMatchObject({
      success: true, finalStatus: 'superseded',
      failureDetail: 'wrong_repository: The runtime this task names lives in kyte-portal.',
    });
    expect(String(result?.sessionId)).toMatch(/^out_of_scope-/);
    expect(addComment).toHaveBeenCalledTimes(1);
    const [issueId, body, marker] = addComment.mock.calls[0] as unknown as [string, string, string];
    expect(issueId).toBe('issue-2');
    expect(body).toContain('`wrong_repository`');
    expect(body).toContain('- no bin/kyte-chat-daemon here');
    expect(body).toContain('- no KYTE_PYTHON reference here');
    expect(marker).toMatch(/^draft-scope:[a-f0-9]{24}$/);
    // It decided before the PR-overlap check ever ran.
    expect(findOpenPRFileOverlaps).not.toHaveBeenCalled();
  });

  it('uses a stable marker, so a task re-drafted every heartbeat leaves one comment', async () => {
    const first = gateOptions(decline);
    const second = gateOptions(decline);
    await applyDraftGates(first.options);
    await applyDraftGates(second.options);
    expect(first.addComment.mock.calls[0][2]).toBe(second.addComment.mock.calls[0][2]);
  });

  it('lets the task through when the project has no goal, whatever the draft said', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([]);
    const { options, addComment } = gateOptions(decline, { goalScopeGate: false });
    expect(await applyDraftGates(options)).toBeNull();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('lets the task through on a decline that is too weak or has too little evidence', async () => {
    findOpenPRFileOverlaps.mockResolvedValue([]);
    for (const scope of [
      { ...decline, confidence: 0.8 },
      { ...decline, evidence: ['only one'] },
      undefined,
    ]) {
      const { options, addComment } = gateOptions(scope);
      expect(await applyDraftGates(options)).toBeNull();
      expect(addComment).not.toHaveBeenCalled();
    }
  });

  it('does not comment on a non-Linear source but still stops the task', async () => {
    const { options, addComment } = gateOptions(decline, { source: { kind: 'local', addComment: vi.fn() } as unknown as ITaskSource });
    const result = await applyDraftGates(options);
    expect(result?.finalStatus).toBe('superseded');
    expect(addComment).not.toHaveBeenCalled();
  });
});

describe('draft grooming safe duplicate path (AGT-4603)', () => {
  const older: TaskItem = {
    id: 'issue-old', issueId: 'issue-old', issueIdentifier: 'AGT-1', source: 'linear',
    title: 'Original', priority: 2, createdAt: 1,
  };
  const makeTask = (n = 9): TaskItem => ({
    id: `issue-${n}`, issueId: `issue-${n}`, issueIdentifier: `AGT-${n}`, source: 'linear',
    title: 'Same thing again', priority: 2, createdAt: 2,
  });
  const setup = (extra: Record<string, unknown> = {}, task = makeTask()) => {
    const addComment = vi.fn(async (..._args: unknown[]) => undefined);
    const markDuplicate = vi.fn(async () => true);
    const openPrLookup = vi.fn(async () => [] as string[]);
    return {
      addComment, markDuplicate, openPrLookup,
      options: {
        task, projectPath: '/repo', peers: [task, older], openPrLookup,
        draft: {
          relevantFiles: [], durationMs: 3, duplicateOfIssueId: 'issue-old', duplicateConfidence: 0.95,
          duplicateReason: 'Same endpoint.', duplicateEvidence: ['same endpoint', 'same criterion'],
        },
        source: { kind: 'linear', addComment, markDuplicate } as unknown as ITaskSource,
        ...extra,
      },
    };
  };

  beforeEach(() => resetDraftDuplicateBudget());
  afterEach(() => vi.useRealTimers());

  it('posts the duplicate evidence comment before marking the duplicate', async () => {
    const { options, addComment, markDuplicate } = setup();
    const result = await applyDraftGates(options);
    expect(String(result?.sessionId)).toMatch(/^duplicate-/);
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(markDuplicate).toHaveBeenCalledWith('issue-9', 'issue-old');
    expect(addComment.mock.invocationCallOrder[0]).toBeLessThan(markDuplicate.mock.invocationCallOrder[0]);
    const [issueId, body, marker] = addComment.mock.calls[0] as [string, string, string];
    expect(issueId).toBe('issue-9');
    expect(body).toContain('is marking this issue as a duplicate of AGT-1');
    expect(body).not.toContain('was marked');
    expect(body).toContain('- same criterion');
    expect(marker).toMatch(/^draft-duplicate:[a-f0-9]{24}$/);
  });

  it('does not mark when the evidence comment fails, so the worker runs', async () => {
    const { options, addComment, markDuplicate } = setup();
    addComment.mockRejectedValueOnce(new Error('comment API down'));
    expect(await applyDraftGates(options)).toBeNull();
    expect(markDuplicate).not.toHaveBeenCalled();
  });

  it('does not mark a duplicate that has an open linked pull request', async () => {
    const { options, addComment, markDuplicate, openPrLookup } = setup();
    openPrLookup.mockResolvedValueOnce(['https://github.test/pull/5']);
    expect(await applyDraftGates(options)).toBeNull();
    expect(openPrLookup).toHaveBeenCalledWith({ issueId: 'issue-9', identifier: 'AGT-9' });
    expect(markDuplicate).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('does not mark when the linked-PR lookup throws or the default lookup has no identifier', async () => {
    const { options, addComment, markDuplicate, openPrLookup } = setup();
    openPrLookup.mockRejectedValueOnce(new Error('gh: HTTP 502'));
    expect(await applyDraftGates(options)).toBeNull();
    expect(markDuplicate).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();

    // Default gh lookup without an identifier throws before it runs gh.
    const bare = setup({ openPrLookup: undefined }, { ...makeTask(), issueIdentifier: undefined });
    expect(await applyDraftGates(bare.options)).toBeNull();
    expect(bare.markDuplicate).not.toHaveBeenCalled();
    expect(bare.addComment).not.toHaveBeenCalled();
  });

  it('caps duplicate marks per rolling hour', async () => {
    vi.useFakeTimers();
    expect(DRAFT_DUPLICATE_CAP_PER_HOUR).toBe(5);
    for (let n = 1; n <= DRAFT_DUPLICATE_CAP_PER_HOUR; n++) {
      const { options, markDuplicate } = setup({}, makeTask(10 + n));
      expect(await applyDraftGates(options)).not.toBeNull();
      expect(markDuplicate).toHaveBeenCalledTimes(1);
    }
    const sixth = setup({}, makeTask(20));
    expect(await applyDraftGates(sixth.options)).toBeNull();
    expect(sixth.markDuplicate).not.toHaveBeenCalled();
    expect(sixth.addComment).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    const later = setup({}, makeTask(21));
    expect(await applyDraftGates(later.options)).not.toBeNull();
    expect(later.markDuplicate).toHaveBeenCalledTimes(1);

    for (let n = 0; n < DRAFT_DUPLICATE_CAP_PER_HOUR; n++) await applyDraftGates(setup({}, makeTask(30 + n)).options);
    resetDraftDuplicateBudget();
    const afterReset = setup({}, makeTask(40));
    expect(await applyDraftGates(afterReset.options)).not.toBeNull();
  });

  it('does not spend a cap slot on a refused mark', async () => {
    for (let n = 0; n < DRAFT_DUPLICATE_CAP_PER_HOUR + 2; n++) {
      const { options, openPrLookup } = setup({}, makeTask(50 + n));
      openPrLookup.mockResolvedValueOnce(['https://github.test/pull/1']);
      await applyDraftGates(options);
    }
    const { options, markDuplicate } = setup({}, makeTask(60));
    expect(await applyDraftGates(options)).not.toBeNull();
    expect(markDuplicate).toHaveBeenCalledTimes(1);
  });

  it('gives the cap slot back when the evidence comment fails', async () => {
    for (let n = 0; n < DRAFT_DUPLICATE_CAP_PER_HOUR + 1; n++) {
      const { options, addComment, markDuplicate } = setup({}, makeTask(70 + n));
      addComment.mockRejectedValueOnce(new Error('comment API down'));
      expect(await applyDraftGates(options)).toBeNull();
      expect(markDuplicate).not.toHaveBeenCalled();
    }
    const { options, markDuplicate } = setup({}, makeTask(80));
    expect(await applyDraftGates(options)).not.toBeNull();
    expect(markDuplicate).toHaveBeenCalledTimes(1);
  });
});
