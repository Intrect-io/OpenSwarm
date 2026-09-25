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
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';
import {
  HERMES_ADVISOR_ACTOR,
  consultHermesAdvisor,
  formatAdvisorAnswer,
  isHermesAdvisorEnabled,
  type AdvisorQuestion,
  type AdvisorVerdict,
} from './hermesAdvisor.js';

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
  /**
   * Which kind of question this is (AGT-4514). Absent is treated as
   * `'approval'` everywhere it matters — see `resolveQuestionClass`.
   */
  questionClass?: HumanQuestionClass;
  /** Overridable for tests; defaults to the configured Discord channel. */
  notify?: (message: string) => Promise<boolean>;
  /**
   * Automated advisor consulted on `clarification` questions before the
   * operator is paged (AGT-4516). Overridable for tests; defaults to the Hermes
   * bridge when `OPENSWARM_HERMES_ADVISOR=1`, otherwise no advisor.
   */
  advisor?: (question: AdvisorQuestion) => Promise<AdvisorVerdict>;
}

/**
 * Whether a question is one another machine may answer.
 *
 * `clarification` — informational; the answer is a fact the asker could not
 * look up, and an automated responder may supply it.
 *
 * `approval` — the asker needs a human to own the decision (credentials,
 * spend, production access, an irreversible external action). Nothing but a
 * human may answer it.
 *
 * Agents supply this, so it is a *claim*, not proof: the answer-side gate in
 * `answerHumanQuestion` is what makes the distinction load-bearing, and it
 * fails closed in the direction that denies automation (AGT-4514).
 */
export type HumanQuestionClass = 'clarification' | 'approval';

/**
 * Resolve a question's class, failing closed.
 *
 * Anything that is not exactly `'clarification'` — absent, misspelled, a stale
 * enum value from an older agent — is `'approval'`. Guessing in the other
 * direction would let a caller that omits the field (every agent that existed
 * before this field did) be answered by a machine.
 */
export function resolveQuestionClass(value: unknown): HumanQuestionClass {
  return value === 'clarification' ? 'clarification' : 'approval';
}

/**
 * Does this answer come from a surface the operator owns?
 *
 * Allowlisted rather than denylisted, so an unknown actor — a connector, a
 * script, a future integration — is automated by default and has to be refused
 * before it can answer anything a human must own. The three surfaces below are
 * the ones that answer today: the dashboard route
 * (`coordinationRoutes.ts`), the Discord reply path (`discordCore.ts`), and
 * OpenSwarm's own supervisor
 * (`orchestratorTrackerTools.ts`), which answers with the authority the
 * operator delegated to it. (AGT-4514)
 */
function isHumanSurfaceActor(actor: string, actorRole: AnswerActorRole): boolean {
  // `advisor` is a declaration of automation and wins over any actor name, so
  // an advisor bridge cannot inherit a human surface's authority by reusing
  // its identifier.
  if (actorRole === 'advisor') return false;
  return actorRole === 'orchestrator'
    || actor.startsWith('discord:')
    || actor === 'operator-dashboard';
}

/**
 * Who is answering. `advisor` is a clearly non-human automated responder
 * (e.g. the Hermes advisor bridge): it may answer `clarification` questions
 * only, and its answer is never labelled as a human's.
 */
export type AnswerActorRole = 'human' | 'orchestrator' | 'advisor';

function answerSummaryKey(actorRole: AnswerActorRole) {
  if (actorRole === 'human') return 'coordination.humanQuestion.humanAnswered' as const;
  if (actorRole === 'advisor') return 'coordination.humanQuestion.advisorAnswered' as const;
  return 'coordination.humanQuestion.supervisorAnswered' as const;
}

