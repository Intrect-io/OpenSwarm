// ============================================
// OpenSwarm - Durable coordination event store
// ============================================

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coordinationFilePath, coordinationStateDir } from './coordinationPaths.js';
import { recordTraceEvent } from './coordinationTrace.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';
import { broadcastEvent } from '../core/eventHub.js';

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
  | 'instruction-snapshot';

export type CoordinationStatus = 'open' | 'waiting' | 'running' | 'completed' | 'failed' | 'expired';

export interface CoordinationEvent {
  id: string;
  seq: number;
  timestamp: number;
  repository: string;
  taskId: string;
  /**
   * Human-readable name for `taskId`, which is an issue UUID. Publishers stamp
   * the issue identifier (e.g. `AGT-4001`) when they know it so the dashboard
   * can say which issue an event belongs to instead of printing a UUID.
   */
  taskLabel?: string;
  actor: string;
  actorName?: string;
  /** Role the actor was running as (worker/reviewer/orchestrator/review-agent/daemon/human). Absent on legacy events. */
  actorRole?: string;
  recipient?: string;
  recipientName?: string;
  /** Role of the addressee, when the publisher knows it. */
  recipientRole?: string;
  kind: CoordinationKind;
  status: CoordinationStatus;
  correlationId: string;
  summary: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
  fingerprint: string;
}

interface CoordinationState {
  version: 1;
  nextSeq: number;
  events: CoordinationEvent[];
  consumed: Record<string, string[]>;
}

export interface PublishCoordinationEvent {
  id?: string;
  repository: string;
  taskId: string;
  taskLabel?: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  recipient?: string;
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
  const clean: NonNullable<PublishCoordinationEvent['metadata']> = {};
  for (const [key, value] of Object.entries(metadata)) {
    clean[key] = SECRET_FIELD.test(key)
      ? '[redacted]'
      : typeof value === 'string'
        ? cleanText(value, 500)
        : value;
  }
  return clean;
}

