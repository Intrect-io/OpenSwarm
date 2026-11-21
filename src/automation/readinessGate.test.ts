import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateReadiness, exclusionLabelledIds, exclusionLabelsForProject, formatReadinessSummary, partitionByReadiness, projectSkipLabelsHook, verdictFromDraft } from './readinessGate.js';
import { holdBeforeClaim, recordDraftOutcome, resetPreClaimHoldMemo } from './preClaimHold.js';
import { partitionByDefinitionOfReady } from './definitionOfReady.js';
import { scopePromptParts } from '../agents/draftScope.js';

const task = (over: Partial<Parameters<typeof evaluateReadiness>[0]> = {}) => ({
  issueIdentifier: 'T-1', linearState: 'Todo', labels: [] as string[], title: 'Fix the thing', ...over,
});

describe('evaluateReadiness (AGT-4784)', () => {
  it('claims a Todo issue with nothing against it', () => {
    expect(evaluateReadiness(task())).toEqual({ claim: true, reason: 'ready' });
  });

  it('never claims Backlog unless the project opts in, and never claims a terminal state', () => {
    expect(evaluateReadiness(task({ linearState: 'Backlog' }))).toEqual({ claim: false, reason: 'state:Backlog' });
    expect(evaluateReadiness(task({ linearState: 'Backlog' }), { includeBacklog: true }).claim).toBe(true);
    for (const state of ['Done', 'Canceled', 'Cancelled']) {
      expect(evaluateReadiness(task({ linearState: state }), { includeBacklog: true }).claim).toBe(false);
    }
  });

  it('keeps resuming In Progress and In Review, and does not gate on an unknown state', () => {
    for (const state of ['In Progress', 'In Review', undefined]) {
      expect(evaluateReadiness(task({ linearState: state })).claim).toBe(true);
    }
  });

  it('blocks an exclusion label, ignoring case and padding, and names it', () => {
    const decision = evaluateReadiness(task({ labels: ['  Out-Of-Scope '] }), { exclusionLabels: ['out-of-scope'] });
    expect(decision).toEqual({ claim: false, reason: 'label:out-of-scope' });
    expect(evaluateReadiness(task({ labels: ['out-of-scope'] }), { exclusionLabels: [] }).claim).toBe(true);
  });

  it('does not treat a title tag or an epic as an exclusion label', () => {
    // Those are AGT-4682's partitionHumanOwned rules; this gate asks only for labels, state and verdict.
    expect(evaluateReadiness(task({ title: '[Docs] write it', hasChildren: true }), { exclusionLabels: ['Docs'] }).claim).toBe(true);
  });

  it('blocks any verdict other than actionable, and names it', () => {
    expect(evaluateReadiness(task(), { verdict: 'actionable' }).claim).toBe(true);
    expect(evaluateReadiness(task(), { verdict: 'decision_pending' })).toEqual({ claim: false, reason: 'verdict:decision_pending' });
    expect(evaluateReadiness(task(), { verdict: 'human_action_only' }).claim).toBe(false);
  });

  it('answers the state first: a Backlog issue is not_ready even with an actionable verdict', () => {
    expect(evaluateReadiness(task({ linearState: 'Backlog' }), { verdict: 'actionable' }).reason).toBe('state:Backlog');
  });

  it('lets an explicit dispatch through every rule: choosing the issue is the decision', () => {
    const chosen = task({ linearState: 'Backlog', labels: ['out-of-scope'], explicitDispatch: true });
    expect(evaluateReadiness(chosen, { exclusionLabels: ['out-of-scope'], verdict: 'decision_pending' }).claim).toBe(true);
  });

  it('replays a queue of the 2026-10-20 shape: only the ready Todo issues are claimed', () => {
    const queue = [
      task({ issueIdentifier: 'Q-1', linearState: 'Backlog', labels: ['out-of-scope'] }),
      task({ issueIdentifier: 'Q-2', linearState: 'Backlog' }),
      task({ issueIdentifier: 'Q-3', linearState: 'Todo', title: '[decision] pick a channel' }),
      task({ issueIdentifier: 'Q-4', linearState: 'Todo' }),
      task({ issueIdentifier: 'Q-5', linearState: 'Todo', labels: ['out-of-scope'] }),
      task({ issueIdentifier: 'Q-6', linearState: 'Todo' }),
    ];
    const verdicts: Record<string, string | undefined> = { 'Q-3': 'decision_pending', 'Q-4': 'human_action_only' };
    const claimed = queue
      .filter((t) => evaluateReadiness(t, { exclusionLabels: ['out-of-scope'], verdict: verdicts[t.issueIdentifier] }).claim)
      .map((t) => t.issueIdentifier);
    expect(claimed).toEqual(['Q-6']);
  });
});

