import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { queryTrace, recordTraceEvent, resetTraceDbForTests, traceSize } from './coordinationTrace.js';
import type { CoordinationEvent } from './coordinationStore.js';

let root: string;

function event(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: `id-${Math.random()}`,
    seq: 1,
    timestamp: 1_000,
    repository: '/repo',
    taskId: 'task-1',
    taskLabel: 'AGT-1',
    actor: 'worker-a',
    actorName: 'Worker A',
    actorRole: 'worker',
    kind: 'advice-request',
    status: 'open',
    correlationId: 'corr-1',
    summary: 'need a decision',
    fingerprint: `fp-${Math.random()}`,
    ...overrides,
  };
}

describe('coordination trace', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trace-'));
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
    resetTraceDbForTests();
  });

  afterEach(() => {
    resetTraceDbForTests();
    delete process.env.OPENSWARM_AUTOMATION_DB;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps events the board would have evicted', () => {
    for (let i = 0; i < 2_500; i++) {
      recordTraceEvent(event({ id: `evt-${i}`, seq: i, summary: `event ${i}` }));
    }
    expect(traceSize()).toBe(2_500);
    // The board retains 2000; the very first event is long gone from it.
    const oldest = queryTrace({ taskId: 'task-1', limit: 1_000 })[0];
    expect(oldest.summary).toBe('event 1500');
    expect(queryTrace({ correlationId: 'corr-1', limit: 1 })).toHaveLength(1);
  });

  it('is idempotent on event id so a replayed publish does not duplicate', () => {
    const replayed = event({ id: 'stable' });
    recordTraceEvent(replayed);
    recordTraceEvent(replayed);
    expect(traceSize()).toBe(1);
  });

  it('round-trips optional fields and metadata', () => {
    recordTraceEvent(event({
      id: 'rich',
      recipient: 'reviewer-b',
      recipientName: 'Reviewer B',
      recipientRole: 'reviewer',
      detail: 'the long form',
      metadata: { digest: 'abc', sourceCount: 3 },
    }));
    const [stored] = queryTrace({ correlationId: 'corr-1' });
    expect(stored).toMatchObject({
      recipient: 'reviewer-b',
      recipientRole: 'reviewer',
      taskLabel: 'AGT-1',
      detail: 'the long form',
      metadata: { digest: 'abc', sourceCount: 3 },
    });
  });

  it('filters by participant across actor and recipient', () => {
    recordTraceEvent(event({ id: 'a', actor: 'worker-a', recipient: 'reviewer-b' }));
    recordTraceEvent(event({ id: 'b', actor: 'reviewer-b', recipient: 'worker-a' }));
    recordTraceEvent(event({ id: 'c', actor: 'other', recipient: 'someone' }));
    expect(queryTrace({ actor: 'worker-a' }).map((item) => item.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty trace instead of throwing when the database cannot open', () => {
    resetTraceDbForTests();
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'missing-dir', 'automation.db');
    expect(() => recordTraceEvent(event())).not.toThrow();
    expect(queryTrace()).toEqual([]);
  });
});

describe('trace repository filtering', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trace-repo-'));
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
    resetTraceDbForTests();
  });

  afterEach(() => {
    resetTraceDbForTests();
    delete process.env.OPENSWARM_AUTOMATION_DB;
    rmSync(root, { recursive: true, force: true });
  });

  it('matches a repository filter that is not already resolved', () => {
    recordTraceEvent(event({ id: 'r1', repository: resolve('/repo/nested') }));
    expect(queryTrace({ repository: '/repo/other/../nested' }).map((item) => item.id)).toEqual(['r1']);
  });
});
