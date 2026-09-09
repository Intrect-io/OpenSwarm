// ============================================
// OpenSwarm - Durable coordination event store
// ============================================

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coordinationFilePath, coordinationStateDir } from './coordinationPaths.js';
import {
  lastTraceEventOfKind,
  questionStandings,
  queryTrace,
  recordTraceEvent,
  resolvedHumanAnswers,
  type ResolvedHumanAnswer,
} from './coordinationTrace.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';
import { broadcastEvent } from '../core/eventHub.js';
import { coordinationPeers, repositoryKey, type CoordinationPeer } from './repositoryCell.js';

export type CoordinationKind =
  | 'advice-request'
  | 'advice-response'
  | 'delegation-request'
  | 'delegation-result'
  | 'human-question'
  | 'human-answer'
  | 'adapter-route'
  | 'review-run'
  | 'mcp-audit'
  | 'thread-update'
  | 'council-update'
  | 'instruction-snapshot';

export type CoordinationStatus = 'open' | 'waiting' | 'running' | 'completed' | 'failed' | 'expired';

export interface CoordinationEvent {
  id: string;
  seq: number;
  timestamp: number;
  repository: string;
  /** Canonical repository-cell identity shared by sibling Git worktrees. */
  repoKey?: string;
  taskId: string;
  taskLabel?: string;
  sourceTaskId: string;
  sourceTaskLabel?: string;
  targetTaskId: string;
  targetTaskLabel?: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  recipient: string;
  recipientName?: string;
  recipientRole?: string;
  kind: CoordinationKind;
  status: CoordinationStatus;
  correlationId: string;
  summary: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
  fingerprint: string;
}

export interface PublishCoordinationEvent {
  id?: string;
  repository: string;
  repoKey?: string;
  taskId: string;
  taskLabel?: string;
  sourceTaskId?: string;
  sourceTaskLabel?: string;
  targetTaskId?: string;
  targetTaskLabel?: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  recipient: string;
  recipientName?: string;
  recipientRole?: string;
  kind: CoordinationKind;
  status: CoordinationStatus;
  correlationId?: string;
  summary: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
  timestamp?: number;
}

const MAX_EVENTS = 2_000;
const MAX_SUMMARY = 500;
const MAX_DETAIL = 4_000;
const SECRET_FIELD = /(token|secret|password|authorization|cookie|api[-_]?key)/i;
const SECRET_VALUE = /(bearer\s+[A-Za-z0-9._~+/-]+|(?:sk|ghp|xox[baprs])_?[-A-Za-z0-9_]{8,})/gi;

function emptyState(): CoordinationState {
  return { version: 1, nextSeq: 1, events: [], consumed: {} };
}

function parseState(value: unknown): CoordinationState {
  if (!value || typeof value !== 'object') throw new Error('coordination state must be an object');
  const state = value as Partial<CoordinationState>;
  if (state.version !== 1 || !Number.isInteger(state.nextSeq) || !Array.isArray(state.events)) {
    throw new Error('coordination state has an unsupported or corrupt shape');
  }
  return {
    version: 1,
    nextSeq: state.nextSeq!,
    events: state.events as CoordinationEvent[],
    consumed: state.consumed && typeof state.consumed === 'object' ? state.consumed : {},
  };
}

function cleanText(value: string, limit: number): string {
  return value.replace(SECRET_VALUE, '[redacted]').slice(0, limit);
}

export function redactCoordinationMetadata(
  metadata: PublishCoordinationEvent['metadata'],
): PublishCoordinationEvent['metadata'] {
  if (!metadata) return undefined;
  const redacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = SECRET_FIELD.test(key) ? '[redacted]' : value;
  }
  return redacted;
}

export interface CoordinationState {
  version: number;
  nextSeq: number;
  events: CoordinationEvent[];
  consumed: Record<string, string[]>;
}

