import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
// The durable trace lives in the automation database, which vitest.setup points
// at one path for the whole run. `postHumanQuestion` reads it, so without a
// database per test these suites answer each other's questions.
const ORIGINAL_AUTOMATION_DB = process.env.OPENSWARM_AUTOMATION_DB;
let dir = '';
afterEach(async () => {
  const store = await import('./coordinationStore.js');
  store.resetCoordinationStoreForTests();
  (await import('./coordinationTrace.js')).resetTraceDbForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL_AUTOMATION_DB;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function modules() {
  dir = mkdtempSync(join(tmpdir(), 'osw-human-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  const store = await import('./coordinationStore.js');
  store.resetCoordinationStoreForTests();
  (await import('./coordinationTrace.js')).resetTraceDbForTests();
  return import('./humanQuestions.js');
}

describe('human questions', () => {
  it('pages the operator and routes the answer back to the agent that asked', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'magos-corvax-vigilis',
      actorName: 'Magos Corvax-Vigilis', question: 'Which API?', notify,
    });
    expect(posted.delivered).toBe(true);
    expect(notify.mock.calls[0][0]).toContain(`!answer ${posted.correlationId}`);
    expect(notify.mock.calls[0][0]).toContain('Magos Corvax-Vigilis');

    const accepted = await h.answerHumanQuestion(posted.correlationId, 'Use v2', 'discord:user');
    expect(accepted.accepted).toBe(true);
    expect(accepted.event?.recipient).toBe('magos-corvax-vigilis');

    const second = await h.answerHumanQuestion(posted.correlationId, 'Use v1', 'discord:user');
    expect(second.accepted).toBe(false);
  });

  it('returns the existing answer instead of paging the operator twice', async () => {
    const h = await modules();
    const question = { repository: '/repo', taskId: 't1', actor: 'a', question: 'Ship?' };
    const first = await h.postHumanQuestion({ ...question, notify: async () => true });
    await h.answerHumanQuestion(first.correlationId, 'yes', 'discord:user');

    const notify = vi.fn(async () => true);
    const retry = await h.postHumanQuestion({ ...question, notify });
    expect(retry.answer).toBe('yes');
    expect(notify).not.toHaveBeenCalled();
  });

  it('reports that nobody was paged when the notifier cannot deliver', async () => {
    const h = await modules();
    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 't2', actor: 'a', question: 'Ship?', notify: async () => false,
    });
    expect(posted.delivered).toBe(false);
    expect(posted.answer).toBeUndefined();
  });

  it('pages the operator once per open question, but retries an undelivered page', async () => {
    const h = await modules();
    const question = { repository: '/repo', taskId: 't5', actor: 'a', question: 'Ship?' };

    // First ask: Discord down — no page landed.
    await h.postHumanQuestion({ ...question, notify: async () => false });

    // Re-dispatch while still undelivered: the page is retried and lands.
    const paged = vi.fn(async () => true);
    const second = await h.postHumanQuestion({ ...question, notify: paged });
    expect(second.delivered).toBe(true);
    expect(paged).toHaveBeenCalledTimes(1);

    // Further re-dispatches must not ping the operator again for the same
    // open question — that trains them to ignore the bot.
    const rePaged = vi.fn(async () => true);
    const third = await h.postHumanQuestion({ ...question, notify: rePaged });
    expect(third.delivered).toBe(true);
    expect(rePaged).not.toHaveBeenCalled();
  });

  it('records one waiting question even when the agent asks repeatedly', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const question = { repository: '/repo', taskId: 't3', actor: 'a', question: 'Ship?', notify: async () => true };
    await h.postHumanQuestion(question);
    await h.postHumanQuestion(question);
    const waiting = store.list({ repository: '/repo', taskId: 't3', limit: 50 })
      .filter((event) => event.kind === 'human-question' && event.status === 'waiting');
    expect(waiting).toHaveLength(1);
  });

  it('can still answer a question the board has evicted', async () => {
    // The whole point of keeping the exchange durable is that a reply works
    // whenever the operator gets to it. Resolving the question from memory alone
    // tells them it does not exist, and the agent stays parked forever.
    const h = await modules();
    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 't-gone', actor: 'worker-a', actorRole: 'worker' as const,
      question: 'Which spreadsheet?',
    });

    const file = join(dir, 'events.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.events = state.events.filter((event: { kind: string }) => event.kind !== 'human-question');
    writeFileSync(file, JSON.stringify(state));
    (await import('./coordinationStore.js')).resetCoordinationStoreForTests();

    const accepted = await h.answerHumanQuestion(posted.correlationId, 'The shared one.', 'operator-dashboard');
    expect(accepted.accepted).toBe(true);
    expect(accepted.event?.detail).toBe('The shared one.');
  });

  it('returns the answer even after the board has evicted it', async () => {
    // The heartbeat can bring a task forward on an answer it read from the
    // durable trace. If the retry then reads only the tail of the board it will
    // not see that answer, ask again, and park again — an attempt spent to end up
    // exactly where it started. Both readers have to look in the same place.
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const question = {
      repository: '/repo', taskId: 't-evicted', actor: 'worker-a', actorRole: 'worker' as const,
      question: 'Which credentials should I use?',
    };
    const posted = await h.postHumanQuestion(question);
    const accepted = await h.answerHumanQuestion(posted.correlationId, 'The mounted ones.', 'operator-dashboard');
    expect(accepted.accepted).toBe(true);

    // Drop the answer from the in-memory board, which is what the ring does to a
    // task that keeps talking. The durable trace still has it.
    const file = join(dir, 'events.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.events = state.events.filter((event: { kind: string }) => event.kind !== 'human-answer');
    writeFileSync(file, JSON.stringify(state));
    (await import('./coordinationStore.js')).resetCoordinationStoreForTests();

    const replay = await h.postHumanQuestion(question);
    expect(replay.delivered).toBe(true);
    expect(replay.answer).toBe('The mounted ones.');
    // And it did not ask a second time.
    expect(store.exchange(posted.correlationId)
      .filter((event) => event.kind === 'human-question')).toHaveLength(1);
  });
});