describe('partitionByReadiness', () => {
  it('groups the held issues by reason, keyed by identifier, and keeps order for the ready ones', () => {
    const tasks = [
      task({ issueIdentifier: 'A', linearState: 'Backlog' }),
      task({ issueIdentifier: 'B' }),
      task({ issueIdentifier: 'C', linearState: 'Backlog' }),
      task({ issueIdentifier: 'D', labels: ['x'] }),
    ];
    const { ready, held } = partitionByReadiness(tasks, { exclusionLabels: ['x'] });
    expect(ready.map((t) => t.issueIdentifier)).toEqual(['B']);
    expect(held.get('state:Backlog')).toEqual(['A', 'C']);
    expect(held.get('label:x')).toEqual(['D']);
  });

  it('falls back to the id when an issue has no identifier, and summarises one line per reason', () => {
    const { held } = partitionByReadiness([{ id: 'raw-1', title: 't', linearState: 'Backlog' }]);
    expect(formatReadinessSummary(held)).toEqual(['  ⏭ not ready (state:Backlog) 1: raw-1']);
    const many = new Map([['state:Backlog', Array.from({ length: 10 }, (_, i) => `K-${i}`)]]);
    expect(formatReadinessSummary(many, 3)[0]).toContain('K-0, K-1, K-2 +7 more');
  });
});

describe('verdictFromDraft', () => {
  const scope = (over: Record<string, unknown> = {}) => ({
    applicable: false as const, kind: 'decision_pending' as const, confidence: 0.95,
    reason: 'the title asks for a decision', evidence: ['title says decide', 'no code deliverable'], ...over,
  });

  it('returns the declined kind only for a project with a goal and a confident, evidenced verdict', () => {
    expect(verdictFromDraft({ scope: scope() }, true)).toBe('decision_pending');
    expect(verdictFromDraft({ scope: scope() }, false)).toBeUndefined();
    expect(verdictFromDraft({ scope: scope({ confidence: 0.5 }) }, true)).toBeUndefined();
    expect(verdictFromDraft({ scope: scope({ evidence: ['one'] }) }, true)).toBeUndefined();
    expect(verdictFromDraft({}, true)).toBeUndefined();
    expect(verdictFromDraft(undefined, true)).toBeUndefined();
  });
});

describe('pre-claim hold for every project (AGT-4784)', () => {
  const decline = {
    applicable: false as const, kind: 'decision_pending' as const, confidence: 0.95,
    reason: 'the title asks for a decision', evidence: ['title says decide', 'no code deliverable'],
  };
  const candidate = (id: string, over: Record<string, unknown> = {}) => ({
    task: { id, issueId: `uuid-${id}`, issueIdentifier: id, linearState: 'Todo', title: `Task ${id}`, ...over },
  });

  beforeEach(() => resetPreClaimHoldMemo());

  it('computes the scope verdict for a project without a goal', async () => {
    // The drafter is asked for the verdict with no goal set: only the goal-free kinds are offered.
    const { field, rules } = scopePromptParts(undefined, true);
    expect(field).toContain('"scope"');
    for (const kind of ['wrong_repository', 'human_action_only', 'decision_pending']) expect(field).toContain(kind);
    expect(field).not.toContain('out_of_goal');
    expect(rules).not.toContain('blocked_by_dependency');
    // The goal prompt is unchanged, and so is the goal-less one when nobody asks for the verdict.
    expect(scopePromptParts(undefined)).toEqual({ field: '', rules: '' });
    expect(scopePromptParts('Ship usable work.', true)).toEqual(scopePromptParts('Ship usable work.'));

    // ...and the hold acts on it with no project goal anywhere in sight.
    const comment = vi.fn(async () => undefined);
    const log = vi.fn();
    const held = candidate('AX-2148', { preAdmissionDraft: { scope: decline } });
    const clean = candidate('AX-1', { preAdmissionDraft: {} });
    const kept = await holdBeforeClaim([held, clean], new Set(), { log, label: (t) => t.issueIdentifier ?? t.id, comment });
    expect(kept).toEqual([clean]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verdict:decision_pending'));
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][2]).toMatch(/^draft-scope:/); // the worker-start gate's marker
    // One comment per marker: a second heartbeat does not post again.
    await holdBeforeClaim([held], new Set(), { log, label: (t) => t.id, comment });
    expect(comment).toHaveBeenCalledTimes(1);
    // ...but another issue declined for the same reason (same marker) still gets its own.
    await holdBeforeClaim([candidate('AX-2145', { preAdmissionDraft: { scope: decline } })], new Set(), { log, label: (t) => t.id, comment });
    expect(comment).toHaveBeenCalledTimes(2);
  });

  it('does not start a worker when the draft call fails', async () => {
    const failed = new Set<string>();
    await expect(recordDraftOutcome(failed, 'A', async () => { throw new Error('provider down'); })).rejects.toThrow('provider down');
    await recordDraftOutcome(failed, 'B', async () => ({ failed: true }));
    await recordDraftOutcome(failed, 'C', async () => ({ sufficient: true }));
    await recordDraftOutcome(failed, 'D', async () => undefined); // drafting disabled: not a failure
    expect([...failed].sort()).toEqual(['A', 'B']);

    const log = vi.fn();
    const comment = vi.fn(async () => undefined);
    const group = [candidate('A'), candidate('B'), candidate('C', { preAdmissionDraft: {} }), candidate('D'),
      candidate('E', { explicitDispatch: true })];
    failed.add('E');
    const kept = await holdBeforeClaim(group, failed, { log, label: (t) => t.id, comment });
    expect(kept.map((c) => c.task.id)).toEqual(['C', 'D', 'E']);
    expect(comment).not.toHaveBeenCalled(); // no verdict, nothing to say on the issue
    expect(log).toHaveBeenCalledTimes(2);
    // Logged once: the next heartbeat with the same failure holds silently.
    await holdBeforeClaim(group, failed, { log, label: (t) => t.id, comment });
    expect(log).toHaveBeenCalledTimes(2);
    // A draft that succeeds releases the issue.
    failed.delete('A');
    expect((await holdBeforeClaim([candidate('A', { preAdmissionDraft: {} })], failed, { log, label: (t) => t.id })).length).toBe(1);
  });

  it('honours a per-project exclusion label', async () => {
    const agents = [
      { projectPath: '/repos/cgf-portal', linearProjectId: 'proj-ax', skipLabels: ['추가 유지보수'] },
      { projectPath: '/repos/other' },
    ];
    const hook = projectSkipLabelsHook(agents, async (t: { title: string }) => (t.title === 'by path' ? '/repos/cgf-portal/sub' : null));
    expect(hook).toBeDefined();
    const tasks = [
      { id: 'a', issueIdentifier: 'AX-2005', title: 't', linearState: 'Todo', labels: ['추가 유지보수'], linearProject: { id: 'proj-ax' } },
      { id: 'b', issueIdentifier: 'OT-1', title: 't', linearState: 'Todo', labels: ['추가 유지보수'], linearProject: { id: 'proj-other' } },
      { id: 'c', issueIdentifier: 'AX-9', title: 'by path', linearState: 'Todo', labels: ['추가 유지보수'] },
      { id: 'd', issueIdentifier: 'AX-10', title: 't', linearState: 'Todo', labels: ['global-skip'], linearProject: { id: 'proj-ax' } },
      { id: 'e', issueIdentifier: 'AX-11', title: 't', linearState: 'Todo', labels: [], linearProject: { id: 'proj-ax' } },
    ];
    const { ready, held } = await partitionByDefinitionOfReady(tasks, {
      exclusionLabels: ['global-skip'], projectExclusionLabels: hook,
    });
    expect(ready.map((t) => t.id)).toEqual(['b', 'e']); // another project's issue keeps the label harmlessly
    expect(held.get('label:추가 유지보수')).toEqual(['AX-2005', 'AX-9']);
    expect(held.get('label:global-skip')).toEqual(['AX-10']);
    // No project sets any: no hook, no per-task lookup.
    expect(projectSkipLabelsHook([{ projectPath: '/repos/other' }])).toBeUndefined();
  });
});