function fingerprint(input: PublishCoordinationEvent): string {
  return createHash('sha256').update(JSON.stringify({
    repository: input.repository,
    repoKey: input.repoKey,
    taskId: input.taskId,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    actor: input.actor,
    recipient: input.recipient,
    kind: input.kind,
    status: input.status,
    correlationId: input.correlationId,
    summary: cleanText(input.summary, MAX_SUMMARY),
    detail: cleanText(input.detail ?? '', MAX_DETAIL),
    metadata: redactCoordinationMetadata(input.metadata),
  })).digest('hex');
}

/** Pre-AGT-4131 digest, retained only to deduplicate same-task replays. */
function legacyFingerprint(input: PublishCoordinationEvent): string {
  return createHash('sha256').update(JSON.stringify({
    repository: input.repository,
    taskId: input.taskId,
    actor: input.actor,
    recipient: input.recipient,
    kind: input.kind,
    status: input.status,
    correlationId: input.correlationId,
    summary: cleanText(input.summary, MAX_SUMMARY),
    detail: cleanText(input.detail ?? '', MAX_DETAIL),
    metadata: redactCoordinationMetadata(input.metadata),
  })).digest('hex');
}

export { coordinationFilePath, coordinationStateDir };

export class CoordinationStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private priorityWriteQueue: Promise<void> = Promise.resolve();

  constructor(path = coordinationFilePath()) {
    this.path = resolve(path);
  }

  private load(): CoordinationState {
    if (!existsSync(this.path)) return emptyState();
    try {
      return parseState(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      throw new Error(`Coordination store is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Serialize one read-modify-write against the board.
   *
   * The in-process queue orders the daemon's own writers; the file lock orders
   * writers in *other* processes — a standalone `openswarm review`, a second
   * daemon on the same home directory. Without it two processes can both read
   * seq=N and both write seq=N+1, which silently drops one event and duplicates
   * a sequence the dashboard uses to reconcile its stream.
   *
   * When `priority` is true the operation runs on a separate `priorityWriteQueue`
   * that is not blocked by the main `writeQueue`. This is used for `human-answer`
   * events so an operator reply completes in well under a second while tasks are
   * running. Both queues still acquire the same cross-process file lock, so seq
   * integrity is preserved.
   */
  private async mutate<T>(operation: (state: CoordinationState) => T, priority = false): Promise<T> {
    let result!: T;
    let failure: unknown;
    const queue = priority ? this.priorityWriteQueue : this.writeQueue;
    const next = queue.then(async () => {
      try {
        result = await withFileLock(`${this.path}.lock`, async () => {
          const state = this.load();
          const value = operation(state);
          atomicWriteFileSync(this.path, JSON.stringify(state, null, 2), 0o600);
          return value;
        });
      } catch (error) { // cxt-ignore: error_swallow,exception_hiding — rethrown after the queue settles (`if (failure) throw failure`)
        failure = error;
      }
    });
    if (priority) {
      this.priorityWriteQueue = next;
    } else {
      this.writeQueue = next;
    }
    await next;
    if (failure) throw failure;
    return result;
  }

  async publish(input: PublishCoordinationEvent): Promise<CoordinationEvent> {
    const sourceTaskId = input.sourceTaskId ?? input.taskId;
    const sourceTaskLabel = input.sourceTaskLabel ?? input.taskLabel;
    const targetTaskId = input.targetTaskId ?? sourceTaskId;
    const targetTaskLabel = input.targetTaskLabel ?? sourceTaskLabel;
    const normalized: PublishCoordinationEvent = {
      ...input,
      repository: resolve(input.repository),
      repoKey: repositoryKey(input.repoKey, input.repository),
      taskId: sourceTaskId,
      taskLabel: sourceTaskLabel,
      sourceTaskId,
      sourceTaskLabel,
      targetTaskId,
      targetTaskLabel,
      correlationId: input.correlationId ?? randomUUID(),
      summary: cleanText(input.summary, MAX_SUMMARY),
      detail: input.detail ? cleanText(input.detail, MAX_DETAIL) : undefined,
      metadata: redactCoordinationMetadata(input.metadata),
    };
    const digest = fingerprint(normalized);
    const legacyDigest = normalized.sourceTaskId === normalized.targetTaskId
      ? legacyFingerprint(normalized)
      : undefined;
    let isNew = true;
    const isPriority = normalized.kind === 'human-answer';
    const event = await this.mutate((state) => {
      const existing = state.events.find((candidate) => candidate.fingerprint === digest
        || (legacyDigest !== undefined
          && candidate.repoKey === undefined
          && candidate.sourceTaskId === undefined
          && candidate.targetTaskId === undefined
          && candidate.fingerprint === legacyDigest));
      if (existing) {
        isNew = false;
        return existing;
      }
      const created: CoordinationEvent = {
        id: input.id ?? randomUUID(),
        seq: state.nextSeq++,
        timestamp: input.timestamp ?? Date.now(),
        repository: normalized.repository,
        repoKey: normalized.repoKey,
        taskId: normalized.taskId,
        // Outside the fingerprint with the roles below: a label is a display
        // name for the same task, so it must not split content dedup.
        taskLabel: normalized.taskLabel,
        sourceTaskId: normalized.sourceTaskId,
        sourceTaskLabel: normalized.sourceTaskLabel,
        targetTaskId: normalized.targetTaskId,
        targetTaskLabel: normalized.targetTaskLabel,
        actor: normalized.actor,
        actorName: normalized.actorName,
        // Deliberately outside the fingerprint: roles describe the identity,
        // and a role-only difference must not defeat content dedup.
        actorRole: normalized.actorRole,
        recipient: normalized.recipient,
        recipientName: normalized.recipientName,
        recipientRole: normalized.recipientRole,
        kind: normalized.kind,
        status: normalized.status,
        correlationId: normalized.correlationId!,
        summary: normalized.summary,
        detail: normalized.detail,
        metadata: normalized.metadata,
        fingerprint: digest,
      };
      state.events.push(created);
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
      const liveIds = new Set(state.events.map((item) => item.id));
      for (const [consumer, ids] of Object.entries(state.consumed)) {
        state.consumed[consumer] = ids.filter((id) => liveIds.has(id));
      }
      return created;
    }, isPriority);
    // Announce only genuinely new events. A deduplicated publish is not news:
    // it would add a second dashboard row for one message, and — because the
    // Linear board mirror listens on 'coordination:published' — echo an event
    // imported *from* that board straight back to it.
    if (isNew) {
      // Archive before announcing. The board evicts old events; the trace does
      // not, so this is the only record that survives the ring buffer. It is
      // best-effort by construction — recordTraceEvent never throws.
      recordTraceEvent(event);
      broadcastEvent({ type: 'coordination:event', data: event });
      const { getEventHub } = await import('../core/eventHub.js');
      getEventHub().emit('coordination:published', event);
    }
    return event;
  }

  async consume(consumer: string, options: { repository?: string; repoKey?: string; taskId?: string; includeAll?: boolean }): Promise<CoordinationEvent[]> {
    return this.mutate((state) => {
      const scope = JSON.stringify([options.repoKey ?? options.repository ?? '', options.taskId ?? '', consumer]);
      // Read the legacy address-only bucket as well so an upgrade cannot
      // redeliver mail that this agent consumed before scoped identities existed.
      const seen = new Set([...(state.consumed[scope] ?? []), ...(state.consumed[consumer] ?? [])]);
      const fresh = state.events.filter((event) => !seen.has(event.id));
      if (options.includeAll) return fresh;
      const scopeKey = options.repoKey ?? options.repository ?? '';
      return fresh.filter((event) => {
        if (event.repoKey) return event.repoKey === scopeKey;
        return event.repository === scopeKey;
      });
    });
  }

  markConsumed(consumer: string, eventIds: string[], options: { repository?: string; repoKey?: string; taskId?: string } = {}): Promise<void> {
    return this.mutate((state) => {
      const scope = JSON.stringify([options.repoKey ?? options.repository ?? '', options.taskId ?? '', consumer]);
      const bucket = state.consumed[scope] ??= [];
      for (const id of eventIds) {
        if (!bucket.includes(id)) bucket.push(id);
      }
      // Also write to the legacy address-only bucket so a downgrade does not
      // redeliver mail this agent already consumed.
      const legacy = state.consumed[consumer] ??= [];
      for (const id of eventIds) {
        if (!legacy.includes(id)) legacy.push(id);
      }
    });
  }

  read(): CoordinationEvent[] {
    return this.load().events;
  }

  state(): CoordinationState {
    return this.load();
  }

  exchange(correlationId: string): CoordinationEvent[] {
    return this.load().events.filter((event) => event.correlationId === correlationId);
  }

  openQuestionCount(repository: string, taskId: string): number {
    const state = this.load();
    const settled = new Set<string>();
    for (const event of state.events) {
      if (event.kind === 'human-answer' && event.status === 'completed') {
        settled.add(event.correlationId);
      }
    }
    return new Set(state.events
      .filter((event) => event.kind === 'human-question'
        && event.status === 'waiting'
        && event.repository === repository
        && event.taskId === taskId
        && !settled.has(event.correlationId))
      .map((event) => event.correlationId)).size;
  }

  /**
   * One event per still-open (not yet completed/expired/failed) question
   * correlation ID for a task, durable trace merged with the board.
   *
   * Unlike `openQuestionCount`, this is not a display counter — it backs the
   * answer fan-out that settles every differently-worded re-ask of the same
   * blocker. A board-only read there would leave an older sibling permanently
   * unanswered in the durable trace once enough other traffic evicted it from
   * the board, and `allQuestionsAnswered` would never see that task as
   * unblocked.
   */
  allQuestionsAnswered(taskId: string): boolean {
    const state = this.load();
    const settled = new Set<string>();
    for (const event of state.events) {
      if (event.kind === 'human-answer' && event.status === 'completed') {
        settled.add(event.correlationId);
      }
    }
    const boardOpen = new Set(state.events
      .filter((event) => event.kind === 'human-question' && event.status === 'waiting' && event.taskId === taskId)
      .map((event) => event.correlationId));
    // Remove board-settled questions from the trace set so we only check
    // questions that the board has already evicted.
    const traceOpen = queryTrace(taskId)
      .filter((event) => event.kind === 'human-question' && event.status === 'waiting')
      .filter((event) => !boardOpen.has(event.correlationId))
      .filter((event) => !settled.has(event.correlationId));
    return boardOpen.size === 0 && traceOpen.length === 0;
  }

  /**
   * Return the most recent `human-answer` for each open question correlation
   * ID, merging board and durable trace. Used by `askHuman` to replay answers
   * after a restart.
   */
  resolvedHumanAnswers(taskId: string): ResolvedHumanAnswer[] {
    return resolvedHumanAnswers(taskId, this.load().events);
  }

  /**
   * Return the most recent event of a given kind for a task, checking the board
   * first and falling back to the durable trace.
   */
  lastEventOfKind(taskId: string, kind: CoordinationKind): CoordinationEvent | undefined {
    const board = this.load().events.filter((event) => event.taskId === taskId && event.kind === kind);
    if (board.length > 0) return board[board.length - 1];
    return lastTraceEventOfKind(taskId, kind);
  }

  /**
   * Return the most recent event matching a predicate, checking the board first
   * and falling back to the durable trace.
   */
  lastEvent(taskId: string, predicate: (event: CoordinationEvent) => boolean): CoordinationEvent | undefined {
    const board = this.load().events.filter((event) => event.taskId === taskId && predicate(event));
    if (board.length > 0) return board[board.length - 1];
    return lastTraceEventOfKind(taskId, undefined, predicate);
  }

  /**
   * Return the most recent event with a given correlationId, checking the board
   * first and falling back to the durable trace.
   */
  eventByCorrelationId(correlationId: string): CoordinationEvent | undefined {
    const board = this.load().events.filter((event) => event.correlationId === correlationId);
    if (board.length > 0) return board[board.length - 1];
    return queryTrace(undefined, correlationId).pop();
  }
}

let singleton: CoordinationStore | undefined;

export function getCoordinationStore(): CoordinationStore {
  if (!singleton) singleton = new CoordinationStore();
  return singleton;
}

export function resetCoordinationStoreForTests(): void {
  singleton = undefined;
}