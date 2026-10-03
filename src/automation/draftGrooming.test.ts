import { describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';

const { findOpenPRFileOverlaps } = vi.hoisted(() => ({ findOpenPRFileOverlaps: vi.fn() }));
vi.mock('../support/worktreeManager.js', () => ({ findOpenPRFileOverlaps }));

import { applyDraftGates } from './draftGrooming.js';

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
