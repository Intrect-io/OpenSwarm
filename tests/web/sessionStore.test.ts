// Cockpit session state machine (INT-3402). Under tests/ because it imports a
// browser ESM asset; `tsc -p .` only covers src/.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { SessionStore, TERMINAL_PHASES } from '../../web/static/js/sessionStore.mjs';

const stage = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  stage: 'worker',
  status: 'start',
  ...over,
});

describe('SessionStore', () => {
  it('creates a session from task:queued and promotes it through the phases', () => {
    const store = new SessionStore();
    store.applyEvent('task:queued', { taskId: 't1', title: 'Task', projectPath: '/repo' });
    expect(store.get('t1')).toMatchObject({ phase: 'queued', title: 'Task', projectPath: '/repo' });

    store.applyEvent('task:started', { taskId: 't1', title: 'Task' });
    expect(store.get('t1').phase).toBe('running');

    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 1000 });
    expect(store.get('t1')).toMatchObject({ phase: 'completed', durationMs: 1000 });
  });

  it('creates a session from a stage event alone (replay lost the lifecycle)', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage({ issueIdentifier: 'INT-1', title: 'From stage' }));
    expect(store.get('t1')).toMatchObject({ phase: 'running', issueIdentifier: 'INT-1', title: 'From stage' });
  });

  it('refuses phase regressions so replayed events cannot resurrect a finished session', () => {
    const store = new SessionStore();
    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 5 });
    // The SSE replay re-delivers older events after the snapshot seeded us.
    // Only task:started may re-open a session (a real retry) — see below.
    store.applyEvent('task:queued', { taskId: 't1', title: 'Task' });
    store.applyEvent('pipeline:stage', stage());
    store.applyEvent('pipeline:iteration', { taskId: 't1', iteration: 2 });
    expect(store.get('t1').phase).toBe('completed');
    expect(TERMINAL_PHASES.has(store.get('t1').phase)).toBe(true);
  });

  it('lets task:started re-open a finished session — the daemon retries the same id', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage({ status: 'fail', error: 'attempt 1 blew up' }));
    store.applyEvent('task:completed', { taskId: 't1', success: false, duration: 3_000 });
    expect(store.get('t1').phase).toBe('failed');

    store.applyEvent('task:started', { taskId: 't1', title: 'Task' });

    const session = store.get('t1');
    expect(session.phase).toBe('running');
    // Last attempt's outcome must not sit next to live work.
    expect(session.error).toBeUndefined();
    expect(session.durationMs).toBeUndefined();
    expect(session.stages.size).toBe(0);
  });

  it('does NOT let a replayed stage event re-open a finished session', () => {
    const store = new SessionStore();
    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 10 });
    store.applyEvent('pipeline:stage', stage({ status: 'start' }));
    expect(store.get('t1').phase).toBe('completed');
  });

  it('folds stages idempotently and keeps prior detail on re-application', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage({ status: 'start' }));
    store.applyEvent('pipeline:stage', stage({
      status: 'complete',
      durationMs: 8_000,
      costUsd: 0.4,
      summary: 'did the thing',
      filesChanged: ['a.ts'],
    }));
    // A replayed 'start' must not erase the completion detail.
    store.applyEvent('pipeline:stage', stage({ status: 'start' }));

    const worker = store.get('t1').stages.get('worker');
    expect(worker).toMatchObject({ durationMs: 8_000, costUsd: 0.4, summary: 'did the thing' });
    expect(store.get('t1').stages.size).toBe(1);
  });

  it('keeps a session running when a STAGE fails — the pipeline iterates', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage({ status: 'fail', error: 'reviewer said revise' }));
    // Only task:completed decides the outcome; a failed reviewer stage is a
    // normal step on the way to success.
    expect(store.get('t1')).toMatchObject({ phase: 'running', error: 'reviewer said revise' });

    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 9 });
    expect(store.get('t1').phase).toBe('completed');
  });

  it('treats the first terminal outcome as final against a replayed second one', () => {
    const store = new SessionStore();
    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 9 });
    // A replayed stage failure (or a duplicate completion) must not rewrite
    // how this session ended.
    store.applyEvent('pipeline:stage', stage({ status: 'fail', error: 'stale failure' }));
    store.applyEvent('task:completed', { taskId: 't1', success: false, duration: 1 });
    expect(store.get('t1').phase).toBe('completed');
  });

  it('ignores empty patch values so a sparse event cannot blank known metadata', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage({ model: 'gpt-5.5', title: 'Real title' }));
    store.applyEvent('pipeline:stage', stage({ model: '', title: undefined }));
    expect(store.get('t1')).toMatchObject({ model: 'gpt-5.5', title: 'Real title' });
  });

  it('tracks cost and escalation', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', stage());
    store.applyEvent('pipeline:escalation', { taskId: 't1', toModel: 'gpt-5.5-high' });
    store.applyEvent('task:cost', { taskId: 't1', cost: { costUsd: 1.25, inputTokens: 10, outputTokens: 3 } });
    expect(store.get('t1')).toMatchObject({ model: 'gpt-5.5-high', costUsd: 1.25, inputTokens: 10 });
  });

  it('ignores unknown event types and malformed payloads', () => {
    const store = new SessionStore();
    store.applyEvent('log', { taskId: 't1', line: 'x' }); // transcript owns this
    store.applyEvent('some:future:event', { taskId: 't1' });
    store.applyEvent('task:started', {});
    store.applyEvent('task:started', null);
    expect(store.list()).toHaveLength(0);
  });

  it('seeds running/queued/recent from the sessions snapshot', () => {
    const store = new SessionStore();
    store.seed({
      sessions: [
        { taskId: 'r1', status: 'running', title: 'Running', projectPath: '/repo', stage: 'worker', branch: 'swarm/x' },
        { taskId: 'q1', status: 'queued', title: 'Queued', projectPath: '/repo' },
      ],
      recent: [
        { taskId: 'd1', status: 'failed', title: 'Failed', projectPath: '/repo', failureCause: 'timeout' },
        { taskId: 'p1', status: 'decomposed', title: 'Parent', projectPath: '/repo' },
      ],
    });
    expect(store.get('r1')).toMatchObject({ phase: 'running', currentStage: 'worker', branch: 'swarm/x' });
    expect(store.get('q1').phase).toBe('queued');
    expect(store.get('d1')).toMatchObject({ phase: 'failed', failureCause: 'timeout' });
    expect(store.get('p1').phase).toBe('decomposed');
    expect(store.byProject('/repo')).toHaveLength(4);
  });

  it('does not let a snapshot roll back a live session', () => {
    const store = new SessionStore();
    store.applyEvent('task:completed', { taskId: 'r1', success: true, duration: 1 });
    // Snapshot fetched before the completion lands afterwards.
    store.seed({ sessions: [{ taskId: 'r1', status: 'running', title: 'Running', projectPath: '/repo' }], recent: [] });
    expect(store.get('r1').phase).toBe('completed');
  });

  it('emits session:new once and session:phase only on real transitions', () => {
    const store = new SessionStore();
    const created: string[] = [];
    const phases: string[] = [];
    store.addEventListener('session:new', (e: CustomEvent) => created.push(e.detail.session.taskId));
    store.addEventListener('session:phase', (e: CustomEvent) => phases.push(e.detail.session.phase));

    store.applyEvent('task:queued', { taskId: 't1', title: 'T', projectPath: '/repo' });
    store.applyEvent('task:started', { taskId: 't1', title: 'T' });
    store.applyEvent('pipeline:stage', stage()); // still running — no transition
    store.applyEvent('task:completed', { taskId: 't1', success: false, duration: 2 });

    expect(created).toEqual(['t1']);
    expect(phases).toEqual(['running', 'failed']);
  });

  it('lists most recently updated first', () => {
    const store = new SessionStore();
    store.applyEvent('task:queued', { taskId: 'old', title: 'Old', projectPath: '/repo' });
    store.applyEvent('task:queued', { taskId: 'new', title: 'New', projectPath: '/repo' });
    store.applyEvent('pipeline:stage', stage({ taskId: 'old' }));
    expect(store.list().map((s: { taskId: string }) => s.taskId)).toEqual(['old', 'new']);
  });
});

