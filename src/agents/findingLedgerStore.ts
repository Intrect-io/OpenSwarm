/**
 * Durable finding ledger (AGT-4535).
 *
 * `findingLedger.ts` keeps the per-finding ids, worker answers and reviewer
 * rulings on the pipeline context, which a process restart loses. This module
 * mirrors every ledger round into one coordination thread per issue
 * (automation.db, `coordinationThreads.ts`) and rebuilds the ledger from it
 * when a run for the same issue starts, so ids and answers continue instead
 * of starting again at F1.
 *
 * Entries:
 *  - One message per finding a round touched, with idempotency key
 *    `<issueKey>:<round>:<findingId>:<review|answer>`. A replayed round writes
 *    nothing new; the discriminator keeps a review entry and a worker answer
 *    for the same id and round apart.
 *  - A review entry is the finding's full state after the reviewer's round.
 *    A worker entry carries only the worker's answer: restore never lets it
 *    open or close anything. Entries are told apart by the posting actor
 *    (`LEDGER_ACTORS`), which no agent can take: agent tools post under their
 *    assigned call sign.
 *  - Every entry carries `nextSeq`, so a lost entry cannot cause an id to be
 *    issued twice.
 *
 * Rounds: the ledger ignores a round it has already applied, and every run
 * counts iterations from 1. A restored ledger therefore offsets this run's
 * rounds past the highest round it holds (`roundBase`).
 *
 * Fail-open for persistence only: a store that cannot be reached leaves the
 * run on today's in-memory ledger, logged once per run. A run whose
 * restore failed appends nothing either, since a fresh F1 written into a
 * thread that already holds another F1 would corrupt the next restore. The
 * deadlock and round-cap logic does not depend on any of this.
 */

import type { PipelineContext } from './pairPipelineTypes.js';
import type { CoordinationThreadMessage } from '../coordination/coordinationThreads.js';
import type { Finding, FindingLedger, LedgerVerdict, WorkerResponse } from './findingLedger.js';
import { createFindingLedger, describeLedgerStop } from './findingLedger.js';
import { coordinationContextFor } from './pipelineCoordination.js';
import { taskAttributionKey, taskEventKey } from '../orchestration/decisionEngine.js';
import { safeConsole } from '../support/safeLog.js';

/** Where one issue's ledger lives. */
export interface LedgerThreadScope {
  repository: string;
  /** Thread owner task; stable across runs of the issue. */
  taskId: string;
  taskLabel?: string;
  /** Issue key in the idempotency keys (`AGT-1`, or the task id without one). */
  issueKey: string;
}

/** Durable ledger state of the current run; absent means in-memory only. */
export interface FindingLedgerThreadState {
  scope: LedgerThreadScope;
  threadId: string;
  /** Highest round restored from earlier runs; this run's rounds start above it. */
  roundBase: number;
  /** An append already failed and was logged this run. */
  warned?: boolean;
}

/** Fixed posting identities. Restore trusts entries from these actors only. */
export const LEDGER_ACTORS = {
  review: { actor: 'openswarm-finding-ledger:reviewer', actorName: 'Finding ledger (reviewer rulings)', actorRole: 'reviewer' },
  answer: { actor: 'openswarm-finding-ledger:worker', actorName: 'Finding ledger (worker answers)', actorRole: 'worker' },
} as const;

type EntryKind = keyof typeof LEDGER_ACTORS;

interface LedgerEntry {
  v: 1;
  kind: EntryKind;
  round: number;
  nextSeq: number;
  finding?: Finding;
  answer?: { id: string } & WorkerResponse;
}

// Thread bodies are capped at 4000 characters and a finding's text, note and
// evidence may each hold 2000. Clip deterministically so every entry fits.
const MAX_BODY = 3_900;
const BUDGETS = [[1_000, 800, 800], [600, 300, 400], [300, 0, 200]] as const;
const PAGE = 200;

