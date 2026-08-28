import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultAutomationDbPath, setAutomationDbPath } from '../automation/automationDbPath.js';

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

  it('creates the state directory rather than degrading on a fresh install', () => {
    // better-sqlite3 will not create the parent directory, and ~/.openswarm
    // does not exist before the first run — without the mkdir the trace was
    // silently unavailable on exactly the deployments that had recorded
    // nothing yet.
    resetTraceDbForTests();
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'never-created', 'automation.db');
    recordTraceEvent(event({ id: 'fresh' }));
    expect(queryTrace().map((item) => item.id)).toEqual(['fresh']);
  });

  it('returns an empty trace instead of throwing when the database cannot open', () => {
    resetTraceDbForTests();
    // A path whose parent is a regular file: mkdir cannot fix that, so the
    // trace has to degrade rather than take the publish down with it.
    writeFileSync(join(root, 'blocker'), 'not a directory');
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'blocker', 'automation.db');
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

describe('where the trace stores what it knows', () => {
  // The runs and the answers about them have to live in one file. These cases
  // run with the environment override cleared — the thing under test is what
  // happens without it — so HOME is redirected too: a broken wiring must land in
  // a temporary directory, never in the operator's real automation database.
  let root: string;
  let savedDb: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trace-path-'));
    savedDb = process.env.OPENSWARM_AUTOMATION_DB;
    savedHome = process.env.HOME;
    delete process.env.OPENSWARM_AUTOMATION_DB;
    process.env.HOME = join(root, 'home');
    setAutomationDbPath(undefined);
    resetTraceDbForTests();
  });

  afterEach(() => {
    resetTraceDbForTests();
    setAutomationDbPath(undefined);
    if (savedDb === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
    else process.env.OPENSWARM_AUTOMATION_DB = savedDb;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('records into the database this deployment configured', () => {
    const configured = join(root, 'relocated', 'automation.db');
    setAutomationDbPath(configured);

    recordTraceEvent(event({ id: 'configured-1' }));

    expect(existsSync(configured)).toBe(true);
    expect(existsSync(join(root, 'home', '.openswarm', 'automation.db'))).toBe(false);
  });

  it('still lets the environment override win, so tests can redirect every store', () => {
    const configured = join(root, 'relocated', 'automation.db');
    const override = join(root, 'override', 'automation.db');
    mkdirSync(dirname(override), { recursive: true });
    setAutomationDbPath(configured);
    process.env.OPENSWARM_AUTOMATION_DB = override;

    recordTraceEvent(event({ id: 'override-1' }));

    expect(existsSync(override)).toBe(true);
    expect(existsSync(configured)).toBe(false);
  });

  it('prefers a configured path over the home-directory default', () => {
    const configured = join(root, 'runner', 'automation.db');
    setAutomationDbPath(configured);

    expect(defaultAutomationDbPath()).toBe(configured);
  });
});
