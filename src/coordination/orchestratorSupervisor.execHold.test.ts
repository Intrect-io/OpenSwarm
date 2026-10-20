// ============================================
// OpenSwarm — selectOrchestratorItems under an exec hold
// ============================================
//
// `openswarm exec --issue` parks a run for an external orchestrator to answer.
// The supervisor is a second, in-process answerer: it sweeps the board for
// `human-question` events and its model may call `coordination_answer_question`,
// which would resume the run behind the agent that is waiting on `exec await`.
// `selectOrchestratorItems` is the first half of the guard — it drops events
// whose task an external orchestrator holds.
//
// It lives in its own file rather than in `orchestratorSupervisor.test.ts`
// because the only case that reads the hold store (the omitted-third-argument
// regression) needs `OPENSWARM_AUTOMATION_DB` pinned to a temp database, and
// that file deliberately does not redirect it. The pure cases inject the set
// directly, so the file's fixtures are the same shape the sibling file uses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoordinationEvent } from './coordinationStore.js';
import { selectOrchestratorItems } from './orchestratorSupervisor.js';
import { markExecHold, resetExecHoldForTests } from '../automation/execHold.js';

const originalAutomationDb = process.env.OPENSWARM_AUTOMATION_DB;
let dir = '';

function event(over: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'event-1',
    seq: 1,
    timestamp: 1,
    repository: '/repo',
    taskId: 'task-1',
    actor: 'worker-a',
    actorName: 'Worker A',
    kind: 'advice-request',
    status: 'open',
    correlationId: 'thread-1',
    summary: 'Which shared helper should I use?',
    fingerprint: 'fingerprint-1',
    ...over,
  };
}

/** A worker blocker for `taskId`, the event the hold exists to keep off the supervisor's board. */
function question(taskId: string, correlationId: string, over: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return event({ kind: 'human-question', status: 'waiting', taskId, correlationId, ...over });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osw-supervisor-exechold-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  resetExecHoldForTests();
});

afterEach(() => {
  resetExecHoldForTests();
  if (originalAutomationDb === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
  else process.env.OPENSWARM_AUTOMATION_DB = originalAutomationDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('selectOrchestratorItems under an exec hold', () => {
  it('drops a waiting human-question whose task an external orchestrator holds', () => {
    const blocked = question('T1', 'hq-t1');

    expect(selectOrchestratorItems([blocked], 0, new Set(['T1']))).toEqual([]);
    // The control: identical event, empty set. The gate is the set, not the
    // fixture — without this the case above would pass on a broken event too.
    expect(selectOrchestratorItems([blocked], 0, new Set())).toEqual([blocked]);
  });

  it('applies the hold per task when one call carries several questions', () => {
    const blocked = question('T1', 'hq-t1');
    const passThrough = question('T2', 'hq-t2');

    // One call, both questions: a coarsely-applied filter (drop the batch, or
    // drop by index) would take the unheld T2 with it.
    expect(selectOrchestratorItems([blocked, passThrough], 0, new Set(['T1']))).toEqual([passThrough]);
  });

  it('keeps an event that names no task even while a hold is in force', () => {
    // `taskId` is a required field, so "no task" is the empty string on a
    // board-level event. The filter must only act on events that name one.
    const boardWide = event({ taskId: '', kind: 'thread-update', status: 'open', correlationId: 'board-wide' });

    expect(selectOrchestratorItems([boardWide], 0, new Set(['T1']))).toEqual([boardWide]);
  });

  it('keeps the omitted third argument behaviourally transparent when nothing is held', () => {
    // The default path now consults the hold store, so this is the regression
    // that matters: with an empty store the two calls must agree exactly.
    const events = [
      question('T1', 'hq-t1'),
      event({ id: 'open', seq: 2, correlationId: 'open-request', fingerprint: 'open-fingerprint' }),
      event({
        id: 'late', seq: 3, kind: 'advice-response', status: 'completed',
        correlationId: 'late-response', fingerprint: 'late-fingerprint',
      }),
      event({ id: 'board', seq: 4, taskId: '', kind: 'thread-update', status: 'open', correlationId: 'board-wide' }),
    ];

    const implicit = selectOrchestratorItems(events);
    const explicit = selectOrchestratorItems(events, 0, new Set());

    expect(implicit).not.toEqual([]);
    expect(implicit).toEqual(explicit);
  });

  it('drops a held task even when its event is an otherwise one-shot terminal follow-up', () => {
    // `advice-response`/`completed` past the handled cursor is actionable via
    // the one-shot branch, so the hold has to be checked before that branch,
    // not only on the open/waiting/running disjunct.
    const lateResponse = event({
      id: 'late', seq: 7, taskId: 'T1', kind: 'advice-response', status: 'completed',
      correlationId: 'late-response', fingerprint: 'late-fingerprint',
    });

    expect(selectOrchestratorItems([lateResponse], 0, new Set())).toEqual([lateResponse]);
    expect(selectOrchestratorItems([lateResponse], 0, new Set(['T1']))).toEqual([]);
  });

  it('reads the hold store once for the omitted argument, and a real hold suppresses the event', () => {
    markExecHold('T1', 'external:cli');
    const blocked = question('T1', 'hq-t1');
    const passThrough = question('T2', 'hq-t2');

    expect(selectOrchestratorItems([blocked, passThrough])).toEqual([passThrough]);
    expect(selectOrchestratorItems([blocked, passThrough], 0, new Set(['T1']))).toEqual([passThrough]);
  });
});
