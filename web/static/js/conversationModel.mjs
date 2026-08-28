// Groups coordination events into readable threads.
//
// The feed used to print `event.summary` alone, which for a system event reads
// "Claude Code rules c480ceccd832 (0 sources)" — no time, no task, no speaker.
// These helpers turn one event into a sentence a person can act on, and a set
// of events into the conversation they actually belong to.

const ROLE_LABELS = {
  worker: 'worker',
  reviewer: 'reviewer',
  orchestrator: 'orchestrator',
  'review-agent': 'review agent',
  daemon: 'daemon',
  human: 'operator',
};

/**
 * Short human name for the task an event belongs to. `taskId` is an issue UUID,
 * so fall back to a truncation only when no publisher stamped a label.
 */
export function taskLabelOf(event) {
  if (event.taskLabel) return event.taskLabel;
  if (!event.taskId) return '';
  return event.taskId.length > 12 ? `${event.taskId.slice(0, 8)}…` : event.taskId;
}

/** Metadata rendered as ordered key/value pairs; secrets are redacted upstream. */
export function metadataPairs(event) {
  if (!event.metadata || typeof event.metadata !== 'object') return [];
  return Object.entries(event.metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)]);
}

/**
 * Group events into conversations keyed by correlation id, newest thread first.
 *
 * Ordering inside a thread is by `seq`, not timestamp: two events published in
 * the same millisecond are common (a request and its immediate ack), and
 * timestamp ordering would shuffle them.
 */
export function buildThreads(events) {
  const byCorrelation = new Map();
  for (const event of events) {
    const key = event.correlationId || event.id;
    let thread = byCorrelation.get(key);
    if (!thread) {
      thread = {
        correlationId: key,
        events: [],
        participants: [],
        taskId: event.taskId,
        taskLabel: event.taskLabel,
        lastSeq: 0,
        lastSeen: 0,
        pending: false,
      };
      byCorrelation.set(key, thread);
    }
    thread.events.push(event);
  }

  const threads = [];
  for (const thread of byCorrelation.values()) {
    thread.events.sort((a, b) => a.seq - b.seq);
    const seen = new Map();
    for (const event of thread.events) {
      if (event.actor && !seen.has(event.actor)) {
        seen.set(event.actor, { address: event.actor, name: event.actorName || event.actor, role: event.actorRole });
      }
      if (event.recipient && !seen.has(event.recipient)) {
        seen.set(event.recipient, { address: event.recipient, name: event.recipientName || event.recipient, role: event.recipientRole });
      }
      // A label may only appear on later events in a thread; adopt the first one.
      if (!thread.taskLabel && event.taskLabel) thread.taskLabel = event.taskLabel;
    }
    thread.participants = [...seen.values()];
    const last = thread.events[thread.events.length - 1];
    thread.lastSeq = last.seq;
    thread.lastSeen = last.timestamp;
    thread.subject = thread.events[0].summary;
    // Pending means the exchange is still waiting on someone: the final state
    // of the thread decides, not whether any single event was ever open.
    thread.pending = ['open', 'waiting', 'running'].includes(last.status);
    // The operator can only speak to an agent that is addressable, which is the
    // last non-human speaker in the thread.
    const lastAgent = [...thread.events].reverse().find((event) => event.actorRole !== 'human');
    thread.replyTo = lastAgent
      ? { address: lastAgent.actor, name: lastAgent.actorName || lastAgent.actor }
      : null;
    thread.awaitingOperator = thread.events.some(
      (event) => event.kind === 'human-question' && ['open', 'waiting'].includes(event.status),
    ) && !thread.events.some((event) => event.kind === 'human-answer');
    threads.push(thread);
  }

  threads.sort((a, b) => b.lastSeq - a.lastSeq);
  return threads;
}

/** The thread an event belongs to, or null when it is not in the given set. */
export function threadFor(threads, event) {
  if (!event) return null;
  const key = event.correlationId || event.id;
  return threads.find((thread) => thread.correlationId === key) ?? null;
}

/**
 * Kinds that are plumbing, not speech. An instruction snapshot records which
 * rule set an agent loaded; nobody said anything, so no conversation surface
 * (feed, thread transcript, chat room) should print it as an utterance.
 */
export const NON_CONVERSATION_KINDS = new Set(['instruction-snapshot']);

/** True when the event is something an agent or the operator actually said. */
export function isUtterance(event) {
  return !NON_CONVERSATION_KINDS.has(event.kind);
}

/**
 * One event as a line of dialogue. `detail` carries the speaker's full words
 * and `summary` only a clipped preview, so the line prefers the former.
 */
export function chatLineOf(event) {
  return {
    id: event.id,
    seq: event.seq,
    timestamp: event.timestamp,
    speakerName: event.actorName || event.actor,
    /** Raw role for programmatic use (color maps); the label for display. */
    role: event.actorRole || '',
    speakerRole: ROLE_LABELS[event.actorRole] || event.actorRole || '',
    recipientName: event.recipientName || event.recipient || null,
    text: event.detail || event.summary || '',
    taskLabel: taskLabelOf(event),
    status: event.status,
    kind: event.kind,
    isOperator: event.actorRole === 'human',
  };
}

/** Every utterance across every task, oldest first — the chat room's content. */
export function buildChatLines(events) {
  return events
    .filter(isUtterance)
    .sort((a, b) => a.seq - b.seq)
    .map(chatLineOf);
}

/**
 * The newest agent the operator can speak to: the last non-human speaker of an
 * actual utterance. A daemon's instruction snapshot is not a speaker, and the
 * operator cannot address themselves.
 */
/**
 * The blocking question an agent is still parked on, if any.
 *
 * An operator writing to an agent that is waiting on them means "here is your
 * answer" — but the daemon only turns a message into a `human-answer` when its
 * correlation id names a pending question. Addressing the newest exchange
 * instead files a note the agent never unparks on, which is what left ten
 * agents waiting with no way to reply (AGT-4030).
 */
export function openQuestionFor(events, actorAddress, scope = {}) {
  if (!actorAddress) return null;
  // An address is not unique: agents name themselves, so two on different tasks
  // can both answer to "sable", and the room shows every task at once. Without
  // the task this would offer to answer someone else's blocking question.
  if (!scope.taskId && !scope.repository) return null;
  // A later terminal event on the same exchange means the question was answered
  // or expired since; the board keeps both. Settle each candidate before
  // picking, not after — an agent can be parked on an older question while a
  // newer one has already been resolved, and taking the newest first would
  // report "nothing open" and file the reply as a note.
  const open = events
    .filter((event) => event.kind === 'human-question'
      && event.status === 'waiting'
      && event.actor === actorAddress
      && (!scope.repository || event.repository === scope.repository)
      && (!scope.taskId || event.taskId === scope.taskId))
    .filter((question) => !events.some((event) => event.correlationId === question.correlationId
      && event.seq > question.seq
      && ['completed', 'expired', 'failed'].includes(event.status)))
    .sort((a, b) => a.seq - b.seq);
  return open[open.length - 1] ?? null;
}

export function latestAddressable(events) {
  const spoken = events.filter(isUtterance).sort((a, b) => a.seq - b.seq);
  for (let i = spoken.length - 1; i >= 0; i -= 1) {
    if (spoken[i].actorRole !== 'human') return spoken[i];
  }
  return null;
}
