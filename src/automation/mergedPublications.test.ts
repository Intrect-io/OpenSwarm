import { describe, expect, it } from 'vitest';
import { decideMergedPublication, planMergedPublicationChecks, uncheckedCriteria } from './mergedPublications.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PRLifecycle } from '../github/github.js';

const task = (id: string, linearState: string, description?: string): TaskItem =>
  ({ id, issueId: id, issueIdentifier: id, title: id, linearState, description } as unknown as TaskItem);

const pr = (state: PRLifecycle['state'], extra: Partial<PRLifecycle> = {}): PRLifecycle =>
  ({ repo: 'o/r', number: 9, state, branch: 'b', baseBranch: 'main', ...extra });

describe('merged publications sweep (AGT-4409)', () => {
  it('considers only In Review issues with a PR this daemon published, not ones still owned by the scheduler', () => {
    const tasks = [task('A', 'In Review'), task('B', 'In Review'), task('C', 'In Progress'), task('D', 'In Review')];
    const plan = planMergedPublicationChecks(tasks, {
      publishedPrUrl: (id) => (id === 'C' || id === 'D' || id === 'A' ? `https://github.com/o/r/pull/${id}` : undefined),
      isSchedulerOwned: (id) => id === 'D',
    });
    expect(plan.map((c) => c.task.id)).toEqual(['A']);
  });

  it('counts unticked boxes and ignores ticked ones and prose', () => {
    expect(uncheckedCriteria('## DoD\n- [ ] tests\n- [x] docs\n* [ ] customer confirmed\n- plain bullet')).toBe(2);
    expect(uncheckedCriteria(undefined)).toBe(0);
  });

  it('merged with no open criteria → Done; merged with open criteria → stays, once; closed → Backlog; open → nothing', () => {
    const url = 'https://github.com/o/r/pull/9';
    expect(decideMergedPublication(pr('MERGED', { mergedAt: '2026-09-17T15:17:00Z', mergeCommitOid: 'abcdef0123' }), url, '- [x] all')).toMatchObject({ action: 'done' });
    const waiting = decideMergedPublication(pr('MERGED'), url, '- [ ] customer confirmed');
    expect(waiting).toMatchObject({ action: 'await-criteria', marker: 'merged-await-criteria:o/r#9' });
    expect(decideMergedPublication(pr('CLOSED'), url, undefined)).toMatchObject({ action: 'backlog' });
    expect(decideMergedPublication(pr('OPEN'), url, undefined)).toEqual({ action: 'none' });
  });
});