function cut(text: string | undefined, max: number): string | undefined {
  if (text === undefined || max <= 0) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function encode(entry: LedgerEntry): string {
  for (const [text, note, evidence] of BUDGETS) {
    const finding = entry.finding && {
      ...entry.finding,
      text: cut(entry.finding.text, text) ?? '',
      lastReviewerNote: cut(entry.finding.lastReviewerNote, note),
      lastWorkerResponse: entry.finding.lastWorkerResponse && {
        ...entry.finding.lastWorkerResponse,
        evidence: cut(entry.finding.lastWorkerResponse.evidence, evidence) ?? '',
      },
    };
    const answer = entry.answer && { ...entry.answer, evidence: cut(entry.answer.evidence, evidence) ?? '' };
    const body = JSON.stringify({ ...entry, ...(finding ? { finding } : {}), ...(answer ? { answer } : {}) });
    if (body.length <= MAX_BODY) return body;
  }
  throw new Error('finding ledger entry does not fit a thread message');
}

function entryKey(scope: LedgerThreadScope, round: number, id: string, kind: EntryKind): string {
  return `${scope.issueKey}:${round}:${id}:${kind}`;
}

/** Create (or find, by idempotency key) the issue's ledger thread. */
async function ledgerThreadId(scope: LedgerThreadScope): Promise<string> {
  const { createCoordinationThread } = await import('../coordination/coordinationThreads.js');
  // Stable inputs only: the creation fingerprint covers subject and body, so
  // anything that varies by run (a title, a timestamp) would collide.
  const thread = createCoordinationThread({
    repository: scope.repository,
    subject: `Finding ledger: ${scope.issueKey}`,
    ...LEDGER_ACTORS.review,
    taskId: scope.taskId,
    taskLabel: scope.taskLabel,
    idempotencyKey: `finding-ledger:${scope.issueKey}`,
  });
  return thread.id;
}

async function readEntries(scope: LedgerThreadScope, threadId: string): Promise<Array<{ actor: string; entry: LedgerEntry }>> {
  const { getCoordinationThread } = await import('../coordination/coordinationThreads.js');
  const out: Array<{ actor: string; entry: LedgerEntry }> = [];
  let after = 0;
  for (;;) {
    const page = getCoordinationThread({ repository: scope.repository, threadId, messageLimit: PAGE, messageAfterSeq: after });
    for (const message of page.messages.items) {
      const entry = parseEntry(message);
      if (entry) out.push({ actor: message.actor, entry });
    }
    if (!page.messages.nextCursor) return out;
    after = Number(page.messages.nextCursor);
  }
}

function parseEntry(message: CoordinationThreadMessage): LedgerEntry | undefined {
  const kind = message.actor === LEDGER_ACTORS.review.actor ? 'review'
    : message.actor === LEDGER_ACTORS.answer.actor ? 'answer' : undefined;
  if (!kind) return undefined;
  try {
    const entry = JSON.parse(message.body) as LedgerEntry;
    if (entry?.v !== 1 || entry.kind !== kind || !Number.isInteger(entry.round) || !Number.isInteger(entry.nextSeq)) return undefined;
    if (kind === 'review' && typeof entry.finding?.id !== 'string') return undefined;
    if (kind === 'answer' && typeof entry.answer?.id !== 'string') return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the issue's ledger from its thread. An issue without entries yields
 * an empty ledger and `roundBase` 0.
 */
export async function loadFindingLedger(scope: LedgerThreadScope): Promise<{ ledger: FindingLedger; threadId: string; roundBase: number }> {
  const threadId = await ledgerThreadId(scope);
  const ledger = createFindingLedger();
  const byId = new Map<string, Finding>();
  const reviewRounds = new Set<number>();
  const workerRounds = new Set<number>();
  let roundBase = 0;
  for (const { entry } of await readEntries(scope, threadId)) {
    roundBase = Math.max(roundBase, entry.round);
    ledger.nextSeq = Math.max(ledger.nextSeq, entry.nextSeq);
    if (entry.kind === 'review' && entry.finding) {
      reviewRounds.add(entry.round);
      byId.set(entry.finding.id, { ...entry.finding });
    } else if (entry.kind === 'answer' && entry.answer) {
      workerRounds.add(entry.round);
      const finding = byId.get(entry.answer.id);
      const { id: _id, ...response } = entry.answer;
      // An answer sets the worker's response, never the status.
      if (finding && (finding.lastWorkerResponse?.round ?? 0) <= response.round) finding.lastWorkerResponse = response;
    }
  }
  for (const finding of byId.values()) {
    ledger.nextSeq = Math.max(ledger.nextSeq, Number(finding.id.slice(1)) + 1);
  }
  ledger.findings = [...byId.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  ledger.reviewRounds = [...reviewRounds].sort((a, b) => a - b);
  ledger.workerRounds = [...workerRounds].sort((a, b) => a - b);
  return { ledger, threadId, roundBase };
}

async function post(state: FindingLedgerThreadState, kind: EntryKind, round: number, id: string, entry: LedgerEntry): Promise<void> {
  try {
    const { postCoordinationThreadMessage } = await import('../coordination/coordinationThreads.js');
    postCoordinationThreadMessage({
      repository: state.scope.repository,
      threadId: state.threadId,
      ...LEDGER_ACTORS[kind],
      taskId: state.scope.taskId,
      taskLabel: state.scope.taskLabel,
      body: encode(entry),
      idempotencyKey: entryKey(state.scope, round, id, kind),
    });
  } catch (error) {
    // Per message: one entry that cannot be written (a key collision on a
    // replay with different text, say) must not drop the rest of the round.
    if (!state.warned) {
      state.warned = true;
      warn('could not append a ledger entry; later rounds are still written', error);
    }
  }
}

/** Append the findings a reviewer round raised, kept open or resolved. */
export async function appendReviewRound(state: FindingLedgerThreadState, ledger: FindingLedger, round: number): Promise<void> {
  for (const finding of ledger.findings) {
    const touched = finding.status === 'open' || finding.resolvedRound === round;
    if (!touched) continue;
    await post(state, 'review', round, finding.id, { v: 1, kind: 'review', round, nextSeq: ledger.nextSeq, finding });
  }
}

/** Append the worker's answers recorded for `round`. */
export async function appendWorkerRound(state: FindingLedgerThreadState, ledger: FindingLedger, round: number): Promise<void> {
  for (const finding of ledger.findings) {
    const response = finding.lastWorkerResponse;
    if (!response || response.round !== round) continue;
    await post(state, 'answer', round, finding.id, { v: 1, kind: 'answer', round, nextSeq: ledger.nextSeq, answer: { id: finding.id, ...response } });
  }
}

// Logged once per run: an unavailable store at start, or the first failed append.
function warn(what: string, error: unknown): void {
  safeConsole.warn(`[FindingLedger] ${what}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Daemon runs only: `runMetadata` is how the daemon names the repository cell
 * a run belongs to. A pipeline built without it (tests, ad-hoc runs) has no
 * durable identity to file the ledger under and stays in memory.
 */
function scopeFor(context: PipelineContext): LedgerThreadScope | undefined {
  if (!context.config.runMetadata) return undefined;
  const who = coordinationContextFor(context, 'reviewer');
  return {
    repository: who.repository,
    taskId: taskEventKey(context.task),
    taskLabel: context.task.issueIdentifier,
    issueKey: taskAttributionKey(context.task),
  };
}

/**
 * At pipeline start: restore the issue's ledger into the context and arm
 * persistence for this run. Leaves the context untouched on failure.
 */
export async function attachDurableLedger(context: PipelineContext): Promise<void> {
  if (context.findingLedgerThread || !context.config.runMetadata) return;
  try {
    const scope = scopeFor(context);
    if (!scope) return;
    const { ledger, threadId, roundBase } = await loadFindingLedger(scope);
    context.findingLedgerThread = { scope, threadId, roundBase };
    if (ledger.findings.length > 0 && !context.findingLedger) {
      context.findingLedger = ledger;
      safeConsole.log(`[${context.taskPrefix}] Finding ledger restored: ${ledger.findings.length} finding(s), next id F${ledger.nextSeq}, rounds continue after ${roundBase}`);
    }
  } catch (error) {
    warn('coordination store unavailable; the ledger stays in memory for this run', error);
  }
}

/** The ledger round for the current iteration: past every restored round. */
export function findingRound(context: PipelineContext): number {
  return (context.findingLedgerThread?.roundBase ?? 0) + context.currentIteration;
}

export async function persistReviewRound(context: PipelineContext, round: number): Promise<void> {
  if (!context.findingLedgerThread || !context.findingLedger) return;
  await appendReviewRound(context.findingLedgerThread, context.findingLedger, round);
}

export async function persistWorkerRound(context: PipelineContext, round: number): Promise<void> {
  if (!context.findingLedgerThread || !context.findingLedger) return;
  await appendWorkerRound(context.findingLedgerThread, context.findingLedger, round);
}

const MAX_QUESTION = 3_000;

/**
 * On a deadlock, ask the advisor which side is right before the loop stops.
 * Published as a `clarification` through the same path as `ask_human`, so the
 * automated advisor may answer it (and the operator is paged when it does
 * not). The answer reaches the next run through the worker's board inbox; the
 * loop still stops here, and nothing is approved. Best-effort: a failed post
 * is logged and the stop goes ahead.
 */
export async function postDeadlockClarification(
  context: PipelineContext,
  ledger: FindingLedger,
  verdict: Extract<LedgerVerdict, { kind: 'deadlock' }>,
  deadlineAt?: number,
): Promise<void> {
  try {
    const who = coordinationContextFor(context, 'worker');
    const question = [
      `Worker and reviewer deadlocked on ${verdict.ids.join(', ')} (${taskAttributionKey(context.task)}).`,
      'The worker disputes each finding below and the reviewer keeps it open. Which side is right?',
      'Answer per id, with the evidence (file:line, test, spec) that settles it.',
      '',
      describeLedgerStop(ledger, verdict, 'en'),
    ].join('\n');
    const { postHumanQuestion } = await import('../coordination/humanQuestions.js');
    const posted = await postHumanQuestion({
      repository: who.repository,
      taskId: who.taskId,
      taskLabel: who.taskLabel,
      actor: who.actor,
      actorName: who.actorName,
      actorRole: who.actorRole,
      question: question.length > MAX_QUESTION ? `${question.slice(0, MAX_QUESTION)}…` : question,
      questionClass: 'clarification',
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    });
    safeConsole.log(`[${context.taskPrefix}] Deadlock clarification posted (${posted.correlationId})${posted.answeredBy ? ` — answered by ${posted.answeredBy}` : ''}`);
  } catch (error) {
    safeConsole.warn(`[${context.taskPrefix}] Deadlock clarification could not be posted: ${error instanceof Error ? error.message : String(error)}`);
  }
}