describe('exclusion-labelled ids for post-claim sweeps (AGT-4784)', () => {
  const agents = [
    { projectPath: '/repos/cgf-portal', linearProjectId: 'proj-ax', skipLabels: ['Maintenance'] },
    { projectPath: '/repos/other' },
  ];

  it('excludes a task carrying a global label, ignoring case and padding, keyed by issueId', async () => {
    const ids = await exclusionLabelledIds(
      [{ id: 'a', issueId: 'uuid-a', title: 't', labels: ['  Out-Of-Scope '] }, { id: 'b', title: 't', labels: ['other'] }],
      ['out-of-scope'],
    );
    expect([...ids]).toEqual(['uuid-a']);
  });

  it('excludes a task carrying its project label, found via linearProject.id', async () => {
    const hook = projectSkipLabelsHook(agents);
    const ids = await exclusionLabelledIds([
      { id: 'a', title: 't', labels: ['maintenance'], linearProject: { id: 'proj-ax' } },
      { id: 'b', title: 't', labels: ['maintenance'], linearProject: { id: 'proj-other' } },
    ], [], hook);
    expect([...ids]).toEqual(['a']);
  });

  it('fails closed: a throwing project lookup counts as excluded', async () => {
    const ids = await exclusionLabelledIds([{ id: 'a', title: 't', labels: ['x'] }], undefined, async () => {
      throw new Error('lookup failed');
    });
    expect(ids.has('a')).toBe(true);
  });

  it('leaves a clean task out of the set', async () => {
    const ids = await exclusionLabelledIds(
      [{ id: 'a', title: 't', labels: ['bug'], linearProject: { id: 'proj-ax' } }, { id: 'b', title: 't' }],
      ['out-of-scope'],
      projectSkipLabelsHook(agents),
    );
    expect(ids.size).toBe(0);
  });

  it('merges the owning project skipLabels into the global labels for grooming', () => {
    expect(exclusionLabelsForProject(['global'], agents, '/repos/cgf-portal/sub')).toEqual(['global', 'Maintenance']);
    expect(exclusionLabelsForProject(['global'], agents, '/repos/other')).toEqual(['global']);
    expect(exclusionLabelsForProject(undefined, agents, undefined)).toEqual([]);
  });
});
