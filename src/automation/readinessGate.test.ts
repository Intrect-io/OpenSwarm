import { describe, expect, it } from 'vitest';
import { evaluateReadiness, formatReadinessSummary, partitionByReadiness, verdictFromDraft } from './readinessGate.js';

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
