import { describe, it, expect, vi } from 'vitest';
import type { LinearIssueInfo } from '../core/types.js';
import {
  filterRepoIssues,
  formatIssueChoice,
  selectIssuesInteractive,
  WORK_SELECTABLE_STATES,
  WORK_SKIP_STATES,
} from './workSelect.js';

function issue(overrides: Partial<LinearIssueInfo> = {}): LinearIssueInfo {
  return {
    id: 'id-1',
    identifier: 'INT-1',
    title: 'Fix the thing',
    state: 'Todo',
    priority: 2,
    labels: [],
    comments: [],
    project: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

describe('filterRepoIssues (INT-3387)', () => {
  it('keeps only issues of the given project', () => {
    const issues = [
      issue({ id: 'a', identifier: 'INT-1' }),
      issue({ id: 'b', identifier: 'INT-2', project: { id: 'other', name: 'Other' } }),
      issue({ id: 'c', identifier: 'INT-3', project: undefined }),
    ];
    expect(filterRepoIssues(issues, 'proj-1').map((i) => i.id)).toEqual(['a']);
  });

  it('keeps only selectable states (Todo/Backlog/In Progress)', () => {
    const issues = [
      issue({ id: 'a', state: 'Todo' }),
      issue({ id: 'b', state: 'Backlog' }),
      issue({ id: 'c', state: 'In Progress' }),
      issue({ id: 'd', state: 'Done' }),
      issue({ id: 'e', state: 'In Review' }),
      issue({ id: 'f', state: 'Canceled' }),
    ];
    expect(filterRepoIssues(issues, 'proj-1').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by priority with Linear "no priority" (0) last, then by identifier', () => {
    const issues = [
      issue({ id: 'none', identifier: 'INT-9', priority: 0 }),
      issue({ id: 'low', identifier: 'INT-8', priority: 4 }),
      issue({ id: 'urgent', identifier: 'INT-7', priority: 1 }),
      issue({ id: 'urgent2', identifier: 'INT-10', priority: 1 }),
    ];
    expect(filterRepoIssues(issues, 'proj-1').map((i) => i.id)).toEqual([
      'urgent', 'urgent2', 'low', 'none',
    ]);
  });

  it('orders identifier ties numerically (INT-2 before INT-10)', () => {
    const issues = [
      issue({ id: 'ten', identifier: 'INT-10', priority: 1 }),
      issue({ id: 'two', identifier: 'INT-2', priority: 1 }),
    ];
    expect(filterRepoIssues(issues, 'proj-1').map((i) => i.id)).toEqual(['two', 'ten']);
  });

  it('state constants stay disjoint (a state must not be both selectable and skipped)', () => {
    for (const state of WORK_SELECTABLE_STATES) {
      expect(WORK_SKIP_STATES).not.toContain(state);
    }
  });
});

describe('formatIssueChoice (INT-3387)', () => {
  it('renders `[identifier] P<n> title — state`', () => {
    expect(formatIssueChoice(issue({ identifier: 'INT-42', priority: 1, title: 'Ship it', state: 'Todo' })))
      .toBe('[INT-42] P1 Ship it — Todo');
  });

  it('omits the priority tag for "no priority" (0)', () => {
    expect(formatIssueChoice(issue({ priority: 0, title: 'Later', state: 'Backlog' })))
      .toBe('[INT-1] Later — Backlog');
  });

  it('truncates to the column budget with an ellipsis', () => {
    const long = formatIssueChoice(issue({ title: 'x'.repeat(200) }), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('selectIssuesInteractive (INT-3387)', () => {
  it('maps the prompt selection back to issues, preserving prompt order', async () => {
    const issues = [issue({ id: 'a', identifier: 'INT-1' }), issue({ id: 'b', identifier: 'INT-2' })];
    const prompt = vi.fn(async () => ['b', 'a']);
    const picked = await selectIssuesInteractive(issues, { prompt });
    expect(picked.map((i) => i.id)).toEqual(['b', 'a']);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      choices: [
        { name: '[INT-1] P2 Fix the thing — Todo', value: 'a' },
        { name: '[INT-2] P2 Fix the thing — Todo', value: 'b' },
      ],
    }));
  });

  it('drops ids the prompt returns that are not in the offered set', async () => {
    const issues = [issue({ id: 'a' })];
    const picked = await selectIssuesInteractive(issues, { prompt: async () => ['a', 'ghost'] });
    expect(picked.map((i) => i.id)).toEqual(['a']);
  });

  it('propagates the prompt rejection (Ctrl-C ExitPromptError) to the caller', async () => {
    const abort = new Error('ctrl-c');
    abort.name = 'ExitPromptError';
    await expect(selectIssuesInteractive([issue()], { prompt: async () => { throw abort; } }))
      .rejects.toMatchObject({ name: 'ExitPromptError' });
  });
});
