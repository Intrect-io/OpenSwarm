// @vitest-environment jsdom
//
// The orchestration graph is an aggregation, and a wrong aggregation lies
// about the swarm: a duplicated edge inflates interaction volume, a stale
// pending count keeps a settled question pulsing, and a lost role paints a
// reviewer as a generic agent.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { buildOrchestrationModel, dominantKind, KIND_COLORS } from '../../web/static/js/orchestrationModel.mjs';

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

  it('tracks the task a node last ACTED in, ignoring tasks it merely received from', () => {
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
});