function fingerprint(input: PublishCoordinationEvent): string {
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
   */
  private async mutate<T>(operation: (state: CoordinationState) => T): Promise<T> {
    let result!: T;
    let failure: unknown;
    this.writeQueue = this.writeQueue.then(async () => {
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
    await this.writeQueue;
    if (failure) throw failure;
    return result;
  }

  async publish(input: PublishCoordinationEvent): Promise<CoordinationEvent> {
    const normalized: PublishCoordinationEvent = {
      ...input,
      repository: resolve(input.repository),
      correlationId: input.correlationId ?? randomUUID(),
      summary: cleanText(input.summary, MAX_SUMMARY),
      detail: input.detail ? cleanText(input.detail, MAX_DETAIL) : undefined,
      metadata: redactCoordinationMetadata(input.metadata),
    };
    const digest = fingerprint(normalized);
    let isNew = true;
    const event = await this.mutate((state) => {
      const existing = state.events.find((candidate) => candidate.fingerprint === digest);
      if (existing) {
        isNew = false;
        return existing;
      }
      const created: CoordinationEvent = {
        id: input.id ?? randomUUID(),
        seq: state.nextSeq++,
        timestamp: input.timestamp ?? Date.now(),
        repository: normalized.repository,
        taskId: normalized.taskId,
        // Outside the fingerprint with the roles below: a label is a display
        // name for the same task, so it must not split content dedup.
        taskLabel: normalized.taskLabel,
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
    });
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

  list(options: { repository?: string; taskId?: string; afterSeq?: number; limit?: number } = {}): CoordinationEvent[] {
    const state = this.load();
    const repository = options.repository ? resolve(options.repository) : undefined;
    return state.events
      .filter((event) => !repository || event.repository === repository)
      .filter((event) => !options.taskId || event.taskId === options.taskId)
      .filter((event) => event.seq > (options.afterSeq ?? 0))
      .slice(-(Math.min(Math.max(options.limit ?? 200, 0), 500)));
  }

  /**
   * Locate a still-waiting human question anywhere in the retained board.
   *
   * Deliberately not `list()`: that caps at the most recent 500 events, and an
   * operator answering an old question must not be told it does not exist just
   * because the board has been busy since it was asked.
   */
  findQuestion(correlationId: string): CoordinationEvent | undefined {
    return this.load().events.find((event) =>
      event.correlationId === correlationId && event.kind === 'human-question' && event.status === 'waiting');
  }

  /**
   * The blocking question an agent is still parked on.
   *
   * The dashboard can only reason about the events it has loaded, which is a
   * window over a ring buffer — a question older than that window is invisible
   * to it, and an operator's reply would be filed as an ordinary note while the
   * agent stayed blocked. The retained board is here, so the decision belongs
   * here (AGT-4030).
   *
   * The newest unsettled question wins when several are open: a run stops at
   * the question it asked, so the latest is what the agent is parked on and
   * what the operator is reading.
   */
  /**
   * How many blocking questions this task has asked and not yet had answered,
   * regardless of exact wording. 0 means nothing is outstanding.
   *
   * Counts distinct correlation IDs, not raw events: a paged question carries
   * two events (the `waiting` ask, the `running` page confirmation) under the
   * same correlation ID, and a re-dispatch that rephrases the same blocker
   * mints a different one for the same underlying wait (AGT-4042).
   */
  openQuestionCount(repository: string, taskId: string): number {
    const events = this.list({ repository, taskId, limit: 500 });
    const settled = new Set(events
      .filter((event) => event.kind === 'human-answer' && event.status === 'completed')
      .map((event) => event.correlationId));
    return new Set(events
      .filter((event) =>
        event.kind === 'human-question'
        && (event.status === 'waiting' || event.status === 'running')
        && !settled.has(event.correlationId))
      .map((event) => event.correlationId)).size;
  }

  findOpenQuestionFor(
    actor: string,
    scope: { repository?: string; taskId?: string } = {},
  ): CoordinationEvent | undefined {
    // An address is not unique on its own: agents name themselves, so two on
    // different tasks can both answer to "sable". The caller passes the task it
    // is speaking into, and without one this refuses rather than guessing —
    // answering the wrong task's blocking question would unpark an agent with
    // an answer meant for someone else.
    if (!scope.taskId && !scope.repository) return undefined;
    const repository = scope.repository ? resolve(scope.repository) : undefined;
    const events = this.load().events;
    const settled = new Set(events
      .filter((event) => ['completed', 'expired', 'failed'].includes(event.status))
      .map((event) => event.correlationId));
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.kind === 'human-question'
        && event.status === 'waiting'
        && event.actor === actor
        && (!repository || event.repository === repository)
        && (!scope.taskId || event.taskId === scope.taskId)
        && !settled.has(event.correlationId)) return event;
    }
    return undefined;
  }

  async consume(consumer: string, options: { repository?: string; taskId?: string; includeAll?: boolean }): Promise<CoordinationEvent[]> {
    return this.mutate((state) => {
      const seen = new Set(state.consumed[consumer] ?? []);
      const repository = options.repository ? resolve(options.repository) : undefined;
      const events = state.events.filter((event) =>
        (!repository || event.repository === repository)
        && (!options.taskId || event.taskId === options.taskId)
        && (options.includeAll || !event.recipient || event.recipient === consumer)
        && !seen.has(event.id));
      state.consumed[consumer] = [...seen, ...events.map((event) => event.id)].slice(-MAX_EVENTS);
      return events;
    });
  }

  snapshot(repository?: string): { events: CoordinationEvent[]; pending: CoordinationEvent[] } {
    const events = this.list({ repository, limit: 500 });
    const latest = new Map<string, CoordinationEvent>();
    for (const event of events) {
      const previous = latest.get(event.correlationId);
      if (!previous || event.seq > previous.seq) latest.set(event.correlationId, event);
    }
    return {
      events,
      pending: [...latest.values()].filter((event) => ['open', 'waiting', 'running'].includes(event.status)),
    };
  }
}

let defaultStore: CoordinationStore | undefined;
export function getCoordinationStore(): CoordinationStore {
  defaultStore ??= new CoordinationStore();
  return defaultStore;
}

export function resetCoordinationStoreForTests(): void {
  defaultStore = undefined;
}
