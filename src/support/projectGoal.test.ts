import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROJECT_GOAL_CHARS, formatProjectGoalSection, resolveProjectGoal } from './projectGoal.js';

describe('resolveProjectGoal (AGT-4662)', () => {
  const agents = [
    { projectPath: '/dev/cgf-portal', goal: 'Reconcile the ledgers in dependency order.' },
    { projectPath: '/dev/OpenSwarm' },
    { projectPath: '/dev/cgf-portal/apps/pipelines', goal: 'Pipelines only.' },
  ];

  it('gives the project its own goal', () => {
    expect(resolveProjectGoal(agents, '/dev/cgf-portal')).toBe('Reconcile the ledgers in dependency order.');
  });

  it('resolves a task worktree nested under the project to that project', () => {
    expect(resolveProjectGoal(agents, '/dev/cgf-portal/worktree/39e4640d-1c27')).toBe('Reconcile the ledgers in dependency order.');
  });

  it('lets the most specific nested project win', () => {
    expect(resolveProjectGoal(agents, '/dev/cgf-portal/apps/pipelines/src')).toBe('Pipelines only.');
  });

  it('does not match a sibling that merely shares a name prefix', () => {
    expect(resolveProjectGoal(agents, '/dev/cgf-portal-evil')).toBeUndefined();
  });

  it('gives a project with no goal nothing, and does not borrow an enclosing one', () => {
    expect(resolveProjectGoal(agents, '/dev/OpenSwarm')).toBeUndefined();
    const nested = [
      { projectPath: '/dev/parent', goal: 'Parent goal.' },
      { projectPath: '/dev/parent/child' },
    ];
    expect(resolveProjectGoal(nested, '/dev/parent/child/x')).toBeUndefined();
  });

  it('expands ~ and ignores a trailing slash', () => {
    expect(resolveProjectGoal([{ projectPath: '~/dev/repo/', goal: 'G' }], join(homedir(), 'dev/repo/worktree/a'))).toBe('G');
  });

  it('is undefined with no agents, and trims whitespace-only goals away', () => {
    expect(resolveProjectGoal(undefined, '/x')).toBeUndefined();
    expect(resolveProjectGoal([], '/x')).toBeUndefined();
    expect(resolveProjectGoal([{ projectPath: '/x', goal: '  \n ' }], '/x')).toBeUndefined();
  });

  it('bounds a runaway goal', () => {
    const goal = resolveProjectGoal([{ projectPath: '/x', goal: 'g'.repeat(MAX_PROJECT_GOAL_CHARS + 500) }], '/x');
    expect(goal).toHaveLength(MAX_PROJECT_GOAL_CHARS + 1);
    expect(goal?.endsWith('…')).toBe(true);
  });
});

describe('formatProjectGoalSection (AGT-4662)', () => {
  it('adds nothing without a goal, so an unconfigured project keeps its exact prompts', () => {
    expect(formatProjectGoalSection(undefined)).toBe('');
    expect(formatProjectGoalSection('')).toBe('');
    expect(formatProjectGoalSection('   ')).toBe('');
  });

  it('frames the goal as binding direction and carries it verbatim', () => {
    const section = formatProjectGoalSection('  의존성 순서대로 원장을 대조한다.  ');
    expect(section).toContain('## Standing project goal');
    expect(section).toContain('binding direction');
    expect(section).toContain('의존성 순서대로 원장을 대조한다.');
    expect(section.startsWith('\n\n')).toBe(true);
  });
});
