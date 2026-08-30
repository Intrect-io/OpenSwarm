import { describe, it, expect } from 'vitest';
import { effectiveProjectScope, isAllowedProjectPath, isUmbrellaIssue, selectTasksRoundRobin, type TaskItem } from './decisionEngine.js';

// INT-1810 R2: parent/EPIC issues are umbrellas, not executable work. INT-1702 (tracking,
// decomposed into sub-issues) and KT-300 ([EPIC] …) were wrongly picked for the worker.
function task(partial: Partial<TaskItem>): TaskItem {
  return { id: 'x', source: 'linear', title: 't', priority: 3, createdAt: 0, ...partial } as TaskItem;
}

describe('isUmbrellaIssue', () => {
  it('flags an issue that is the parent of another fetched issue', () => {
    const parent = task({ id: 'p', issueId: 'p-uuid', title: 'consolidate branches' });
    const child = task({ id: 'c', issueId: 'c-uuid', parentId: 'p-uuid', title: 'sub-task' });
    const parentIds = new Set([child.parentId!]);

    expect(isUmbrellaIssue(parent, parentIds)).toBe(true);  // p is a parent
    expect(isUmbrellaIssue(child, parentIds)).toBe(false);  // c is a leaf
  });

  it('flags EPIC-tagged titles regardless of parent links', () => {
    const noParents = new Set<string>();
    expect(isUmbrellaIssue(task({ title: '[EPIC] VEGA 채팅 하네스 이식' }), noParents)).toBe(true);
    expect(isUmbrellaIssue(task({ title: 'epic: unify backend' }), noParents)).toBe(true);
    expect(isUmbrellaIssue(task({ title: '[ Epic ] spaced + cased' }), noParents)).toBe(true);
  });

  it('does not flag normal executable issues', () => {
    const parentIds = new Set(['some-parent']);
    expect(isUmbrellaIssue(task({ issueId: 'leaf', title: 'fix(adapters): codex flag' }), parentIds)).toBe(false);
    // "epic" inside a word must not false-positive
    expect(isUmbrellaIssue(task({ issueId: 'l2', title: 'add epicenter map widget' }), parentIds)).toBe(false);
  });
});

describe('effectiveProjectScope', () => {
  it('returns undefined for the legacy no-restriction configuration', () => {
    // [] in config means "allow everything"; [] as a scope means "admit
    // nothing". The translation to undefined happens here, the one place that
    // knows which meaning applies. (AGT-4127)
    expect(effectiveProjectScope([], new Set(), false)).toBeUndefined();
  });

  it('passes the allow-list through when no selection filter applies', () => {
    expect(effectiveProjectScope(['/work/a'], new Set(['/ignored']), false)).toEqual(['/work/a']);
  });

  it('narrows the allow-list to the enabled selection', () => {
    expect(effectiveProjectScope(
      ['/work/cgf-portal', '/work/vega-agent'],
      new Set(['/work/cgf-portal']),
      true,
    )).toEqual(['/work/cgf-portal']);
  });

  it('returns an empty scope when every project is disabled', () => {
    // Distinct from undefined: a fully-disabled daemon dispatches nothing, and
    // its metrics must not report the ledger as busy.
    expect(effectiveProjectScope(['/work/cgf-portal'], new Set(), true)).toEqual([]);
  });

  it('keeps the narrower path when allowed and enabled overlap as prefixes', () => {
    // Keeping the wider /work would sweep sibling projects dispatch refuses
    // back into the counts.
    expect(effectiveProjectScope(['/work'], new Set(['/work/cgf-portal']), true))
      .toEqual(['/work/cgf-portal']);
    expect(effectiveProjectScope(['/work/cgf-portal'], new Set(['/work']), true))
      .toEqual(['/work/cgf-portal']);
  });

  it('uses the enabled selection alone when the allow-list is empty', () => {
    expect(effectiveProjectScope([], new Set(['/work/a']), true)).toEqual(['/work/a']);
  });

  it('matches case-insensitively where the runner admission does', () => {
    // macOS/Windows filesystems are case-insensitive, and the runner's
    // enabled-set admission folds case there. A casing difference between
    // UI-captured and configured paths must not drop a project from the counts
    // that dispatch admits. (gate round: case-sensitivity mismatch)
    expect(effectiveProjectScope(['/Work/CGF-Portal'], new Set(['/work/cgf-portal']), true, true))
      .toEqual(['/Work/CGF-Portal']);
    expect(effectiveProjectScope(['/Work/CGF-Portal'], new Set(['/work/cgf-portal']), true, false))
      .toEqual([]);
  });
});

