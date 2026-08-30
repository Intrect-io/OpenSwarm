import { describe, expect, it } from 'vitest';
import { detectFileConflicts } from './conflictDetector.js';
import type { TaskItem } from './decisionEngine.js';

// These tests exercise the planner-declared `fileScope` path. When every task
// carries an explicit scope, detection never touches the Knowledge Graph, so
// results are fully deterministic without any project graph on disk.

function task(id: string, priority: number, fileScope?: string[]): TaskItem {
  return {
    id,
    source: 'linear',
    title: `task ${id}`,
    priority,
    createdAt: 0,
    issueId: id,
    fileScope,
  };
}

const PROJECT = '/tmp/does-not-need-a-graph';

describe('detectFileConflicts (planner-declared file scope)', () => {
  it('returns a single task as safe without inspection', async () => {
    const result = await detectFileConflicts([task('A', 2, ['src/a.ts'])], PROJECT);
    expect(result.safe.map((t) => t.id)).toEqual(['A']);
    expect(result.conflictGroups).toHaveLength(0);
  });

  it('keeps tasks with disjoint scopes concurrent', async () => {
    const result = await detectFileConflicts(
      [task('A', 2, ['src/a.ts']), task('B', 2, ['src/b.ts'])],
      PROJECT,
    );
    expect(new Set(result.safe.map((t) => t.id))).toEqual(new Set(['A', 'B']));
    expect(result.conflictGroups).toHaveLength(0);
  });

  it('defers the lower-priority task when scopes overlap', async () => {
    const result = await detectFileConflicts(
      [
        task('A', 3, ['src/shared.ts', 'src/a.ts']),
        task('B', 1, ['src/shared.ts', 'src/b.ts']), // higher priority (1 < 3)
      ],
      PROJECT,
    );

    // Only the higher-priority task is safe to run now.
    expect(result.safe.map((t) => t.id)).toEqual(['B']);
    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].tasks.map((t) => t.id).sort()).toEqual(['A', 'B']);
    expect(result.conflictGroups[0].sharedModules).toContain('src/shared.ts');
  });

  it('normalizes scope entries so ./Path and path collide', async () => {
    const result = await detectFileConflicts(
      [task('A', 2, ['./src/Shared.ts']), task('B', 2, ['src/shared.ts'])],
      PROJECT,
    );
    expect(result.conflictGroups).toHaveLength(1);
    expect(result.safe).toHaveLength(1);
  });

  it('isolates a conflict so an unrelated task still runs', async () => {
    const result = await detectFileConflicts(
      [
        task('A', 2, ['src/shared.ts']),
        task('B', 2, ['src/shared.ts']),
        task('C', 2, ['src/independent.ts']),
      ],
      PROJECT,
    );

    const safeIds = new Set(result.safe.map((t) => t.id));
    // C is disjoint → always safe.
    expect(safeIds.has('C')).toBe(true);
    // Exactly one of A/B runs now; the other is deferred.
    expect([safeIds.has('A'), safeIds.has('B')].filter(Boolean)).toHaveLength(1);
    expect(result.safe).toHaveLength(2);
  });

  it('runs non-adjacent tasks from a transitive conflict chain concurrently', async () => {
    const result = await detectFileConflicts(
      [
        task('A', 2, ['src/ab.ts']),
        task('B', 2, ['src/ab.ts', 'src/bc.ts']),
        task('C', 2, ['src/bc.ts']),
      ],
      PROJECT,
    );

    expect(result.safe.map((candidate) => candidate.id)).toEqual(['A', 'C']);
    expect(result.conflictGroups).toHaveLength(1);
  });

  it('ignores stale generated/worktree scope entries instead of creating false conflicts', async () => {
    const result = await detectFileConflicts(
      [
        task('A', 2, ['trash/worktree_123/src/shared.ts', 'worktree/old/src/shared.ts', 'src/a.ts']),
        task('B', 2, ['src/shared.ts']),
      ],
      PROJECT,
    );

    expect(new Set(result.safe.map((t) => t.id))).toEqual(new Set(['A', 'B']));
    expect(result.conflictGroups).toHaveLength(0);
  });

  it('serializes unknown scope because merge safety cannot be proven', async () => {
    const result = await detectFileConflicts(
      [task('A', 2, ['unknown-file-scope']), task('B', 2, ['src/shared.ts'])],
      PROJECT,
    );

    expect(result.safe).toHaveLength(1);
    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].sharedModules).toEqual(['unknown-file-scope']);
  });
});
