import { describe, expect, it } from 'vitest';
import { describeScopeConflict, detectFileConflicts, fileScopesConflict } from './conflictDetector.js';
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

  it('admits directly disjoint endpoints from a transitive conflict chain', async () => {
    const result = await detectFileConflicts(
      [
        task('A', 1, ['src/a-b.ts']),
        task('B', 2, ['src/a-b.ts', 'src/b-c.ts']),
        task('C', 1, ['src/b-c.ts']),
      ],
      PROJECT,
    );

    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].tasks.map((t) => t.id)).toEqual(['A', 'C', 'B']);
    expect(result.safe.map((t) => t.id)).toEqual(['A', 'C']);
  });

  it('breaks equal-priority conflicts by stable input order', async () => {
    const result = await detectFileConflicts(
      [
        task('first', 2, ['src/shared.ts']),
        task('second', 2, ['src/shared.ts']),
        task('third', 2, ['src/shared.ts']),
      ],
      PROJECT,
    );

    expect(result.conflictGroups[0].tasks.map((t) => t.id)).toEqual(['first', 'second', 'third']);
    expect(result.safe.map((t) => t.id)).toEqual(['first']);
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

  it('lets unknown scopes run with disjoint known work under the default admit policy', async () => {
    const result = await detectFileConflicts(
      [
        task('unknown', 1, ['unknown-file-scope']),
        task('known-a', 2, ['src/a.ts']),
        task('known-b', 2, ['src/b.ts']),
      ],
      PROJECT,
    );

    expect(new Set(result.safe.map((t) => t.id))).toEqual(new Set(['unknown', 'known-a', 'known-b']));
    expect(result.conflictGroups).toHaveLength(0);
  });

  it('still serializes unknown scopes when the caller asks for the Codex-era hold', async () => {
    const result = await detectFileConflicts(
      [
        task('unknown', 1, ['unknown-file-scope']),
        task('known-a', 2, ['src/a.ts']),
        task('known-b', 2, ['src/b.ts']),
      ],
      PROJECT,
      { unknownScopeAdmission: 'serialize' },
    );

    expect(result.safe.map((t) => t.id)).toEqual(['known-a', 'known-b']);
    expect(result.conflictGroups).toHaveLength(1);
    expect(result.conflictGroups[0].sharedModules).toEqual(['unknown-file-scope']);
  });

  it('admits every unknown-scope task concurrently by default', async () => {
    const result = await detectFileConflicts(
      [task('first', 2), task('second', 1), task('third', 3)],
      PROJECT,
    );

    expect(new Set(result.safe.map((t) => t.id))).toEqual(new Set(['first', 'second', 'third']));
    expect(result.conflictGroups).toHaveLength(0);
  });

  it('can repay a deferred unknown as an exclusive wave under serialize', async () => {
    const result = await detectFileConflicts(
      [task('known', 1, ['src/known.ts']), task('unknown', 4)],
      PROJECT,
      {
        preferUnknownExclusive: true,
        preferredUnknownTaskId: 'unknown',
        unknownScopeAdmission: 'serialize',
      },
    );

    expect(result.safe.map((t) => t.id)).toEqual(['unknown']);
  });
});


// The pre-admission worktree gate compares one candidate against one live
// worker. It used to ignore `unknownScopeAdmission` entirely, so `admit` was
// honoured by the durable gate and silently dropped here — one running task
// deferred every other candidate and left 11 of 12 slots idle (AGT-4233).
describe('describeScopeConflict', () => {
  it('defers an unknown candidate scope under serialize', () => {
    expect(describeScopeConflict(undefined, ['src/a.ts'], 'serialize'))
      .toEqual({ kind: 'unknown-candidate' });
  });

  it('defers an unknown active scope under serialize', () => {
    expect(describeScopeConflict(['src/a.ts'], [], 'serialize'))
      .toEqual({ kind: 'unknown-active' });
  });

  it('admits an unknown scope on either side under admit', () => {
    expect(describeScopeConflict(undefined, ['src/a.ts'], 'admit')).toBeNull();
    expect(describeScopeConflict(['src/a.ts'], undefined, 'admit')).toBeNull();
    expect(describeScopeConflict(undefined, undefined, 'admit')).toBeNull();
  });

  it('still refuses two known scopes that overlap, even under admit', () => {
    expect(describeScopeConflict(['src/a.ts'], ['src/a.ts'], 'admit'))
      .toEqual({ kind: 'overlap', shared: ['src/a.ts'] });
  });

  it('names every candidate entry that collides, so a deferral can be read', () => {
    const reason = describeScopeConflict(
      ['src/a.ts', 'src/b.ts', 'docs/readme.md'],
      ['src/a.ts', 'src/b.ts'],
      'admit',
    );

    expect(reason).toEqual({ kind: 'overlap', shared: ['src/a.ts', 'src/b.ts'] });
  });

  it('treats a directory scope as covering its files', () => {
    expect(describeScopeConflict(['src/api/handler.ts'], ['src/api'], 'admit'))
      .toEqual({ kind: 'overlap', shared: ['src/api/handler.ts'] });
  });

  it('lets disjoint known scopes run together under either policy', () => {
    expect(describeScopeConflict(['src/a.ts'], ['src/b.ts'], 'serialize')).toBeNull();
    expect(describeScopeConflict(['src/a.ts'], ['src/b.ts'], 'admit')).toBeNull();
  });

  it('defaults to admit when no policy is passed', () => {
    expect(describeScopeConflict(undefined, ['src/a.ts'])).toBeNull();
  });
});

describe('fileScopesConflict (compatibility wrapper)', () => {
  it('keeps the historical fail-closed answer for unknown scopes', () => {
    expect(fileScopesConflict(undefined, ['src/a.ts'])).toBe(true);
    expect(fileScopesConflict(['src/a.ts'], [])).toBe(true);
  });

  it('reports overlap and disjointness as before', () => {
    expect(fileScopesConflict(['src/a.ts'], ['src/a.ts'])).toBe(true);
    expect(fileScopesConflict(['src/a.ts'], ['src/b.ts'])).toBe(false);
  });
});