describe('isAllowedProjectPath', () => {
  it('allows exact allowed projects and descendants', () => {
    expect(isAllowedProjectPath('/tmp/allowed-repo', ['/tmp/allowed-repo'])).toBe(true);
    expect(isAllowedProjectPath('/tmp/allowed-repo/worktree/task-1', ['/tmp/allowed-repo'])).toBe(true);
  });

  it('rejects sibling paths with the same prefix', () => {
    expect(isAllowedProjectPath('/tmp/allowed-repo-evil', ['/tmp/allowed-repo'])).toBe(false);
  });

  it('rejects broader parent paths when only a child repo is allowed', () => {
    expect(isAllowedProjectPath('/tmp', ['/tmp/allowed-repo'])).toBe(false);
  });
});

describe('selectTasksRoundRobin (INT-2318)', () => {
  const t = (id: string, project: string): TaskItem =>
    task({ id, linearProject: { id: project, name: project } as TaskItem['linearProject'] });
  const ok = () => true;
  const wf = async () => ({}) as Awaited<ReturnType<Parameters<typeof selectTasksRoundRobin>[4]>>;

  const sorted = [t('a1', 'A'), t('a2', 'A'), t('a3', 'A'), t('b1', 'B'), t('b2', 'B')];

  it('one task per project per cycle when sameProjectParallel is off', async () => {
    const { selected } = await selectTasksRoundRobin(sorted, 6, false, ok, wf);
    expect(selected.map((s) => s.task.id)).toEqual(['a1', 'b1']);
  });

  it('fills remaining slots round-robin across projects when on', async () => {
    const { selected } = await selectTasksRoundRobin(sorted, 6, true, ok, wf);
    // pass 1: a1, b1 · pass 2: a2, b2 · pass 3: a3 — no project monopolizes early slots
    expect(selected.map((s) => s.task.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('respects maxTasks', async () => {
    const { selected } = await selectTasksRoundRobin(sorted, 3, true, ok, wf);
    expect(selected.map((s) => s.task.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('counts rejected tasks as skipped and moves on within the same pass', async () => {
    const { selected, skippedCount } = await selectTasksRoundRobin(
      sorted, 6, true, (task) => task.id !== 'a1', wf,
    );
    expect(selected.map((s) => s.task.id)).toEqual(['a2', 'b1', 'a3', 'b2']);
    expect(skippedCount).toBe(1);
  });

  it('counts workflow-mapping failures as skipped and never retries them', async () => {
    let b1Calls = 0;
    const { selected, skippedCount } = await selectTasksRoundRobin(
      sorted, 6, true, ok,
      async (task) => {
        if (task.id === 'b1') { b1Calls++; return null; }
        return wf();
      },
    );
    expect(selected.map((s) => s.task.id)).toEqual(['a1', 'b2', 'a2', 'a3']);
    expect(skippedCount).toBe(1);
    expect(b1Calls).toBe(1);
  });

  it('falls back to projectPath then task id as the project key', async () => {
    const byPath = [
      task({ id: 'p1', projectPath: '/repo/x' }),
      task({ id: 'p2', projectPath: '/repo/x' }),
      task({ id: 'keyless' }),
    ];
    const { selected } = await selectTasksRoundRobin(byPath, 6, false, ok, wf);
    expect(selected.map((s) => s.task.id)).toEqual(['p1', 'keyless']);
  });
});
