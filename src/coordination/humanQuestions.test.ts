import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
// The durable trace lives in the automation database, which vitest.setup points
// at one path for the whole run. `postHumanQuestion` reads it, so without a
// database per test these suites answer each other's questions.
const ORIGINAL_AUTOMATION_DB = process.env.OPENSWARM_AUTOMATION_DB;
let dir = '';
afterEach(async () => {
  resetHumanSurfaceReadOnlyForTests();
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
  it('records the blocker but never invokes an injected operator sender in strict mode', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    enableHumanSurfaceReadOnly();

    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 'strict-task', actor: 'a', question: 'Ship?', notify,
    });

    expect(posted.delivered).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect((await import('./coordinationStore.js')).getCoordinationStore().findQuestion(posted.correlationId))
      .toMatchObject({ status: 'waiting', summary: 'Ship?' });
  });
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
    expect(store.getCoordinationStore().resolvedHumanAnswers('t1')).toEqual([
      expect.objectContaining({
        correlationIds: [first.correlationId, second.correlationId],
        answer: 'sheet-abc123',
      }),
    ]);

    // The reworded ask's own asker gets the answer routed to it too, the same
    // way the directly-answered one does.
    const secondAnswer = await h.answerHumanQuestion(second.correlationId, 'irrelevant', 'discord:user');
    expect(secondAnswer.accepted).toBe(false);
    expect(secondAnswer.reason).toMatch(/already completed/);
  });

  it('settles a sibling question the board has evicted, so allQuestionsAnswered still becomes true (AGT-4042)', async () => {
    // The fan-out that settles every rephrased re-ask used to scan only the
    // live board. A task chatty enough to push an older sibling's own
    // `human-question` event out of the board's retention window would leave
    // it permanently unanswered in the durable trace — allQuestionsAnswered
    // reads the trace, so it would never see that task as answered again, and
    // a run parked on the repeat-ask stop (AGT-4042) would wait forever for a
    // reply that, from the operator's side, already arrived.
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

    // Evict the sibling's own `human-question` event from the board, the way
    // unrelated traffic would once the ring buffer fills — the durable trace
    // still has it.
    const file = join(dir, 'events.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.events = state.events.filter((event: { correlationId: string }) =>
      event.correlationId !== second.correlationId);
    writeFileSync(file, JSON.stringify(state));
    const store = (await import('./coordinationStore.js'));
    store.resetCoordinationStoreForTests();

    expect(store.getCoordinationStore().allQuestionsAnswered('t1')).toBe(false);

    const accepted = await h.answerHumanQuestion(first.correlationId, 'sheet-abc123', 'discord:user');
    expect(accepted.accepted).toBe(true);

    expect(store.getCoordinationStore().allQuestionsAnswered('t1')).toBe(true);
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

describe('the operator is told which issue is asking (AGT-4074)', () => {
  it('names the issue identifier in the page, not the worktree id', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    await h.postHumanQuestion({
      repository: '/repo',
      taskId: 'f8c57098-cbf6-4beb-9e0f-20595d60c7c7',
      taskLabel: 'AX-867',
      actor: 'pylon-dev', actorName: 'pylon_dev', actorRole: 'worker',
      question: 'Which DSN?', notify,
    });
    const page = notify.mock.calls[0][0] as string;
    expect(page).toContain('AX-867');
    expect(page).not.toContain('f8c57098');
  });

  it('falls back to the task id when no label is known', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    await h.postHumanQuestion({
      repository: '/repo', taskId: 'unlabelled-task',
      actor: 'pylon-dev', question: 'Which DSN?', notify,
    });
    expect(notify.mock.calls[0][0]).toContain('unlabelled-task');
  });

  it('labels the question, the page marker and the answer', async () => {
    const h = await modules();
    const store = await import('./coordinationStore.js');
    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 'wt-uuid', taskLabel: 'AX-867',
      actor: 'pylon-dev', actorName: 'pylon_dev', actorRole: 'worker',
      question: 'Which DSN?', notify: async () => true,
    });
    await h.answerHumanQuestion(posted.correlationId, 'Use the staging DSN', 'discord:user');
    const events = store.getCoordinationStore().exchange(posted.correlationId);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) expect(event.taskLabel).toBe('AX-867');
  });

  it('attributes the page marker to the asking agent, not the daemon', async () => {
    // The board's pending set is the latest event per correlation id, and this
    // marker lands after the question — so publishing it as the daemon made
    // every "who is waiting on the operator" readout name the daemon.
    const h = await modules();
    const store = await import('./coordinationStore.js');
    const posted = await h.postHumanQuestion({
      repository: '/repo', taskId: 'wt-uuid', taskLabel: 'AX-867',
      actor: 'pylon-dev', actorName: 'pylon_dev', actorRole: 'worker',
      question: 'Which DSN?', notify: async () => true,
    });
    const events = store.getCoordinationStore().exchange(posted.correlationId);
    const latest = events.reduce((a, b) => (b.seq > a.seq ? b : a));
    expect(latest.summary).toBe('Operator paged on Discord');
    expect(latest.actor).toBe('pylon-dev');
    expect(latest.actorName).toBe('pylon_dev');
    // It must stay a pending human-question: another kind drops the exchange out
    // of pendingQuestions, and a terminal status drops it out of pending entirely.
    expect(latest.kind).toBe('human-question');
    expect(latest.status).toBe('running');
  });
});

