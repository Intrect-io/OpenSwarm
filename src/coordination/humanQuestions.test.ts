import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(async () => {
  const store = await import('./coordinationStore.js');
  store.resetCoordinationStoreForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function modules() {
  dir = mkdtempSync(join(tmpdir(), 'osw-human-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
  const store = await import('./coordinationStore.js');
  store.resetCoordinationStoreForTests();
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

  it('does not re-page when a re-dispatch rephrases the same unanswered blocker (AGT-4042)', async () => {
    // A re-dispatched task is a fresh worker session that writes its own
    // ask_human call and paraphrases the previous wording — that must not mint
    // a fresh correlation ID that defeats the page-once guarantee.
    const h = await modules();
    const notify = vi.fn(async () => true);

    const first = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-a',
      question: 'What is the absolute path to the Google service-account JSON?', notify,
    });
    expect(first.delivered).toBe(true);
    expect(first.openAskCount).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);

    const second = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-b',
      question: 'Please provide the accessible absolute path for the Google service account JSON.', notify,
    });
    expect(second.delivered).toBe(true);
    expect(second.correlationId).not.toBe(first.correlationId); // genuinely different text, different hash
    expect(second.openAskCount).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1); // still just the one page

    const third = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-c',
      question: 'Requesting the Google service account JSON path once more.', notify,
    });
    expect(third.openAskCount).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("settles a reworded re-ask when the operator answers the one they were actually paged for", async () => {
    // The operator can only ever reply to the correlation ID in the ONE page
    // they received — the paging gate above suppresses every later page for a
    // rephrased repeat of the same blocker. If answering that first ID left
    // the rephrased ones open, the task's open-question count would never
    // reach zero and a run parked on the repeat-ask stop (AGT-4042) would wait
    // forever for an answer that, from the operator's side, already arrived.
    const h = await modules();
    const notify = vi.fn(async () => true);

    const first = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-a',
      question: 'What is the Spreadsheet ID?', notify,
    });
    const second = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-b',
      question: 'Please share the target Spreadsheet ID.', notify,
    });
    expect(notify).toHaveBeenCalledTimes(1); // only the first ever paged

    const store = await import('./coordinationStore.js');
    expect(store.getCoordinationStore().openQuestionCount('/repo', 't1')).toBe(2);

    const accepted = await h.answerHumanQuestion(first.correlationId, 'sheet-abc123', 'discord:user');
    expect(accepted.accepted).toBe(true);

    expect(store.getCoordinationStore().openQuestionCount('/repo', 't1')).toBe(0);

    // The reworded ask's own asker gets the answer routed to it too, the same
    // way the directly-answered one does.
    const secondAnswer = await h.answerHumanQuestion(second.correlationId, 'irrelevant', 'discord:user');
    expect(secondAnswer.accepted).toBe(false);
    expect(secondAnswer.reason).toMatch(/already completed/);
  });

  it('pages again once the outstanding question is answered', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);

    const first = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-a', question: 'Which bucket?', notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    await h.answerHumanQuestion(first.correlationId, 'the-prod-bucket', 'discord:user');

    const second = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-a', question: 'Which region?', notify,
    });
    expect(second.delivered).toBe(true);
    expect(second.openAskCount).toBe(1); // a genuinely new question, no outstanding one left
    expect(notify).toHaveBeenCalledTimes(2); // this one DOES get paged
  });

  it('does not let a second task on the same repository suppress the first task\'s page', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);

    const taskA = await h.postHumanQuestion({
      repository: '/repo', taskId: 't1', actor: 'worker-a', question: 'Q for task A', notify,
    });
    const taskB = await h.postHumanQuestion({
      repository: '/repo', taskId: 't2', actor: 'worker-b', question: 'Q for task B', notify,
    });
    expect(taskA.delivered).toBe(true);
    expect(taskB.delivered).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(taskA.openAskCount).toBe(1);
    expect(taskB.openAskCount).toBe(1);
  });
});
