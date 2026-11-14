// AGT-3188: `autonomous.scope.milestone` narrows what the daemon may pick. The fetch is the only input
// to selection, so the proof is that every state query the heartbeat makes carries the milestone —
// including In Progress / In Review, so an out-of-scope issue someone else moved to In Progress
// never reaches the daemon to be taken over.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinearClient } from '@linear/sdk';
import { clearLinearCache, getMyIssues, initLinear } from './linear.js';

vi.mock('@linear/sdk', () => ({ LinearClient: vi.fn() }));

type Call = { filter: Record<string, unknown> };

function installRawClient(nodesFor: (filter: Record<string, unknown>) => Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const fakeClient = {
    client: {
      rawRequest: vi.fn(async (_query: string, vars?: { filter?: Record<string, unknown> }) => {
        const filter = vars?.filter ?? {};
        calls.push({ filter });
        return { data: { issues: { nodes: nodesFor(filter), pageInfo: { hasNextPage: false, endCursor: null } } } };
      }),
    },
  };
  vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
  initLinear('fake-key', 'team-1');
  return calls;
}

const states = (filter: Record<string, unknown>) =>
  ((filter.state as { name?: { in?: string[] } })?.name?.in ?? []);

describe('getMyIssues milestone scope (AGT-3188)', () => {
  beforeEach(() => clearLinearCache());

  it('applies the milestone to every state query, In Progress and In Review included', async () => {
    const calls = installRawClient(() => []);
    await getMyIssues({ slim: true, milestone: 'S4 — Gate Trustworthiness' });
    expect(calls.map(c => states(c.filter)).flat().sort()).toEqual(['Backlog', 'In Progress', 'In Review', 'Todo']);
    for (const call of calls) {
      expect(call.filter.projectMilestone).toEqual({ name: { eq: 'S4 — Gate Trustworthiness' } });
    }
  });

  it('does not hand over an out-of-scope In Progress issue', async () => {
    // A server that honours the filter: the in-scope issue matches, the externally started one does not.
    const inScope = { id: 'a', identifier: 'AGT-1', title: 'in scope', priority: 2, state: { name: 'In Progress' }, milestone: 'S4' };
    const outOfScope = { id: 'b', identifier: 'AGT-2', title: 'started elsewhere', priority: 2, state: { name: 'In Progress' }, milestone: 'S5' };
    installRawClient((filter) => {
      if (!states(filter).includes('In Progress')) return [];
      const wanted = (filter.projectMilestone as { name: { eq: string } } | undefined)?.name.eq;
      return [inScope, outOfScope].filter(issue => !wanted || issue.milestone === wanted);
    });
    const scoped = await getMyIssues({ slim: true, milestone: 'S4' });
    expect(scoped.map(issue => issue.identifier)).toEqual(['AGT-1']);
  });

  it('without a milestone keeps the project-wide query and a separate cache entry', async () => {
    const calls = installRawClient(() => []);
    await getMyIssues({ slim: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.filter.projectMilestone).toBeUndefined();
    const before = calls.length;
    await getMyIssues({ slim: true, milestone: 'S4' });
    expect(calls.length).toBeGreaterThan(before); // not served from the unscoped cache
  });
});
