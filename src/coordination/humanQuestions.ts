// ============================================
// OpenSwarm - Discord human decision bridge
// ============================================
//
// A blocking decision is posted to the operator once and recorded on the
// coordination board. Delivery is deliberately non-blocking: the asking run
// stops and reports, rather than holding a worktree slot open for however long
// the operator takes to reply. The answer reaches the agent the same way any
// other message does — `answerHumanQuestion` addresses it to the asker, so the
// next run of that call sign reads it out of its board inbox.

import { createHash } from 'node:crypto';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import { t } from '../locale/index.js';
import { answerHint } from './answerHint.js';

export interface HumanQuestionInput {
  repository: string;
  taskId: string;
  /**
   * The issue identifier this question belongs to (AX-867), used to address the
   * operator and to attribute the board event. `taskId` is a worktree UUID, so
   * without this the page reads "a decision for f8c57098-cbf6-…" (AGT-4074).
   */
  taskLabel?: string;
  /** Board address of the agent asking, so the answer can be routed back. */
  actor: string;
  actorName?: string;
  actorRole?: string;
  question: string;
  /** Overridable for tests; defaults to the configured Discord channel. */
  notify?: (message: string) => Promise<boolean>;
}

export function humanQuestionCorrelation(
  input: Pick<HumanQuestionInput, 'repository' | 'taskId' | 'question'>,
): string {
  return `hq-${createHash('sha256').update(`${input.repository}\0${input.taskId}\0${input.question}`).digest('hex').slice(0, 16)}`;
}

/**
 * Send a message to the operator's Discord channel.
 *
 * Returns whether it actually reached a channel: `sendToChannel` is silent when
 * Discord is not configured, and an agent must not be told its question was
 * delivered when nobody was listening.
 */