describe('SessionStore — path and terminal semantics (INT-3402 review)', () => {
  it('groups by REPOSITORY, not by the per-task worktree the stage reports', () => {
    const store = new SessionStore();
    // Stage events report the ACTIVE directory, which in worktree mode is the
    // task's own worktree — grouping on it would give every task its own node.
    store.applyEvent('pipeline:stage', {
      taskId: 't1', stage: 'worker', status: 'start',
      projectPath: '/repo/worktree/t1', worktree: 't1',
    });
    store.applyEvent('pipeline:stage', {
      taskId: 't2', stage: 'worker', status: 'start',
      projectPath: '/repo/worktree/t2', worktree: 't2',
    });

    expect(store.byProject('/repo')).toHaveLength(2);
    expect(store.get('t1')).toMatchObject({
      projectPath: '/repo',
      worktreePath: '/repo/worktree/t1',
      worktreeName: 't1', // the short label, never the path
    });
  });

  it('keeps a non-worktree project path as-is', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', projectPath: '/repo' });
    expect(store.get('t1').projectPath).toBe('/repo');
    expect(store.get('t1').worktreePath).toBeUndefined();
  });

  it('does not let a stage overwrite the seeded worktree path', () => {
    const store = new SessionStore();
    store.seed({
      sessions: [{ taskId: 't1', status: 'running', title: 'T', projectPath: '/repo', worktreePath: '/real/worktree/path' }],
      recent: [],
    });
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', projectPath: '/repo' });
    expect(store.get('t1').worktreePath).toBe('/real/worktree/path');
  });

  it('clears a stage error once the task completes successfully', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'reviewer', status: 'fail', error: 'revise' });
    store.applyEvent('task:completed', { taskId: 't1', success: true, duration: 5 });
    expect(store.get('t1').error).toBeUndefined();
  });

  it('lets daemon history refine one terminal phase into a more specific one', () => {
    const store = new SessionStore();
    // A decomposition reports success, so the live event says "completed".
    store.applyEvent('task:completed', { taskId: 'parent', success: true, duration: 5 });
    store.seed({
      sessions: [],
      recent: [{ taskId: 'parent', status: 'decomposed', title: 'Parent', projectPath: '/repo' }],
    });
    expect(store.get('parent').phase).toBe('decomposed');
  });

  it('history never overwrites metadata a newer attempt reported live', () => {
    const store = new SessionStore();
    store.applyEvent('pipeline:stage', {
      taskId: 't1', stage: 'worker', status: 'start', title: 'Live title', projectPath: '/repo',
    });
    store.seed({
      sessions: [],
      recent: [{ taskId: 't1', status: 'failed', title: 'Stale title', projectPath: '/old', failureCause: 'timeout' }],
    });
    const session = store.get('t1');
    expect(session.title).toBe('Live title');
    expect(session.projectPath).toBe('/repo');
    expect(session.failureCause).toBe('timeout'); // gaps still get filled
  });
});

describe('terminal refinement is narrow (INT-3402 review)', () => {
  it('does not let older history overwrite a newer live outcome', () => {
    const store = new SessionStore();
    // A fresh attempt just failed…
    store.applyEvent('task:completed', { taskId: 't1', success: false, duration: 3 });
    // …while history still remembers the previous attempt succeeding.
    store.seed({ sessions: [], recent: [{ taskId: 't1', status: 'completed', title: 'T', projectPath: '/repo' }] });
    expect(store.get('t1').phase).toBe('failed');
  });

  it('only refines the completed → decomposed case', () => {
    const store = new SessionStore();
    store.applyEvent('task:completed', { taskId: 'a', success: true, duration: 1 });
    store.applyEvent('task:completed', { taskId: 'b', success: false, duration: 1 });
    store.seed({
      sessions: [],
      recent: [
        { taskId: 'a', status: 'decomposed', title: 'A', projectPath: '/repo' },
        // failed → decomposed is not a refinement; the live outcome stands.
        { taskId: 'b', status: 'decomposed', title: 'B', projectPath: '/repo' },
      ],
    });
    expect(store.get('a').phase).toBe('decomposed');
    expect(store.get('b').phase).toBe('failed');
  });
});
