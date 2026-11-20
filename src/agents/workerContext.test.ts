import { describe, expect, it, vi } from 'vitest';

// Only the write-boundary decision is under test here; every other context
// source is stubbed to an empty result so it cannot mask the assertion.
vi.mock('../knowledge/index.js', () => ({ analyzeIssue: vi.fn(async () => null) }));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn(async () => []) }));
vi.mock('../registry/sqliteStore.js', () => ({ getRegistryStore: vi.fn(() => null) }));
vi.mock('./siblingWork.js', () => ({ collectSiblingWork: vi.fn(async () => []) }));

import { collectWorkerContext } from './workerContext.js';
import { enPrompts, promptDataBlock } from '../locale/prompts/en.js';
import { koPrompts } from '../locale/prompts/ko.js';
import { buildReviewerPrompt } from './reviewer.js';
import { clearWorktreeGitignoredGaps, formatWorktreeGapSection, recordWorktreeGitignoredGaps, worktreeGitignoredGaps } from '../support/worktreeMissingPaths.js';

function contextWith(fileScope: string[], fileScopeSource?: string): never {
  return { task: { fileScope, fileScopeSource }, projectPath: '/tmp/does-not-exist' } as never;
}

describe('collectWorkerContext write boundary', () => {
  it('announces a declared scope, which the post-run guard also enforces', async () => {
    const wc = await collectWorkerContext(contextWith(['src/router.ts'], 'declared'), undefined);
    expect(wc?.fileScope).toEqual(['src/router.ts']);
  });

  it('stays silent about an inferred scope, which no consumer enforces', async () => {
    // pairPipeline.ts and publishOnPark.ts both pass `undefined` for an
    // inferred scope. Rendering it as "binding" would make the worker refuse
    // edits that would in fact have passed the gate.
    const wc = await collectWorkerContext(contextWith(['src/router.ts'], 'inferred'), undefined);
    expect(wc?.fileScope).toBeUndefined();
  });

  it('copies the scope rather than aliasing the task', async () => {
    const scope = ['src/router.ts'];
    const wc = await collectWorkerContext(contextWith(scope, 'declared'), undefined);
    wc?.fileScope?.push('src/injected.ts');
    expect(scope).toEqual(['src/router.ts']);
  });
});

describe('daemon worker and reviewer see gitignored paths the worktree cannot (AGT-4041, #855 review)', () => {
  const worktree = '/tmp/osw-gap-worktree/AGT-1';
  const gaps = { missing: ['docs/CGF_data'], unreadable: ['private-data'] };

  it('renders missing and unreadable lists separately in the en and ko worker prompts', async () => {
    recordWorktreeGitignoredGaps(`${worktree}/`, gaps, ['node_modules', 'private-data']);
    try {
      const wc = await collectWorkerContext({ task: {}, projectPath: worktree } as never, undefined);
      expect(wc?.repository).toMatchObject({ missingGitignoredPaths: ['docs/CGF_data'], unreadableGitignoredPaths: ['private-data'], dependencyGraphAvailable: false });
      const en = enPrompts.buildWorkerPrompt({ taskTitle: 't', taskDescription: 'd', context: wc });
      expect(en).toMatch(/Gitignored source paths NOT present in this worktree[^\n]*\n[^]*docs\/CGF_data/);
      expect(en).toMatch(/unreadable by the sandbox user[^\n]*\n[^]*private-data/);
      const ko = koPrompts.buildWorkerPrompt({ taskTitle: 't', taskDescription: 'd', context: wc });
      expect(ko).toContain('이 워크트리에 없는 원본 gitignored 경로');
      expect(ko).toContain('샌드박스 사용자가 읽을 수 없는');
    } finally { clearWorktreeGitignoredGaps(worktree); }
  });

  it('adds nothing for a path with no recorded gaps (a non-worktree run)', async () => {
    recordWorktreeGitignoredGaps(worktree, { missing: [], unreadable: [] });
    expect(worktreeGitignoredGaps(worktree)).toBeUndefined();
    const wc = await collectWorkerContext({ task: {}, projectPath: worktree } as never, undefined);
    expect(wc?.repository).toBeUndefined();
    clearWorktreeGitignoredGaps();
  });

  it('appends the section to the reviewer prompt in blocker mode, where absence claims are judged', () => {
    const section = formatWorktreeGapSection(gaps, 'en', promptDataBlock);
    const prompt = buildReviewerPrompt({
      taskTitle: 't', taskDescription: 'd', projectPath: worktree, mode: 'blocker', blockerClaim: 'the data does not exist',
      workerResult: { success: false, summary: 's', filesChanged: [], commands: [], output: '' } as never,
      worktreeGapSection: section,
    });
    expect(prompt).toContain('Gitignored source paths this worktree cannot see');
    expect(prompt).toMatch(/Not present in this worktree[^]*docs\/CGF_data[^]*Shared but unreadable[^]*private-data/);
    expect(formatWorktreeGapSection(gaps, 'ko', promptDataBlock)).toContain('워크트리에 없음');
    expect(formatWorktreeGapSection({ missing: [], unreadable: [] }, 'en', promptDataBlock)).toBe('');
  });
});