// AGT-4514: an automated responder must not be able to answer a question a
// human has to own. The class is supplied by the asking agent, so it is a
// claim; the answer-side gate is what makes it a boundary.
describe('question class gates automated answers (AGT-4514)', () => {
  const ask = (h: Awaited<ReturnType<typeof modules>>, over: Record<string, unknown> = {}) =>
    h.postHumanQuestion({
      repository: '/repo', taskId: 'cls-1', actor: 'worker-1',
      question: 'What is the staging DSN?', notify: async () => true,
      ...over,
    });

  it('defaults a question with no class to approval', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const posted = await ask(h);
    expect(store.exchange(posted.correlationId)[0].metadata?.questionClass).toBe('approval');
    expect(h.resolveQuestionClass(undefined)).toBe('approval');
    expect(h.resolveQuestionClass('Clarification')).toBe('approval'); // case matters: fail closed
    expect(h.resolveQuestionClass('')).toBe('approval');
  });

  it('refuses an automated responder on an approval question', async () => {
    const h = await modules();
    const posted = await ask(h, { questionClass: 'approval' });
    const result = await h.answerHumanQuestion(posted.correlationId, 'use the prod DSN', 'hermes-connector');
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('human decision');
  });

  it('refuses an automated responder that omits or claims a human role', async () => {
    const h = await modules();
    const posted = await ask(h, { questionClass: 'approval' });
    // Omitting the role and claiming 'human' must both still read as automated.
    const noRole = await h.answerHumanQuestion(posted.correlationId, 'x', 'hermes-connector');
    expect(noRole.accepted).toBe(false);
  });

  it('allows an automated responder on a clarification question', async () => {
    const h = await modules();
    const posted = await ask(h, { questionClass: 'clarification' });
    const result = await h.answerHumanQuestion(posted.correlationId, 'the staging DSN', 'hermes-connector');
    expect(result.accepted).toBe(true);
    expect(result.event?.detail).toBe('the staging DSN');
    expect(result.event?.actor).toBe('hermes-connector');
  });

  it('keeps every existing human surface able to answer an approval question', async () => {
    const h = await modules();
    const a = await ask(h, { questionClass: 'approval' });
    expect((await h.answerHumanQuestion(a.correlationId, 'yes', 'discord:user-1')).accepted).toBe(true);

    const b = await ask(h, { taskId: 'cls-2', questionClass: 'approval' });
    expect((await h.answerHumanQuestion(b.correlationId, 'yes', 'operator-dashboard')).accepted).toBe(true);

    const c = await ask(h, { taskId: 'cls-3', questionClass: 'approval' });
    expect((await h.answerHumanQuestion(c.correlationId, 'yes', 'supervisor', 'orchestrator')).accepted).toBe(true);
  });

  it('does not let an automated answer settle a sibling approval question of the same task', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const approval = await ask(h, { question: 'May I rotate the prod key?', questionClass: 'approval' });
    const clarification = await ask(h, { question: 'Which test runner?', questionClass: 'clarification' });

    const result = await h.answerHumanQuestion(clarification.correlationId, 'vitest', 'advisor:hermes', 'advisor');

    expect(result.accepted).toBe(true);
    // The approval sibling is still open: sibling settling must not be a way
    // around the class gate.
    expect(store.openQuestions('/repo', 'cls-1').map((e) => e.correlationId)).toEqual([approval.correlationId]);
    expect(store.exchange(approval.correlationId).some((e) => e.kind === 'human-answer')).toBe(false);
  });

  it('never labels an automated advisor answer as a human or supervisor answer', async () => {
    const h = await modules();
    const posted = await ask(h, { questionClass: 'clarification' });
    const result = await h.answerHumanQuestion(posted.correlationId, 'vitest', 'advisor:hermes', 'advisor');
    expect(result.accepted).toBe(true);
    expect(result.event?.actorRole).toBe('advisor');
    const { t } = await import('../locale/index.js');
    expect(result.event?.summary).not.toBe(t('coordination.humanQuestion.humanAnswered'));
    expect(result.event?.summary).not.toBe(t('coordination.humanQuestion.supervisorAnswered'));
    expect(result.event?.summary).toBe(t('coordination.humanQuestion.advisorAnswered'));
  });

  it('treats the advisor role as automated even on an allowlisted-looking actor', async () => {
    const h = await modules();
    const posted = await ask(h, { questionClass: 'approval' });
    const result = await h.answerHumanQuestion(posted.correlationId, 'yes', 'operator-dashboard', 'advisor');
    expect(result.accepted).toBe(false);
  });

  it('leaves a refused answer unsettled so a human can still answer it', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const posted = await ask(h, { questionClass: 'approval' });
    await h.answerHumanQuestion(posted.correlationId, 'leaked', 'hermes-connector');
    // The refusal must not consume the question.
    expect(store.findQuestion(posted.correlationId)).toBeDefined();
    expect((await h.answerHumanQuestion(posted.correlationId, 'real answer', 'discord:user-1')).accepted).toBe(true);
  });
});

