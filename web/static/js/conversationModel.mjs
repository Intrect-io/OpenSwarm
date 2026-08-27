// Groups coordination events into readable threads.
//
// The feed used to print `event.summary` alone, which for a system event reads
// "Claude Code rules c480ceccd832 (0 sources)" — no time, no task, no speaker.
// These helpers turn one event into a sentence a person can act on, and a set
// of events into the conversation they actually belong to.

/** Kinds phrased as what happened, not as an internal enum value. */
export const KIND_LABELS = {
  'advice-request': 'asked for advice',
  'advice-response': 'answered',
  'delegation-request': 'delegated work',
  'delegation-result': 'reported back',
  'human-question': 'asked the operator',
  'human-answer': 'operator answered',
  'adapter-route': 'switched provider',
  'review-run': 'ran a review',
  'mcp-audit': 'tool access decision',
  'instruction-snapshot': 'loaded the rule set',
};

const ROLE_LABELS = {
  worker: 'worker',
  reviewer: 'reviewer',
  orchestrator: 'orchestrator',
  'review-agent': 'review agent',
  daemon: 'daemon',
  human: 'operator',
};

/** A speaker as it should be printed: call sign plus what it was running as. */
export function speakerOf(event) {
  const name = event.actorName || event.actor;
  const role = ROLE_LABELS[event.actorRole] || event.actorRole;
  return role ? `${name} (${role})` : name;
}

export function addresseeOf(event) {
  if (!event.recipient && !event.recipientName) return null;
  const name = event.recipientName || event.recipient;
  const role = ROLE_LABELS[event.recipientRole] || event.recipientRole;
  return role ? `${name} (${role})` : name;
}

/**
 * Short human name for the task an event belongs to. `taskId` is an issue UUID,
 * so fall back to a truncation only when no publisher stamped a label.
 */
export function taskLabelOf(event) {
  if (event.taskLabel) return event.taskLabel;
  if (!event.taskId) return '';
  return event.taskId.length > 12 ? `${event.taskId.slice(0, 8)}…` : event.taskId;
}

/** One-line description: who did what, to whom. */
export function describeEvent(event) {
  const what = KIND_LABELS[event.kind] || event.kind;
  const to = addresseeOf(event);
  return to ? `${speakerOf(event)} ${what} → ${to}` : `${speakerOf(event)} ${what}`;
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