async function notifyOperatorViaDiscord(message: string): Promise<boolean> {
  try {
    const discord = await import('../discord/discordCore.js');
    if (!discord.hasDiscordChannel()) return false;
    await discord.sendToChannel(message);
    return true;
  } catch (error) { // cxt-ignore: error_swallow,exception_hiding — failure IS the return value; callers report "nobody was paged"
    console.warn('[Coordination] Discord notification failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export interface HumanQuestionPost {
  correlationId: string;
  /** False when Discord is unconfigured or unreachable — the board still has it. */
  delivered: boolean;
  /** Set when the operator already answered this exact question. */
  answer?: string;
  /**
   * How many open (unanswered) questions this task has asked, this one
   * included. 1 on a first ask; higher when a re-dispatch rephrased the same
   * blocker rather than getting an answer — the count a log or dashboard needs
   * to tell "still waiting, asked once" from "still waiting, asked repeatedly"
   * (AGT-4042).
   */
  openAskCount: number;
}

/**
 * Record one blocking decision and page the operator.
 *
 * The same question from the same task resolves to the same correlation ID, so
 * a retry after an answer returns that answer instead of asking twice.
 */
export async function postHumanQuestion(input: HumanQuestionInput): Promise<HumanQuestionPost> {
  const store = getCoordinationStore();
  const correlationId = humanQuestionCorrelation(input);
  // The whole exchange, from the durable trace as well as the board: reading a
  // recency window would lose sight of this task's own answer once it has talked
  // enough, and it would ask again — spending an attempt to arrive back at the
  // question the operator has already answered.
  const prior = store.exchange(correlationId);
  // Board-only, unlike `prior` above: this backs only the "already paged"
  // check below, which is a rate-limit on re-paging, not a correctness gate —
  // losing sight of an old page on a very chatty task just risks one extra
  // page, not a stuck run.
  const taskEvents = store.list({ repository: input.repository, taskId: input.taskId, limit: 500 });

  const answered = prior.find((event) => event.kind === 'human-answer' && event.status === 'completed');
  if (answered) {
    return { correlationId, delivered: true, answer: answered.detail ?? answered.summary, openAskCount: 0 };
  }

  const alreadyWaiting = prior.some((event) => event.kind === 'human-question' && event.status === 'waiting');
  if (!alreadyWaiting) {
    await store.publish({
      repository: input.repository,
      taskId: input.taskId,
      taskLabel: input.taskLabel,
      actor: input.actor,
      actorName: input.actorName,
      actorRole: input.actorRole,
      recipient: 'human',
      recipientRole: 'human',
      kind: 'human-question',
      status: 'waiting',
      correlationId,
      summary: input.question,
    });
  }

  // Task-scoped, not question-scoped. A re-dispatched task is a fresh worker
  // session that writes its own ask_human call, and it paraphrases the same
  // blocker differently every time — hashed into the correlation ID, that would
  // mint a new one on every attempt and defeat the "page once" rule below. What
  // the operator has open is a thread for this TASK, not for one exact wording
  // of it: the newest ask is what is visible on the board and in the page
  // already sent, so a reworded repeat of an unanswered ask does not warrant a
  // second ping (AGT-4042). This does mean a genuinely new, unrelated question
  // from the same task while one is still outstanding will not page either —
  // accepted for now; distinguishing "reworded" from "unrelated" needs more
  // than a text diff and is not attempted here.
  // Re-reads the board rather than trusting `taskEvents`: this call just
  // published a new `waiting` event for `correlationId` above, and the count
  // has to include it — a fresh store query stays correct in a way a variable
  // captured before that publish would not.
  const openAskCount = Math.max(1, store.openQuestionCount(input.repository, input.taskId));

  // Page the operator at most once per open (unanswered) question the task
  // has outstanding — same correlation ID or not. `taskEvents` was read before
  // this ask's own `waiting` event was published, so it cannot self-match; it
  // is exactly the prior state the gate needs.
  const answeredCorrelations = new Set(taskEvents
    .filter((event) => event.kind === 'human-answer' && event.status === 'completed')
    .map((event) => event.correlationId));
  const alreadyPaged = taskEvents.some((event) =>
    event.kind === 'human-question'
    && event.status === 'running'
    && !answeredCorrelations.has(event.correlationId));
  if (alreadyPaged) {
    if (openAskCount > 1) {
      console.log(`[Coordination] ${input.taskId} asked its operator-blocking question a ${openAskCount}th time (reworded) without an answer — not re-paging`);
    }
    return { correlationId, delivered: true, openAskCount };
  }

  const notify = input.notify ?? notifyOperatorViaDiscord;
  const delivered = await notify(
    `OpenSwarm needs a decision for ${input.taskLabel ?? input.taskId}` +
      `${input.actorName ? ` (asked by ${input.actorName})` : ''}.\n${input.question}\n\n` +
      answerHint(correlationId),
  );
  if (delivered) {
    // Published under the ASKING agent, not the daemon. The board's pending set
    // is the latest event per correlation id
    // (`web/static/js/orchestrationModel.mjs:129-133`), and this marker shares
    // the question's id and lands after it — so it was the latest event for 48
    // of 69 pending exchanges on the live board, and every "who is waiting on
    // the operator" readout named the daemon instead of the parked worker.
    //
    // It stays a pending `human-question` on purpose: moving it to another kind
    // would drop those exchanges out of `pendingQuestions`, and marking it
    // terminal would drop them out of the pending set altogether. The note is
    // about this agent's question, so the agent is the right speaker (AGT-4074).
    await store.publish({
      repository: input.repository,
      taskId: input.taskId,
      taskLabel: input.taskLabel,
      actor: input.actor,
      actorName: input.actorName,
      actorRole: input.actorRole,
      recipient: 'human',
      kind: 'human-question',
      status: 'running',
      correlationId,
      summary: t('coordination.humanQuestion.operatorPaged'),
    });
  }
  return { correlationId, delivered, openAskCount };
}

export async function answerHumanQuestion(
  correlationId: string,
  answer: string,
  actor: string,
  actorRole: 'human' | 'orchestrator' = 'human',
): Promise<{ accepted: boolean; event?: CoordinationEvent; reason?: string }> {
  const store = getCoordinationStore();
  // findQuestion scans the whole retained board, not a recency window: on a
  // busy board a 500-event window can scroll an unanswered question out of
  // reach, and `!answer` then tells the operator their pending question does
  // not exist.
  const question = store.findQuestion(correlationId);
  if (!question) return { accepted: false, reason: 'No pending question with that correlation ID' };
  // Same reach as `findQuestion` above: a recency window here would stop seeing
  // the answer this question already has and let the operator answer it twice.
  const terminal = store.exchange(correlationId)
    .find((event) => ['completed', 'expired', 'failed'].includes(event.status));
  if (terminal) return { accepted: false, reason: `Question is already ${terminal.status}` };

  const event = await store.publish({
    repository: question.repository,
    taskId: question.taskId,
    taskLabel: question.taskLabel,
    actor,
    actorRole,
    recipient: question.actor,
    recipientName: question.actorName,
    recipientRole: question.actorRole,
    kind: 'human-answer',
    status: 'completed',
    correlationId,
    summary: t(actorRole === 'human'
      ? 'coordination.humanQuestion.humanAnswered'
      : 'coordination.humanQuestion.supervisorAnswered'),
    detail: answer,
    metadata: { answerSetId: correlationId },
  });

  // A re-dispatch that rephrased this same blocker minted its own correlation
  // ID (the paging gate above only ever surfaces the FIRST one to the
  // operator), so the reply is necessarily addressed to that first ID — the
  // only one the operator ever saw. Settle every other still-open ask for this
  // task too, or the task's openQuestionCount never reaches zero and a run
  // parked on the repeat-ask stop (AGT-4042) never sees itself as answered.
  // Durable, not board-only: a task chatty enough to push an older sibling
  // out of the board's own retention window would otherwise leave it
  // permanently unanswered in the trace, and `allQuestionsAnswered` would
  // never see that task as answered again.
  const siblings = store
    .openQuestions(question.repository, question.taskId)
    .filter((e) => e.correlationId !== correlationId);
  const seenSiblingIds = new Set<string>();
  for (const sibling of siblings) {
    if (seenSiblingIds.has(sibling.correlationId)) continue;
    seenSiblingIds.add(sibling.correlationId);
    await store.publish({
      repository: question.repository,
      taskId: question.taskId,
      taskLabel: sibling.taskLabel,
      actor,
      actorRole,
      recipient: sibling.actor,
      recipientName: sibling.actorName,
      recipientRole: sibling.actorRole,
      kind: 'human-answer',
      status: 'completed',
      correlationId: sibling.correlationId,
      summary: t('coordination.humanQuestion.siblingAnswered'),
      detail: answer,
      metadata: { answerSetId: correlationId },
    });
  }

  return { accepted: true, event };
}
