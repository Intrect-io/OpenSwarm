// @vitest-environment jsdom
//
// The orchestration graph is an aggregation, and a wrong aggregation lies
// about the swarm: a duplicated edge inflates interaction volume, a stale
// pending count keeps a settled question pulsing, and a lost role paints a
// reviewer as a generic agent.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import {
  buildOrchestrationModel, dominantKind, filterGraphNodes, KIND_COLORS, taskLanesOf,
} from '../../web/static/js/orchestrationModel.mjs';

type Node = {
  id: string; name: string; role: string; taskId?: string; taskLabel?: string;
  active: boolean; firstSeen: number; lastSeen: number;
};

let seq = 0;
function event(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    seq,
    timestamp: 1_000 + seq,
    correlationId: `c${seq}`,
    repository: '/repo',
    taskId: 't1',
    actor: 'enginseer-rhodanis-novum',
    actorName: 'Enginseer Rhodanis-Novum',
    actorRole: 'worker',
    kind: 'advice-request',
    status: 'open',
    summary: 's',
    ...over,
  };
}

describe('buildOrchestrationModel', () => {
  it('aggregates directed interactions per pair with a kind histogram', () => {
    const to = { recipient: 'adept-helion-cognitor', recipientName: 'Adept Helion-Cognitor', recipientRole: 'reviewer' };
    const model = buildOrchestrationModel([
      event({ ...to }),
      event({ ...to, kind: 'delegation-request' }),
      // Reverse direction is its own edge, not a merge.
      event({ actor: 'adept-helion-cognitor', actorName: 'Adept Helion-Cognitor', actorRole: 'reviewer', recipient: 'enginseer-rhodanis-novum', kind: 'advice-response', status: 'completed' }),
    ]);

    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(2);
    const forward = model.edges.find((edge: { from: string }) => edge.from === 'enginseer-rhodanis-novum');
    expect(forward).toMatchObject({ count: 2, kinds: { 'advice-request': 1, 'delegation-request': 1 } });
    expect(dominantKind(forward)).toBe('advice-request');
    expect(KIND_COLORS[dominantKind(forward)]).toBeTruthy();
  });

  it('folds an answered question out of pending by latest correlation state', () => {
    const asked = event({ kind: 'human-question', status: 'waiting', recipient: 'human', correlationId: 'hq-1' });
    const answered = event({ actor: 'human', actorRole: 'human', recipient: 'enginseer-rhodanis-novum', kind: 'human-answer', status: 'completed', correlationId: 'hq-1' });
    const still = buildOrchestrationModel([asked]);
    expect(still.stats.pendingQuestions).toBe(1);

    const settled = buildOrchestrationModel([asked, answered]);
    expect(settled.stats.pendingQuestions).toBe(0);
    expect(settled.stats.pendingTotal).toBe(0);
  });

  it('upgrades a legacy address-only sighting when a named, role-carrying event arrives', () => {
    const model = buildOrchestrationModel([
      // Legacy event: no name, no role.
      event({ actorName: undefined, actorRole: undefined }),
      event({ kind: 'review-run', status: 'completed' }),
    ]);
    expect(model.nodes[0]).toMatchObject({ name: 'Enginseer Rhodanis-Novum', role: 'worker', eventCount: 2 });
  });

  it('classifies infrastructure identities without an explicit role', () => {
    const model = buildOrchestrationModel([
      event({ actor: 'openswarm-daemon', actorName: 'OpenSwarm daemon', actorRole: undefined, recipient: undefined }),
      event({ actor: 'adapter-router', actorRole: undefined, recipient: 'enginseer-rhodanis-novum', kind: 'adapter-route', status: 'completed' }),
    ]);
    const roles = Object.fromEntries(model.nodes.map((node: { id: string; role: string }) => [node.id, node.role]));
    expect(roles['openswarm-daemon']).toBe('daemon');
    expect(roles['adapter-router']).toBe('daemon');
  });

  it('prefers the task a node ACTED in over any task it was merely addressed within', () => {
    const model = buildOrchestrationModel([
      event({ taskId: 'task-1' }),
      // Cross-task advice TO this node must not drag it into task-9.
      event({ actor: 'other', actorRole: 'worker', taskId: 'task-9', recipient: 'enginseer-rhodanis-novum' }),
    ]);
    const node = model.nodes.find((candidate: { id: string }) => candidate.id === 'enginseer-rhodanis-novum');
    expect(node!.taskId).toBe('task-1');
  });

  it('computes activity against the injected clock, not wall time', () => {
    const model = buildOrchestrationModel(
      [event({ timestamp: 1_000 })],
      { now: 1_000 + 31 * 60_000, activeWindowMs: 30 * 60_000 },
    );
    expect(model.nodes[0].active).toBe(false);
    expect(model.stats.activeAgents).toBe(0);
  });

  // A node that has never acted has no task of its own to defend, so seating
  // it with the people addressing it beats stranding it in a lane of one —
  // without weakening the rule above, which the next test pins.
  it('seats a pure recipient in the task it was addressed within', () => {
    const model = buildOrchestrationModel([
      event({ taskId: 'task-1', recipient: 'adept', recipientName: 'Adept', recipientRole: 'reviewer' }),
    ]);
    const adept = model.nodes.find((node: Node) => node.id === 'adept');
    expect(adept).toMatchObject({ taskId: 'task-1', role: 'reviewer' });
  });

  // `firstSeen` is the layout's seating order; if it drifted with activity the
  // stability guarantee it underwrites would drift with it.
  it('pins firstSeen at the earliest sighting while lastSeen follows activity', () => {
    const model = buildOrchestrationModel([
      event({ timestamp: 5_000 }),
      event({ timestamp: 9_000 }),
    ], { now: 9_000 });
    expect(model.nodes[0]).toMatchObject({ firstSeen: 5_000, lastSeen: 9_000 });
  });

  it('counts the agents parked on the operator, not the questions they asked', () => {
    const model = buildOrchestrationModel([
      event({ kind: 'human-question', status: 'waiting', recipient: 'human', correlationId: 'q1' }),
      // Same agent asking twice is still one agent to unblock.
      event({ kind: 'human-question', status: 'waiting', recipient: 'human', correlationId: 'q2' }),
      event({
        actor: 'adept', actorRole: 'reviewer', kind: 'human-question', status: 'waiting',
        recipient: 'human', correlationId: 'q3',
      }),
    ]);
    expect(model.stats.pendingQuestions).toBe(3);
    expect(model.stats.agentsAwaitingOperator).toBe(2);
  });
});