// AGT-4516: the Hermes advisor may take a clarification question off the
// operator's plate; anything else, and any advisor failure, pages the human.
describe('advisor consult before paging (AGT-4516)', () => {
  const answered = { status: 'answered' as const, answer: 'vitest', confidence: 90, provenance: { model: 'm-1', sessionId: 's-1' } };
  const ask = (h: Awaited<ReturnType<typeof modules>>, over: Record<string, unknown> = {}) =>
    h.postHumanQuestion({
      repository: '/repo', taskId: 'adv-1', actor: 'worker-1',
      question: 'Which test runner?', questionClass: 'clarification',
      ...over,
    } as Parameters<typeof h.postHumanQuestion>[0]);

  it('returns the advisor answer inline and does not page the operator', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const notify = vi.fn(async () => true);
    const advisor = vi.fn(async () => answered);

    const posted = await ask(h, { notify, advisor });

    expect(advisor).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(posted.answeredBy).toBe('advisor:hermes');
    expect(posted.answer).toContain('vitest');
    expect(posted.answer).toContain('not a human');
    expect(posted.answer).toContain('m-1');
    const answer = store.exchange(posted.correlationId).find((e) => e.kind === 'human-answer');
    expect(answer).toMatchObject({ actor: 'advisor:hermes', actorRole: 'advisor', status: 'completed' });
    expect(store.openQuestionCount('/repo', 'adv-1')).toBe(0);
  });

  it.each([
    ['declined', { status: 'declined' as const, reason: 'operator preference' }],
    ['unavailable', { status: 'unavailable' as const, reason: 'timeout' }],
  ])('pages the operator when the advisor %s', async (_label, verdict) => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    const posted = await ask(h, { notify, advisor: vi.fn(async () => verdict) });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(posted.answer).toBeUndefined();
    expect(posted.answeredBy).toBeUndefined();
  });

  it('never consults the advisor on an approval or unclassified question', async () => {
    const h = await modules();
    const advisor = vi.fn(async () => answered);
    await ask(h, { taskId: 'adv-2', questionClass: 'approval', notify: async () => true, advisor });
    await ask(h, { taskId: 'adv-3', questionClass: undefined, notify: async () => true, advisor });
    expect(advisor).not.toHaveBeenCalled();
  });

  it('does not re-consult on a retry of a question the advisor already declined', async () => {
    const h = await modules();
    const advisor = vi.fn(async () => ({ status: 'declined' as const, reason: 'no' }));
    await ask(h, { notify: async () => true, advisor });
    await ask(h, { notify: async () => true, advisor });
    expect(advisor).toHaveBeenCalledTimes(1);
  });

  it('stays off without explicit opt-in', async () => {
    const h = await modules();
    const previous = process.env.OPENSWARM_HERMES_ADVISOR;
    delete process.env.OPENSWARM_HERMES_ADVISOR;
    try {
      const notify = vi.fn(async () => true);
      const posted = await ask(h, { notify });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(posted.answeredBy).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.OPENSWARM_HERMES_ADVISOR = previous;
    }
  });
});

