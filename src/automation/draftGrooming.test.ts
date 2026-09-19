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
