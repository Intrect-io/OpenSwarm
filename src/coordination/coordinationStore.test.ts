import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinationStore } from './coordinationStore.js';
import { withFileLock } from '../support/fileLock.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
function store() { dir = mkdtempSync(join(tmpdir(), 'osw-coordination-')); return new CoordinationStore(join(dir, 'events.json')); }
function message(over: Record<string, unknown> = {}) {
  return { repository: '/repo', taskId: 't1', actor: 'worker-a', recipient: 'worker-b', kind: 'advice-request' as const, status: 'open' as const, correlationId: 'c1', summary: 'review this approach', ...over };
}

describe('CoordinationStore', () => {
  it('recovers full operator answers after board eviction/restart and dedupes sibling settlements', async () => {
    const s = store();
    const file = join(dir, 'events.json');
    const previousDb = process.env.OPENSWARM_AUTOMATION_DB;
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
    const trace = await import('./coordinationTrace.js');
    trace.resetTraceDbForTests();
    try {
      const taskId = 'AX-1075';
      await s.publish(message({
        taskId, kind: 'human-question', status: 'waiting', correlationId: 'hq-attempt-5',
        summary: 'Should we add a due_date rule?',
      }));
      await s.publish(message({
        taskId, kind: 'human-question', status: 'waiting', correlationId: 'hq-attempt-9',
        summary: 'Which cutoff path should the retry use?',
      }));
      const detail = 'Use the canonical monthly_cutoff path. Do not create a due_date rule.';
      for (const correlationId of ['hq-attempt-5', 'hq-attempt-9']) {
        await s.publish(message({
          taskId, kind: 'human-answer', status: 'completed', correlationId,
          summary: 'operator answered', detail, metadata: { answerSetId: 'hq-attempt-5' },
        }));
      }

      // Simulate ring eviction, then construct a fresh process-facing store.
      const state = JSON.parse(readFileSync(file, 'utf8'));
      state.events = [];
      writeFileSync(file, JSON.stringify(state));
      trace.resetTraceDbForTests();
      const restarted = new CoordinationStore(file);

      const resolved = restarted.resolvedHumanAnswers(taskId);
      expect(resolved).toEqual([expect.objectContaining({
        correlationIds: ['hq-attempt-5', 'hq-attempt-9'],
        questions: ['Should we add a due_date rule?', 'Which cutoff path should the retry use?'],
        answer: detail,
      })]);
      const { formatAuthoritativeOperatorFeedback } = await import('./operatorGuidance.js');
      const formatted = formatAuthoritativeOperatorFeedback(resolved)!;
      expect(formatted).toContain(detail);
      expect(formatted.match(/canonical monthly_cutoff/g)).toHaveLength(1);
      expect(formatted).toContain('hq-attempt-5, hq-attempt-9');
    } finally {
      if (previousDb === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
      else process.env.OPENSWARM_AUTOMATION_DB = previousDb;
      trace.resetTraceDbForTests();
    }
  });

  it('knows a question is answered after the ring has evicted it', async () => {
    // The in-memory board is a ring. A task that has been chatty pushes its own
    // exchange out of it, and a decision read only from memory would call a
    // still-blocked run ready — or a resolved one blocked. The durable trace is a
    // table, not a ring, and it is counted rather than fetched so no window
    // applies. Eviction is simulated by dropping the event from the file, which
    // is the same end state as publishing two thousand more.
    const s = store();
    const taskId = `thread-${Math.random().toString(16).slice(2)}`;
    // A correlation id of its own for the same reason as the task id: the trace
    // outlives one store instance, so a shared id matches another suite's answer.
    const exchangeId = `${taskId}-q1`;
    await s.publish(message({
      taskId, kind: 'human-question', status: 'waiting', correlationId: exchangeId, summary: 'Which credentials?',
    }));
    expect(s.allQuestionsAnswered(taskId)).toBe(false);

    const answer = await s.publish(message({
      taskId, kind: 'human-answer', status: 'completed', correlationId: exchangeId,
      summary: 'answered', detail: 'The mounted ones.',
    }));
    const file = join(dir, 'events.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.events = state.events.filter((event: { kind: string }) => event.kind === 'human-answer');
    writeFileSync(file, JSON.stringify(state));

    expect(s.allQuestionsAnswered(taskId)).toBe(true);
    // And the exchange itself is still whole, which is what a retry replays from.
    expect(s.exchange(exchangeId).map((event) => event.kind)).toEqual(['human-question', 'human-answer']);
    expect(new Set(s.exchange(exchangeId).map((event) => event.id)).size).toBe(2);
    expect(answer.correlationId).toBe(exchangeId);
  });

  it('says no rather than guessing when the durable store is unavailable', async () => {
    // The in-memory board is a ring, so falling back to it would give exactly the
    // false "everything is answered" this query exists to prevent. Saying no
    // costs a task its early re-admission and it waits out its backoff, which is
    // what happened before any of this existed.
    const s = store();
    const taskId = `nodb-${Math.random().toString(16).slice(2)}`;
    await s.publish(message({ taskId, kind: 'human-question', status: 'waiting', correlationId: `${taskId}-q` }));
    await s.publish(message({ taskId, kind: 'human-answer', status: 'completed', correlationId: `${taskId}-q` }));
    expect(s.allQuestionsAnswered(taskId)).toBe(true);

    // Point the trace at a path it cannot open, the way a broken deployment would.
    const previous = process.env.OPENSWARM_AUTOMATION_DB;
    const blocked = join(dir, 'events.json', 'automation.db'); // a file, not a directory
    process.env.OPENSWARM_AUTOMATION_DB = blocked;
    const trace = await import('./coordinationTrace.js');
    trace.resetTraceDbForTests();
    try {
      expect(s.allQuestionsAnswered(taskId)).toBe(false);
    } finally {
      process.env.OPENSWARM_AUTOMATION_DB = previous;
      trace.resetTraceDbForTests();
    }
  });

  it('does not count an answer that never landed', async () => {
    // The replay in `askHuman` accepts a completed answer and nothing else, so
    // counting a failed or expired one here would release the run into the same
    // open question and park it again, an attempt spent for nothing.
    const s = store();
    const taskId = `failed-${Math.random().toString(16).slice(2)}`;
    await s.publish(message({ taskId, kind: 'human-question', status: 'waiting', correlationId: `${taskId}-q` }));
    await s.publish(message({ taskId, kind: 'human-answer', status: 'failed', correlationId: `${taskId}-q` }));

    expect(s.allQuestionsAnswered(taskId)).toBe(false);
  });

  it('does not accept another task\'s answer as this one\'s', async () => {
    // Correlation ids are content-derived and unique in practice, but nothing in
    // the schema says so — and pairing on the id alone would let one task's
    // answer release a run parked on another's identical question.
    const s = store();
    const shared = `shared-${Math.random().toString(16).slice(2)}`;
    await s.publish(message({ taskId: `${shared}-mine`, kind: 'human-question', status: 'waiting', correlationId: shared }));
    await s.publish(message({ taskId: `${shared}-theirs`, kind: 'human-answer', status: 'completed', correlationId: shared }));

    expect(s.allQuestionsAnswered(`${shared}-mine`)).toBe(false);
  });

  it('does not call a task with a second unanswered question ready', async () => {
    // Several agents can run on one task, so an answer to one does not release a
    // run parked on another's question.
    const s = store();
    const taskId = `two-${Math.random().toString(16).slice(2)}`;
    await s.publish(message({ taskId, kind: 'human-question', status: 'waiting', correlationId: `${taskId}-a` }));
    await s.publish(message({ taskId, kind: 'human-answer', status: 'completed', correlationId: `${taskId}-a` }));
    expect(s.allQuestionsAnswered(taskId)).toBe(true);

    await s.publish(message({ taskId, kind: 'human-question', status: 'waiting', correlationId: `${taskId}-b` }));
    expect(s.allQuestionsAnswered(taskId)).toBe(false);
  });

  it('deduplicates publications and assigns monotonic sequences', async () => {
    const s = store();
    const first = await s.publish(message());
    const duplicate = await s.publish(message());
    const second = await s.publish(message({ correlationId: 'c2' }));
    expect(duplicate.id).toBe(first.id);
    expect(second.seq).toBe(first.seq + 1);
    expect(s.list()).toHaveLength(2);
  });

  it('announces a message once, so an imported event is not echoed back', async () => {
    // The Linear board mirror republishes whatever 'coordination:published'
    // reports. Startup imports remote comments through publish(); announcing a
    // deduplicated event would post it straight back to the board it came from.
    const s = store();
    const { getEventHub } = await import('../core/eventHub.js');
    const announced: unknown[] = [];
    const listener = (event: unknown) => announced.push(event);
    getEventHub().on('coordination:published', listener);
    try {
      await s.publish(message());
      await s.publish(message());
      expect(announced).toHaveLength(1);
    } finally {
      getEventHub().off('coordination:published', listener);
    }
  });

  it('waits for a lock another process holds before touching the board', async () => {
    // A daemon and a standalone `openswarm review` are separate OS processes:
    // their read-modify-write cycles genuinely interleave, and the loser's
    // event disappears while its sequence number is reused. Only the file lock
    // orders them, so assert the store actually blocks on a held lock.
    const cli = store();
    const lockPath = `${join(dir, 'events.json')}.lock`;

    let settled = false;
    let pending!: Promise<unknown>;
    await withFileLock(lockPath, async () => {
      pending = cli.publish(message({ correlationId: 'contended' }));
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(settled).toBe(false);
    });

    await pending;
    expect(settled).toBe(true);
    expect(cli.list({ limit: 10 })).toHaveLength(1);
  });

  it('consumes targeted messages at most once across store reopen', async () => {
    const s = store();
    await s.publish(message());
    expect(await s.consume('worker-b', { repository: '/repo' })).toHaveLength(1);
    const reopened = new CoordinationStore(join(dir, 'events.json'));
    expect(await reopened.consume('worker-b', { repository: '/repo' })).toEqual([]);
  });

  it('routes cross-task mail by target task and preserves exactly-once delivery across reopen', async () => {
    const s = store();
    await s.publish(message({
      repoKey: 'git:shared', taskId: 'task-a', sourceTaskId: 'task-a',
      targetTaskId: 'task-b', actor: 'same-handle', recipient: 'same-handle',
    }));

    expect(await s.consume('same-handle', { repository: '/repo', repoKey: 'git:shared', taskId: 'task-a' })).toEqual([]);
    expect(await s.consume('same-handle', { repository: '/repo', repoKey: 'git:shared', taskId: 'task-b' })).toHaveLength(1);
    const reopened = new CoordinationStore(join(dir, 'events.json'));
    expect(await reopened.consume('same-handle', { repository: '/repo', repoKey: 'git:shared', taskId: 'task-b' })).toEqual([]);
  });

  it('keeps consumed identity scoped when the same address exists on two tasks', async () => {
    const s = store();
    await s.publish(message({ repoKey: 'git:shared', targetTaskId: 'task-a', correlationId: 'for-a' }));
    await s.publish(message({ repoKey: 'git:shared', targetTaskId: 'task-b', correlationId: 'for-b' }));
    expect((await s.consume('worker-b', { repository: '/repo', repoKey: 'git:shared', taskId: 'task-a' }))[0].correlationId).toBe('for-a');
    expect((await s.consume('worker-b', { repository: '/repo', repoKey: 'git:shared', taskId: 'task-b' }))[0].correlationId).toBe('for-b');
  });

  it('does not deduplicate envelopes addressed to different target tasks', async () => {
    const s = store();
    await s.publish(message({ repoKey: 'git:shared', targetTaskId: 'task-a' }));
    await s.publish(message({ repoKey: 'git:shared', targetTaskId: 'task-b' }));
    expect(s.list()).toHaveLength(2);
  });

  it('redacts secret fields and values before persistence', async () => {
    const s = store();
    await s.publish(message({ detail: 'Bearer abcdefghijk', metadata: { apiKey: 'secret', note: 'ghp_abcdefghijk' } }));
    const raw = readFileSync(join(dir, 'events.json'), 'utf8');
    expect(raw).not.toContain('abcdefghijk');
    expect(raw).not.toContain('secret');
    expect(raw).toContain('[redacted]');
    expect(statSync(join(dir, 'events.json')).mode & 0o777).toBe(0o600);
  });

  it('fails closed on corrupt persisted state', () => {
    const s = store();
    writeFileSync(join(dir, 'events.json'), '{bad json');
    expect(() => s.list()).toThrow('Coordination store is corrupt');
  });

  it('folds terminal correlation state out of pending', async () => {
    const s = store();
    await s.publish(message());
    await s.publish(message({ actor: 'worker-b', recipient: 'worker-a', kind: 'advice-response', status: 'completed', summary: 'use the existing helper' }));
    expect(s.snapshot('/repo').pending).toEqual([]);
  });

  it('counts distinct open questions regardless of paging status or wording', async () => {
    const s = store();
    await s.publish(message({ kind: 'human-question', status: 'waiting', correlationId: 'q1' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(1);

    await s.publish(message({ kind: 'human-question', status: 'running', correlationId: 'q1', summary: 'Operator paged' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(1); // page confirmation, same question

    await s.publish(message({ kind: 'human-question', status: 'waiting', correlationId: 'q2', summary: 'reworded ask' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(2);

    await s.publish(message({ kind: 'human-answer', status: 'completed', correlationId: 'q1' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(1); // q1 settled, q2 still open

    await s.publish(message({ kind: 'human-answer', status: 'completed', correlationId: 'q2' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(0);
  });

  it('scopes the open question count to its own repository and task', async () => {
    const s = store();
    await s.publish(message({ kind: 'human-question', status: 'waiting', correlationId: 'q1' }));
    await s.publish(message({ repository: '/other', kind: 'human-question', status: 'waiting', correlationId: 'q2' }));
    await s.publish(message({ taskId: 't2', kind: 'human-question', status: 'waiting', correlationId: 'q3' }));
    expect(s.openQuestionCount('/repo', 't1')).toBe(1);
  });
});
