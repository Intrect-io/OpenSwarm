import { describe, expect, it } from 'vitest';
import { crossWorktreeAuditNote, foreignWorktreeReferences, ownWorktreeId } from './crossWorktreeAudit.js';

const OWN = '/work/cgf-portal/worktree/698b91b2-68c0-42bd-8ba1-417544475109';
const OTHER = '/work/cgf-portal/worktree/0f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

describe('ownWorktreeId', () => {
  it('reads the segment after worktree/', () => {
    expect(ownWorktreeId(OWN)).toBe('698b91b2-68c0-42bd-8ba1-417544475109');
    expect(ownWorktreeId(`${OWN}/apps/pipelines`)).toBe('698b91b2-68c0-42bd-8ba1-417544475109');
  });

  it('is null outside a worktree', () => {
    expect(ownWorktreeId('/work/cgf-portal')).toBeNull();
    expect(ownWorktreeId('/work/cgf-portal/worktree')).toBeNull();
  });
});

describe('foreignWorktreeReferences (AGT-4043)', () => {
  it('flags the audit-log shape: a venv assignment pointing at another task', () => {
    const command = `VENV=${OTHER}/apps/pipelines/.venv\n"$VENV/bin/ruff" check apps/pipelines/src/cgf_pipelines/db.py`;
    expect(foreignWorktreeReferences(command, OWN)).toEqual([`${OTHER}/apps/pipelines/.venv`]);
  });

  it('ignores references to the worktree the command runs in', () => {
    expect(foreignWorktreeReferences(`${OWN}/apps/pipelines/.venv/bin/pytest -q`, OWN)).toEqual([]);
    expect(foreignWorktreeReferences(`${OWN}/apps/pipelines/.venv/bin/pytest -q`, `${OWN}/apps/pipelines`)).toEqual([]);
  });

  it('treats every worktree reference as foreign when cwd is not a worktree', () => {
    expect(foreignWorktreeReferences(`ls ${OWN}`, '/work/cgf-portal')).toEqual([OWN]);
  });

  it('deduplicates and keeps order of appearance', () => {
    const third = '/work/cgf-portal/worktree/third';
    const command = `${OTHER}/bin/a; ${third}/bin/b && ${OTHER}/bin/a`;
    expect(foreignWorktreeReferences(command, OWN)).toEqual([`${OTHER}/bin/a`, `${third}/bin/b`]);
  });

  it('leaves ordinary commands alone', () => {
    expect(foreignWorktreeReferences('pytest -q apps/pipelines/tests', OWN)).toEqual([]);
    expect(foreignWorktreeReferences('git worktree list', OWN)).toEqual([]);
    expect(foreignWorktreeReferences('echo worktree/abc', OWN)).toEqual([]); // relative, not a path into a checkout
  });
});

// A repository that itself lives under a `worktree/` directory (a checkout
// kept in another repo's ./worktree/) gives its task worktrees two `worktree`
// segments. Measured on a real run (AGT-4534): the worker's commands naming its
// own worktree came back with "referenced another task's worktree".
describe('foreignWorktreeReferences with a nested worktree/ layout', () => {
  const NESTED_OWN = '/work/repo/worktree/checkout-a/worktree/tk-1';
  const NESTED_OTHER = '/work/repo/worktree/checkout-a/worktree/tk-2';

  it('ignores references to the worktree the command runs in', () => {
    expect(foreignWorktreeReferences(`cd ${NESTED_OWN} && ls -R tools`, NESTED_OWN)).toEqual([]);
    expect(foreignWorktreeReferences(`cat ${NESTED_OWN}/src/a.ts`, `${NESTED_OWN}/src`)).toEqual([]);
  });

  it('still flags a sibling task worktree in the same nested checkout', () => {
    expect(foreignWorktreeReferences(`cat ${NESTED_OTHER}/src/a.ts`, NESTED_OWN)).toEqual([`${NESTED_OTHER}/src/a.ts`]);
  });

  it('does not take a sibling whose id extends the own id for the own worktree', () => {
    expect(foreignWorktreeReferences(`cat ${NESTED_OWN}0/src/a.ts`, NESTED_OWN)).toEqual([`${NESTED_OWN}0/src/a.ts`]);
  });

  it('still flags the enclosing checkout\'s own worktrees', () => {
    expect(foreignWorktreeReferences('ls /work/repo/worktree/checkout-b/src', NESTED_OWN)).toEqual(['/work/repo/worktree/checkout-b/src']);
  });
});

describe('crossWorktreeAuditNote', () => {
  it('is null for clean commands and names the paths otherwise', () => {
    expect(crossWorktreeAuditNote('ls', OWN)).toBeNull();
    const note = crossWorktreeAuditNote(`${OTHER}/.venv/bin/pytest`, OWN);
    expect(note).toContain('[audit]');
    expect(note).toContain(`${OTHER}/.venv/bin/pytest`);
    expect(note).toContain("this worktree's own dependencies");
  });
});