export function humanQuestionCorrelation(
  input: Pick<HumanQuestionInput, 'repository' | 'taskId' | 'question' | 'questionClass'>,
): string {
  // The class is part of the identity only for `clarification`, so every id
  // minted before classes existed — all of them read as approval — is
  // unchanged. Without it, the same text asked once as clarification (and
  // answered by the advisor) and again as approval would share one exchange,
  // and the approval ask would be handed the machine's answer (AGT-4516).
  const classPart = resolveQuestionClass(input.questionClass) === 'clarification' ? '\0clarification' : '';
  return `hq-${createHash('sha256').update(`${input.repository}\0${input.taskId}\0${input.question}${classPart}`).digest('hex').slice(0, 16)}`;
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
  /** Set when the operator — or, for a clarification, the advisor — already answered. */
  answer?: string;
  /** Board actor that supplied `answer` when it was the automated advisor. */
  answeredBy?: string;
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
  const questionClass = resolveQuestionClass(input.questionClass);
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
    return {
      correlationId,
      delivered: true,
      answer: answered.detail ?? answered.summary,
      ...(answered.actorRole === 'advisor' ? { answeredBy: answered.actor } : {}),
      openAskCount: 0,
    };
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
      metadata: { questionClass },
    });

    // First ask only: a retry of a question the advisor already declined goes
    // straight to the operator path instead of paying for the same refusal.
    const advised = questionClass === 'clarification'
      ? await consultAdvisor(input, correlationId)
      : undefined;
    if (advised) return advised;
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
  const delivered = isHumanSurfaceReadOnlyEnabled() ? false : await notify(
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

function resolveAdvisor(input: HumanQuestionInput): HumanQuestionInput['advisor'] {
  if (input.advisor) return input.advisor;
  return isHermesAdvisorEnabled() ? (question) => consultHermesAdvisor(question) : undefined;
}

/**
 * Let the automated advisor answer a clarification question. Returns the post
 * result when it did; `undefined` sends the caller on to page the operator —
 * on a decline, on any advisor failure, and when the answer gate refuses it.
 */
async function consultAdvisor(input: HumanQuestionInput, correlationId: string): Promise<HumanQuestionPost | undefined> {
  const advisor = resolveAdvisor(input);
  if (!advisor) return undefined;
  const verdict = await advisor({ repository: input.repository, taskLabel: input.taskLabel, question: input.question });
  const origin = [verdict.provenance?.model, verdict.provenance?.sessionId].filter(Boolean).join(' ');
  if (verdict.status !== 'answered' || !verdict.answer) {
    console.log(`[Coordination] advisor ${verdict.status} on ${correlationId}${origin ? ` (${origin})` : ''}: ${verdict.reason ?? ''} — paging operator`);
    return undefined;
  }
  const answer = formatAdvisorAnswer(verdict);
  const result = await answerHumanQuestion(correlationId, answer, HERMES_ADVISOR_ACTOR, 'advisor');
  if (!result.accepted) {
    // The consult can take minutes; someone may have answered meanwhile (the
    // operator on the dashboard, or a concurrent ask of the same question).
    // That answer is the one to return — paging for it would be a stale page.
    const existing = getCoordinationStore().exchange(correlationId)
      .find((event) => event.kind === 'human-answer' && event.status === 'completed');
    if (existing) {
      return {
        correlationId,
        delivered: true,
        answer: existing.detail ?? existing.summary,
        ...(existing.actorRole === 'advisor' ? { answeredBy: existing.actor } : {}),
        openAskCount: 0,
      };
    }
    console.warn(`[Coordination] advisor answer refused on ${correlationId}: ${result.reason ?? ''} — paging operator`);
    return undefined;
  }
  console.log(`[Coordination] advisor answered ${correlationId}${origin ? ` (${origin})` : ''}`);
  return { correlationId, delivered: true, answer, answeredBy: HERMES_ADVISOR_ACTOR, openAskCount: 0 };
}

export async function answerHumanQuestion(
  correlationId: string,
  answer: string,
  actor: string,
  actorRole: AnswerActorRole = 'human',
): Promise<{ accepted: boolean; event?: CoordinationEvent; reason?: string }> {
  const store = getCoordinationStore();
  // findQuestion scans the whole retained board, not a recency window: on a
  // busy board a 500-event window can scroll an unanswered question out of
  // reach, and `!answer` then tells the operator their pending question does
  // not exist.
  const question = store.findQuestion(correlationId);
  if (!question) return { accepted: false, reason: 'No pending question with that correlation ID' };

  // An automated responder may only answer a question classed `clarification`.
  // The class comes from the asking agent, so it is a claim; this gate is what
  // turns it into a boundary. Membership of the human surfaces is recognised by
  // the actor itself, not by a caller-supplied role — an automated connector
  // that omits the role, or claims `'human'`, is still treated as automated.
  // Absent metadata fails closed: an event published before this field existed
  // reads `approval` and refuses the machine (AGT-4514).
  if (!isHumanSurfaceActor(actor, actorRole)
    && resolveQuestionClass(question.metadata?.questionClass) !== 'clarification') {
    return {
      accepted: false,
      reason: 'This question requires a human decision and cannot be answered by an automated responder',
    };
  }
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
    summary: t(answerSummaryKey(actorRole)),
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
  //
  // Only a human surface settles siblings. An automated answer was written
  // for one exact question: settling an approval sibling would walk around
  // the class gate above, and settling a clarification sibling the operator
  // was already paged about would refuse the operator's own reply to it as
  // "already completed" (AGT-4516).
  const automated = !isHumanSurfaceActor(actor, actorRole);
  const siblings = automated ? [] : store
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