// Cause #1 in the issue: the client keeps every event the server ring ever
// handed it, so an agent that spoke once at 09:00 was still a dot at 17:00.
describe('filterGraphNodes', () => {
  const nodes = [
    { id: 'human', name: 'Operator', role: 'human', active: false },
    { id: 'openswarm-daemon', name: 'daemon', role: 'daemon', active: false },
    { id: 'w1', name: 'Enginseer', role: 'worker', taskId: 't1', taskLabel: 'AGT-1', active: true },
    { id: 'w2', name: 'Vindicator', role: 'worker', taskId: 't2', active: true },
    { id: 'old', name: 'Retired', role: 'reviewer', taskId: 't1', active: false },
  ];
  const idsOf = (list: Array<{ id: string }>) => list.map((node) => node.id);

  it('drops idle participants by default but never the rails', () => {
    expect(idsOf(filterGraphNodes(nodes))).toEqual(['human', 'openswarm-daemon', 'w1', 'w2']);
  });

  it('brings the idle back when the operator expands them', () => {
    expect(idsOf(filterGraphNodes(nodes, { showIdle: true }))).toContain('old');
  });

  it('narrows to one task while keeping the rails the lanes hang from', () => {
    const shown = idsOf(filterGraphNodes(nodes, { taskId: 't1' }));
    expect(shown).toContain('w1');
    expect(shown).toContain('human');
    expect(shown).not.toContain('w2');
  });

  it('searches names, addresses and task labels, case-insensitively', () => {
    expect(idsOf(filterGraphNodes(nodes, { query: 'vindic' }))).toContain('w2');
    expect(idsOf(filterGraphNodes(nodes, { query: 'agt-1' }))).toContain('w1');
    expect(idsOf(filterGraphNodes(nodes, { query: 'agt-1' }))).not.toContain('w2');
  });

  it('filters by role', () => {
    expect(idsOf(filterGraphNodes(nodes, { role: 'worker' }))).toEqual(['w1', 'w2']);
  });
});

describe('taskLanesOf', () => {
  it('orders lanes by first sighting so a new task appends instead of re-stacking', () => {
    const lanes = taskLanesOf([
      { id: 'b', role: 'worker', taskId: 't-late', firstSeen: 50, lastSeen: 99 },
      { id: 'a', role: 'worker', taskId: 't-early', firstSeen: 10, lastSeen: 12 },
      { id: 'c', role: 'reviewer', taskId: 't-early', firstSeen: 20, lastSeen: 30, taskLabel: 'AGT-9' },
      // Rails belong to every task, so they are not a lane of their own.
      { id: 'human', role: 'human', taskId: 't-early', firstSeen: 1, lastSeen: 1 },
    ]);
    expect(lanes.map((lane: { taskId: string }) => lane.taskId)).toEqual(['t-early', 't-late']);
    expect(lanes[0]).toMatchObject({ label: 'AGT-9', count: 2, firstSeen: 10, lastSeen: 30 });
  });

  // A node from before `firstSeen` existed would otherwise put NaN into the
  // comparator, and a NaN comparator makes the lane order arbitrary rather
  // than merely wrong — the failure would be invisible and irreproducible.
  it('falls back for legacy nodes rather than comparing NaN', () => {
    const lanes = taskLanesOf([
      { id: 'a', role: 'worker', taskId: 't-b', lastSeen: 20 },
      { id: 'b', role: 'worker', taskId: 't-a', lastSeen: 10 },
    ]);
    expect(lanes.every((lane: { firstSeen: number }) => Number.isFinite(lane.firstSeen))).toBe(true);
    expect(lanes.map((lane: { taskId: string }) => lane.taskId)).toEqual(['t-a', 't-b']);
  });
});
