import { describe, expect, it, vi } from 'vitest';
import { ensureVersionLabel, planVersionLabel, repoVersionLabels, versionLabelFor, versionLabelForTitle } from './publicationVersionLabel.js';

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

describe('bracket tag that is not a kind falls through to the conventional prefix', () => {
  it.each([
    ['[WIP] fix: wrong total', 'version:patch'],
    ['[Desktop] feat: stop and retry', 'version:minor'],
    ['[AGT-1] [Desktop] chore(x): bump', 'version:skip'],
  ])('%s -> %s', (title, label) => {
    expect(versionLabelForTitle(title).label).toBe(label);
  });

  it('keeps a breaking marker behind the tag unlabelled', () => {
    expect(versionLabelForTitle('[WIP] feat!: drop v1').label).toBeNull();
  });

  it('stays unlabelled when neither the tag nor the remainder decides', () => {
    expect(versionLabelForTitle('[Improvement] activity timeline').label).toBeNull();
    expect(versionLabelForTitle('[WIP] refactor: split').label).toBeNull();
  });
});

describe('label lookup failure is distinct from a repository without labels', () => {
  const failing = async () => { throw new Error('HTTP 403: API rate limit exceeded\nmore text'); };

  it('reports failure with a short reason', async () => {
    const lookup = await repoVersionLabels('/r', failing);
    expect(lookup.failure).toBe('HTTP 403: API rate limit exceeded');
    expect(lookup.labels.size).toBe(0);
  });

  it('reports no failure for a repository that defines no version labels', async () => {
    expect(await repoVersionLabels('/r', async () => 'bug\n')).toEqual({ labels: new Set() });
  });

  it('puts a note in the body when the lookup failed, instead of silence', async () => {
    const plan = await versionLabelFor('/r', '[BUG] x', failing);
    expect(plan.createArgs).toEqual([]);
    expect(plan.bodySection).toContain('Version label: lookup failed: HTTP 403');
    expect(plan.bodySection).toContain('add one by hand');
  });

  it('stays silent for a repository without version labels', async () => {
    expect(await versionLabelFor('/r', '[BUG] x', async () => '')).toEqual({ createArgs: [], bodySection: '' });
  });
});

describe('ensureVersionLabel', () => {
  const URL = 'https://github.com/o/r/pull/7';
  const runner = (prLabels: string, repoLabels = 'version:patch\nversion:skip') => vi.fn(async (_cwd: string, ...args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return prLabels;
    if (args[0] === 'label') return repoLabels;
    return '';
  });

  it('adds the mapped label to a PR that has none', async () => {
    const run = runner('bug\n');
    await ensureVersionLabel('/r', URL, '[BUG] x', run);
    expect(run).toHaveBeenCalledWith('/r', 'pr', 'edit', URL, '--add-label', 'version:patch');
  });

  it('leaves a PR that already has a version label alone', async () => {
    const run = runner('version:skip\n');
    await ensureVersionLabel('/r', URL, '[BUG] x', run);
    expect(run.mock.calls.some((c) => c[1] === 'pr' && c[2] === 'edit')).toBe(false);
  });

  it('does nothing for an unmappable title or a repository lacking the label', async () => {
    const a = runner('');
    await ensureVersionLabel('/r', URL, 'refactor: x', a);
    expect(a).not.toHaveBeenCalled();
    const b = runner('', 'version:skip');
    await ensureVersionLabel('/r', URL, '[BUG] x', b);
    expect(b.mock.calls.some((c) => c[2] === 'edit')).toBe(false);
  });

  it('never throws when gh fails', async () => {
    await expect(ensureVersionLabel('/r', URL, '[BUG] x', async () => { throw new Error('boom'); })).resolves.toBeUndefined();
  });
});
