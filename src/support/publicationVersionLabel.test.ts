import { describe, expect, it } from 'vitest';
import { planVersionLabel, versionLabelForTitle } from './publicationVersionLabel.js';

const ALL = new Set(['version:major', 'version:minor', 'version:patch', 'version:skip']);

describe('versionLabelForTitle (AGT-4269)', () => {
  it.each([
    ['[test] cover the parser', 'version:skip'],
    ['[CI] openswarm PRs carry no label', 'version:skip'],
    ['[docs] runbook', 'version:skip'],
    ['[chore] bump deps', 'version:skip'],
    ['[BUG] crash on empty input', 'version:patch'],
    ['[fix] wrong total', 'version:patch'],
    ['[perf] cache the index', 'version:patch'],
    ['[feature] export to CSV', 'version:minor'],
    ['[FEAT] export to CSV', 'version:minor'],
    ['fix: wrong total', 'version:patch'],
    ['ci(gate): loc-gate fails instead of warning', 'version:skip'],
    ['chore(hooks): versioned pre-commit hook', 'version:skip'],
    ['feat(desktop): stop and retry', 'version:minor'],
    ['perf(index): cache', 'version:patch'],
    ['AGT-4269: [CI] label PRs', 'version:skip'],
    ['[AGT-4269] fix: label PRs', 'version:patch'],
  ])('%s -> %s', (title, label) => {
    expect(versionLabelForTitle(title).label).toBe(label);
  });

  it.each([
    'refactor(support): split dashboardHtml.ts',
    'Improve the dashboard',
    '[Improvement] activity timeline',
    'feat!: drop the v1 API',
    '',
  ])('leaves %j unlabelled with a reason', (title) => {
    const decision = versionLabelForTitle(title);
    expect(decision.label).toBeNull();
    expect(decision.label === null && decision.reason.length > 0).toBe(true);
  });
});

describe('planVersionLabel', () => {
  it('adds exactly one --label when the repository defines it', () => {
    expect(planVersionLabel('[BUG] x', ALL)).toEqual({ createArgs: ['--label', 'version:patch'], bodySection: '' });
  });

  it('opens unlabelled with the reason in the body when the title does not decide', () => {
    const plan = planVersionLabel('refactor: split module', ALL);
    expect(plan.createArgs).toEqual([]);
    expect(plan.bodySection).toContain('## Version label');
    expect(plan.bodySection).toContain('`refactor`');
  });

  it('touches nothing in a repository without version labels', () => {
    expect(planVersionLabel('[BUG] x', new Set())).toEqual({ createArgs: [], bodySection: '' });
    expect(planVersionLabel('refactor: y', new Set())).toEqual({ createArgs: [], bodySection: '' });
  });

  it('never passes a label the repository lacks (gh would fail the create)', () => {
    const plan = planVersionLabel('[feature] x', new Set(['version:patch', 'version:skip']));
    expect(plan.createArgs).toEqual([]);
    expect(plan.bodySection).toContain('does not define');
  });
});
