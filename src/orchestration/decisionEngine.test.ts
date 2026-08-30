import { describe, it, expect } from 'vitest';
import { composeDispatchScope, isAllowedProjectPath, pathIsUnderAny, isUmbrellaIssue, selectTasksRoundRobin, type TaskItem } from './decisionEngine.js';

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

describe('pathIsUnderAny', () => {
  const projectRoot = '/work/a';

  it('admits a root itself and anything under it', () => {
    expect(pathIsUnderAny(projectRoot, [projectRoot])).toBe(true);
    expect(pathIsUnderAny('/work/a/sub/deep', [projectRoot])).toBe(true);
  });

  it('refuses siblings and prefix-lookalikes', () => {
    expect(pathIsUnderAny('/work/ab', [projectRoot])).toBe(false);
    expect(pathIsUnderAny('/work/b', [projectRoot])).toBe(false);
  });

  it('admits descendants whose own name begins with two dots', () => {
    expect(pathIsUnderAny('/work/a/..cache', [projectRoot])).toBe(true);
  });

  it('admits descendants of POSIX and canonical Windows roots', () => {
    expect(pathIsUnderAny('/work/a', ['/'])).toBe(true);
    expect(pathIsUnderAny('/', ['/'])).toBe(true);
    // normalizeProjectPath strips the trailing slash from a drive root and
    // lowercases it on Windows before the ledger stores it.
    expect(pathIsUnderAny('c:/work/a', ['c:'])).toBe(true);
    expect(pathIsUnderAny('c:', ['c:'])).toBe(true);
    expect(pathIsUnderAny('c:/work/a', ['c:/'])).toBe(true);
  });

  it('performs no normalization of its own', () => {
    // The caller owns the path space (tier-2 review C1) — a differently-spelt
    // equivalent is NOT matched here, by design.
    expect(pathIsUnderAny('/Work/A', [projectRoot])).toBe(false);
    expect(pathIsUnderAny('/work/a/../a', [projectRoot])).toBe(true);
    expect(pathIsUnderAny(projectRoot, ['/work/a/../a'])).toBe(false);
  });
});

describe('composeDispatchScope', () => {
  const enabledGate = (p: string) => p.startsWith('/work/cgf-portal');
  const allowedGate = (p: string) => p.startsWith('/work/');

  it('uses the enabled gate, and only it, while the selection filter is active', () => {
    // The allow-list gates pre-resolution task metadata, which the daemon's
    // task source never sets, so it must not narrow this regime — re-deriving
    // membership from both lists excluded rows dispatch admits. (AGT-4127
    // review rounds 2–4)
    const inScope = composeDispatchScope(true, enabledGate, () => false)!;
    expect(inScope('/work/cgf-portal/apps')).toBe(true);
    expect(inScope('/work/vega-agent')).toBe(false);
  });

  it('falls back to the allowed gate when no selection is active', () => {
    // Without this regime, an allow-list-only configuration read the raw table
    // and the stale-row inflation returned. (review round 5)
    const inScope = composeDispatchScope(false, enabledGate, allowedGate)!;
    expect(inScope('/work/vega-agent')).toBe(true);
    expect(inScope('/Users/someone/dev/STONKS')).toBe(false);
  });

  it('returns undefined when nothing restricts dispatch', () => {
    // Everything is dispatchable; callers read the raw table. The gates are
    // bound by the caller in the ledger's own path space — this function holds
    // no path logic to get wrong. (tier-2 review C1)
    expect(composeDispatchScope(false, enabledGate, undefined)).toBeUndefined();
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