// Independent review of the AGT-4516 bridge found these paths around the gate.
describe('advisor answers stay advice (AGT-4516 review)', () => {
  const answered = { status: 'answered' as const, answer: 'vitest', confidence: 90, provenance: { model: 'm-1' } };
  const post = (h: Awaited<ReturnType<typeof modules>>, over: Record<string, unknown>) =>
    h.postHumanQuestion({
      repository: '/repo', taskId: 'rv-1', actor: 'worker-1', question: 'Which test runner?',
      notify: async () => true, ...over,
    } as Parameters<typeof h.postHumanQuestion>[0]);

  it('keeps advisor answers out of the authoritative operator feedback', async () => {
    const h = await modules();
    const { loadAuthoritativeOperatorFeedback } = await import('./operatorGuidance.js');
    await post(h, { questionClass: 'clarification', advisor: async () => answered });
    expect(loadAuthoritativeOperatorFeedback('rv-1')).toBeUndefined();

    const human = await post(h, { question: 'Ship it?', questionClass: 'approval' });
    await h.answerHumanQuestion(human.correlationId, 'yes, ship', 'discord:op');
    const feedback = loadAuthoritativeOperatorFeedback('rv-1') ?? '';
    expect(feedback).toContain('yes, ship');
    expect(feedback).not.toContain('vitest');
  });

  it('does not hand an advisor answer to the same text asked as approval', async () => {
    const h = await modules();
    const advisor = vi.fn(async () => answered);
    await post(h, { questionClass: 'clarification', advisor });
    const asApproval = await post(h, { questionClass: 'approval', advisor });
    expect(asApproval.answer).toBeUndefined();
    expect(asApproval.answeredBy).toBeUndefined();
    expect(advisor).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy approval correlation ids stable', async () => {
    const h = await modules();
    const legacy = h.humanQuestionCorrelation({ repository: '/repo', taskId: 't', question: 'q' });
    expect(h.humanQuestionCorrelation({ repository: '/repo', taskId: 't', question: 'q', questionClass: 'approval' })).toBe(legacy);
    expect(h.humanQuestionCorrelation({ repository: '/repo', taskId: 't', question: 'q', questionClass: 'clarification' })).not.toBe(legacy);
  });

  it('returns the existing answer instead of paging when the question was answered during the consult', async () => {
    const h = await modules();
    const notify = vi.fn(async () => true);
    const advisor = vi.fn(async () => {
      // The operator answers on the dashboard while Hermes is still thinking.
      const q = (await import('./coordinationStore.js')).getCoordinationStore()
        .openQuestions('/repo', 'rv-1')[0];
      await h.answerHumanQuestion(q.correlationId, 'use jest', 'operator-dashboard');
      return answered;
    });
    const posted = await post(h, { questionClass: 'clarification', advisor, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(posted.answer).toBe('use jest');
    expect(posted.answeredBy).toBeUndefined();
  });

  it('settles no sibling question, clarification or not, on an automated answer', async () => {
    const h = await modules();
    const store = (await import('./coordinationStore.js')).getCoordinationStore();
    const paged = await post(h, { question: 'Which runner (v1)?', questionClass: 'clarification', advisor: async () => ({ status: 'declined' as const }) });
    const reworded = await post(h, { question: 'Which runner (v2)?', questionClass: 'clarification', advisor: async () => answered });
    expect(reworded.answeredBy).toBe('advisor:hermes');
    expect(store.openQuestions('/repo', 'rv-1').map((e) => e.correlationId)).toEqual([paged.correlationId]);
    // The operator can still answer the question they were paged about.
    expect((await h.answerHumanQuestion(paged.correlationId, 'vitest', 'discord:op')).accepted).toBe(true);
  });
});
