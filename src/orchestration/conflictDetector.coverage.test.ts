// Coverage gap-filling tests for conflictDetector.ts.
//
// conflictDetector.test.ts only exercises the planner-declared `fileScope`
// path with at most 3 tasks, which never forces the internal UnionFind's
// rank-based tie-break comparisons (union() has three branches: rankX<rankY,
// rankX>rankY, and the equal-rank tie — only the tie was previously hit).
// It also never exercises the Knowledge-Graph fallback path taken when a
// task has no declared fileScope (analyzeIssue's success/empty/throw
// outcomes), since every fixture there declares an explicit fileScope.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectFileConflicts } from './conflictDetector.js';
import type { TaskItem } from './decisionEngine.js';
import type { ImpactAnalysis } from '../knowledge/types.js';

// vi.mock's factory is hoisted above all imports/top-level statements, so the
// mock function itself must be created inside vi.hoisted() to exist by then.
const { mockAnalyzeIssue } = vi.hoisted(() => ({ mockAnalyzeIssue: vi.fn() }));
vi.mock('../knowledge/index.js', () => ({
  analyzeIssue: mockAnalyzeIssue,
}));

const PROJECT = '/tmp/does-not-need-a-graph';

function task(id: string, priority: number, fileScope?: string[]): TaskItem {
  return {
    id,
    source: 'linear',
    title: `task ${id}`,
    priority,
    createdAt: 0,
    issueId: id,
    fileScope,
  } as TaskItem;
}

function impact(directModules: string[], dependentModules: string[] = []): ImpactAnalysis {
  return { directModules, dependentModules, testFiles: [], estimatedScope: 'small' };
}

describe('detectFileConflicts UnionFind rank tie-break branches', () => {
  it('keeps one diagnostic cohort while admitting both directly disjoint winners from an asymmetric overlap chain', async () => {
    // Overlap graph (by shared file), in the order the i<j pair loop visits them:
    //   0-2 share 'shared-02.ts'   fresh(0) vs fresh(2)              -> equal-rank tie, root=0, rank[0]=1
    //   0-3 share 'shared-03.ts'   root(0,rank1) vs fresh(3,rank0)   -> rankX>rankY branch
    //   1-2 share 'shared-12.ts'   fresh(1,rank0) vs root(0 via 2)   -> rankX<rankY branch
    //   1-3 share 'shared-13.ts'   both already root 0 by this point -> `rx === ry` early-return branch
    // 0-1 and 2-3 share nothing, so no direct conflict is recorded for those
    // pairs even though all four end up transitively unioned into one group.
    const result = await detectFileConflicts(
      [
        task('A', 3, ['shared-02.ts', 'shared-03.ts']),
        task('B', 3, ['shared-12.ts', 'shared-13.ts']),
        task('C', 1, ['shared-02.ts', 'shared-12.ts']), // highest priority and directly disjoint from D
        task('D', 3, ['shared-03.ts', 'shared-13.ts']),
      ],
      PROJECT,
    );

    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].tasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(result.conflictGroups[0].sharedModules)).toEqual(
      new Set(['shared-02.ts', 'shared-03.ts', 'shared-12.ts', 'shared-13.ts']),
    );
    expect(result.safe.map((t) => t.id)).toEqual(['C', 'D']);
  });
});

describe('detectFileConflicts normalizeScope entry sanitization', () => {
  it('drops non-string and blank-after-trim fileScope entries instead of treating them as real scope', async () => {
    const result = await detectFileConflicts(
      [
        // Malformed planner output: a non-string element (normalizeScope's
        // `typeof raw !== 'string'` guard) and whitespace-only/`./`-only
        // entries that normalize to '' (caught by isVolatileScopePath's
        // `!path` check before ever reaching the `if (normalized)` guard) —
        // all must be dropped silently rather than counted as (or colliding
        // as) a shared module.
        task('A', 2, ['src/a.ts', 123 as unknown as string, '   ']),
        task('B', 2, ['src/b.ts', '  ', './']),
      ],
      PROJECT,
    );

    // The only real entries ('src/a.ts' vs 'src/b.ts') are disjoint -> no conflict.
    expect(result.conflictGroups).toHaveLength(0);
    expect(new Set(result.safe.map((t) => t.id))).toEqual(new Set(['A', 'B']));
  });
});

describe('detectFileConflicts Knowledge Graph fallback (no declared fileScope)', () => {
  beforeEach(() => {
    mockAnalyzeIssue.mockReset();
  });

  it('detects a conflict from overlapping KG-inferred modules', async () => {
    mockAnalyzeIssue.mockImplementation(async (_projectPath: string, title: string) => {
      if (title === 'task A') return impact(['src/shared.ts', 'src/a-only.ts']);
      if (title === 'task B') return impact(['src/shared.ts']);
      return null;
    });

    const result = await detectFileConflicts(
      [task('A', 3), task('B', 1)], // no fileScope declared -> falls back to analyzeIssue
      PROJECT,
    );

    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].sharedModules).toEqual(['src/shared.ts']);
    expect(result.safe.map((t) => t.id)).toEqual(['B']); // higher priority (1 < 3) wins
    expect(mockAnalyzeIssue).toHaveBeenCalledWith(PROJECT, 'task A', undefined);
    expect(mockAnalyzeIssue).toHaveBeenCalledWith(PROJECT, 'task B', undefined);
  });

  it('serializes KG scopes that reduce to unknown after volatile paths are removed', async () => {
    // Both tasks resolve to a non-null impact, but every module normalizes
    // away (node_modules / dist are filtered as volatile), so `modules.size`
    // is 0 and the code falls through to unknownScopeIndices instead of
    // recording a real scope.
    mockAnalyzeIssue.mockResolvedValue(impact(['node_modules/pkg/index.js'], ['dist/bundle.js']));

    const result = await detectFileConflicts(
      [task('A', 2), task('B', 2)],
      PROJECT,
    );

    expect(result.conflictGroups).toHaveLength(1);
    expect(result.safe).toHaveLength(1);
  });

  it('treats a failed KG lookup as unknown scope and logs a warning instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockAnalyzeIssue.mockImplementation(async (_projectPath: string, title: string) => {
        if (title === 'task A') throw new Error('graph read failed');
        return impact(['src/b.ts']);
      });

      const result = await detectFileConflicts(
        [task('A', 2), task('B', 2)],
        PROJECT,
      );

      // Task A's failure makes its scope unknown, so admission fails closed
      // against B until a later heartbeat can prove the write sets disjoint.
      expect(result.conflictGroups).toHaveLength(1);
      expect(result.safe).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ConflictDetector] Impact analysis failed for A:'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
