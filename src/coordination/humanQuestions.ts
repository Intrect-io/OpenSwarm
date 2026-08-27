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

export interface HumanQuestionInput {
  repository: string;
  taskId: string;
  /** Board address of the agent asking, so the answer can be routed back. */
  actor: string;
  actorName?: string;
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
  const prior = store
    .list({ repository: input.repository, taskId: input.taskId, limit: 500 })
    .filter((event) => event.correlationId === correlationId);

  const answered = prior.find((event) => event.kind === 'human-answer' && event.status === 'completed');
  if (answered) return { correlationId, delivered: true, answer: answered.detail ?? answered.summary };

  const alreadyWaiting = prior.some((event) => event.kind === 'human-question' && event.status === 'waiting');
  if (!alreadyWaiting) {
    await store.publish({
      repository: input.repository,
      taskId: input.taskId,
      actor: input.actor,
      actorName: input.actorName,
      recipient: 'human',
      kind: 'human-question',
      status: 'waiting',
      correlationId,
      summary: input.question,
    });
  }

  const notify = input.notify ?? notifyOperatorViaDiscord;
  const delivered = await notify(
    `OpenSwarm needs a decision for ${input.taskId}` +
      `${input.actorName ? ` (asked by ${input.actorName})` : ''}.\n${input.question}\n\n` +
      `Reply with: !answer ${correlationId} <your answer>`,
  );
  return { correlationId, delivered };
}

export async function answerHumanQuestion(
  correlationId: string,
  answer: string,
  actor: string,
): Promise<{ accepted: boolean; event?: CoordinationEvent; reason?: string }> {
  const store = getCoordinationStore();
  // findQuestion scans the whole retained board, not a recency window: on a
  // busy board a 500-event window can scroll an unanswered question out of
  // reach, and `!answer` then tells the operator their pending question does
  // not exist.
  const question = store.findQuestion(correlationId);
  if (!question) return { accepted: false, reason: 'No pending question with that correlation ID' };
  const terminal = store.list({ repository: question.repository, taskId: question.taskId, limit: 500 })
    .find((event) => event.correlationId === correlationId && ['completed', 'expired', 'failed'].includes(event.status));
  if (terminal) return { accepted: false, reason: `Question is already ${terminal.status}` };

  const event = await store.publish({
    repository: question.repository,
    taskId: question.taskId,
    actor,
    recipient: question.actor,
    recipientName: question.actorName,
    kind: 'human-answer',
    status: 'completed',
    correlationId,
    summary: 'Human answered the blocking question',
    detail: answer,
  });
  return { accepted: true, event };
}
