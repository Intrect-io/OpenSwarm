// ============================================
// OpenSwarm - Agent coordination tool contracts
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';
import { getCoordinationStore, type CoordinationKind } from './coordinationStore.js';
import { postHumanQuestion } from './humanQuestions.js';
import { callSignAddress } from './agentNames.js';

/**
 * Bounds on `coordination_wait`.
 *
 * A wait sits inside a stage that has its own wall clock — worker 20 min,
 * reviewer and tester 6 min (`src/agents/stageTimeouts.ts`) — and inside an
 * agentic loop whose own deadline defaults to 5 minutes. Waiting must never be
 * a way to burn that budget and fail the stage as an infrastructure error, so
 * a requested timeout is clamped hard. (AGT-4065)
 */
export const COORDINATION_WAIT_MAX_MS = 60_000;
export const COORDINATION_WAIT_DEFAULT_MS = 20_000;

/**
 * Headroom left for the loop to wrap up after a wait returns — emit a final
 * message, write its result. A wait that ran right up to the deadline would
 * take the answer and then have the loop time out anyway.
 */
export const COORDINATION_WAIT_LOOP_MARGIN_MS = 5_000;

/**
 * Clamp a model-supplied wait to something the enclosing run can afford.
 *
 * The fixed ceiling is not enough on its own: a loop with 8 seconds left would
 * still grant a 60-second wait and then report a timeout instead of the answer
 * that was about to arrive. When the caller knows its deadline, that wins.
 * (AGT-4065, caught by the PR review.)
 */
export function resolveWaitMs(requested: unknown, loopDeadlineAt?: number, now: number = Date.now()): number {
  const value = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : COORDINATION_WAIT_DEFAULT_MS;
  let capped = Math.min(COORDINATION_WAIT_MAX_MS, Math.max(0, Math.trunc(value)));
  if (typeof loopDeadlineAt === 'number' && Number.isFinite(loopDeadlineAt)) {
    capped = Math.min(capped, Math.max(0, loopDeadlineAt - now - COORDINATION_WAIT_LOOP_MARGIN_MS));
  }
  return capped;
}

export interface CoordinationToolContext {
  repository: string;
  taskId: string;
  /** Issue identifier for `taskId`, carried onto everything this agent publishes. */
  taskLabel?: string;
  /** Routable address other agents send to. */
  actor: string;
  /** Human-facing call sign shown in reports and the dashboard. */
  actorName?: string;
  /** Role this agent runs as; stamped on everything it publishes. */
  actorRole?: string;
  /** Overridable operator notifier; defaults to the configured Discord channel. */
  notifyOperator?: (message: string) => Promise<boolean>;
}

export const COORDINATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'coordination_read',
      description: 'Read new advice, delegation, and response messages addressed to this agent on the repository board. Each message names the agent that sent it.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_wait',
      description: 'Wait for the next message addressed to this agent, up to timeout_ms. Returns as soon as something arrives, or an empty list at the deadline. Use it after asking a peer or the operator something, instead of guessing an answer or giving up.',
      parameters: {
        type: 'object',
        properties: {
          timeout_ms: { type: 'number', description: 'How long to wait, in milliseconds. Clamped to the time this stage has left.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_publish',
      description: 'Publish an advice request/response or delegation request/result to another OpenSwarm agent. Address it by call sign (the name the agent goes by on the board). Use a correlation_id to continue an existing exchange.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['advice-request', 'advice-response', 'delegation-request', 'delegation-result'] },
          recipient: { type: 'string', description: "The target agent's call sign or address" },
          correlation_id: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['kind', 'recipient', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_history',
      description: 'Search the permanent coordination trace — every message ever exchanged on this repository, including ones already dropped from the live board. Use it to find what was decided earlier on this task or in a past exchange, instead of re-asking. Unlike coordination_read this consumes nothing and returns messages regardless of who they were addressed to.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Restrict to one task. Defaults to the current task; pass "*" for the whole repository.' },
          task_label: { type: 'string', description: 'Restrict to an issue identifier, for example "AGT-4001".' },
          correlation_id: { type: 'string', description: 'Restrict to one exchange.' },
          participant: { type: 'string', description: 'Restrict to messages sent to or from this agent address.' },
          limit: { type: 'number', description: 'Maximum messages to return (default 50, max 200).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_human',
      description: 'Page the operator on Discord with one blocking decision. Returns a correlation ID; the operator answers later, so stop this run and report the open decision rather than inventing an answer or continuing past it.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
];

/**
 * Appended to a worker/reviewer's system prompt whenever it has a
 * coordinationContext, alongside the periodic in-loop nudge
 * (src/adapters/agenticLoop.ts's shouldNudgeCoordinationCheck). The nudge
 * says *when* to check; this says *why it matters and what a good response
 * looks like*, so it stays short — the nudge message itself carries the
 * "do it now" instruction. (AGT-4054)
 */
/**
 * The tool names this module dispatches, derived from the definitions above.
 *
 * The adapter used to carry its own hardcoded copy of this list, so adding a
 * tool here left it undispatchable until someone noticed. (AGT-4065)
 */
export const COORDINATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  COORDINATION_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

export const COORDINATION_GUIDANCE_PROMPT = `

## Coordination inbox

An operator or another agent may message you mid-task through the
coordination board, without you asking first. If you check your inbox
(\`coordination_read\`) and find a message that is not a reply to something
you initiated, acknowledge it with \`coordination_publish\` before you finish
your work — do not just silently fold it into your next edit with no
response.
`;

export async function executeCoordinationTool(
  name: string,
  args: Record<string, unknown>,
  context: CoordinationToolContext,
): Promise<{ content: string; isError: boolean }> {
  const store = getCoordinationStore();
  if (name === 'coordination_read') {
    const events = await store.consume(context.actor, { repository: context.repository, taskId: context.taskId });
    return { content: JSON.stringify(events), isError: false };
  }
  if (name === 'coordination_wait') {
    try {
      const events = await waitForInbox(store, context, resolveWaitMs(args.timeout_ms, args.__loopDeadlineAt as number | undefined));
      return { content: JSON.stringify(events), isError: false };
    } catch (error) {
      // An unreadable board must not look like a quiet one.
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
  if (name === 'coordination_history') {
    const { queryTrace } = await import('./coordinationTrace.js');
    // Default to this run's own task: an agent asking for history almost always
    // means "what happened on what I am working on", and returning the whole
    // repository by default would bury that in unrelated traffic.
    const requestedTask = typeof args.task_id === 'string' ? args.task_id : undefined;
    const taskId = requestedTask === '*' ? undefined : requestedTask ?? context.taskId;
    const events = queryTrace({
      repository: context.repository,
      taskId,
      taskLabel: typeof args.task_label === 'string' ? args.task_label : undefined,
      correlationId: typeof args.correlation_id === 'string' ? args.correlation_id : undefined,
      actor: typeof args.participant === 'string' ? args.participant : undefined,
      limit: typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 200) : 50,
    });
    return { content: JSON.stringify(events), isError: false };
  }
  if (name === 'coordination_publish') {
    const kinds = new Set<CoordinationKind>(['advice-request', 'advice-response', 'delegation-request', 'delegation-result']);
    const kind = typeof args.kind === 'string' ? args.kind as CoordinationKind : undefined;
    if (!kind || !kinds.has(kind) || typeof args.recipient !== 'string' || typeof args.summary !== 'string') {
      return { content: 'Invalid coordination_publish arguments', isError: true };
    }
    const event = await store.publish({
      repository: context.repository,
      taskId: context.taskId,
      taskLabel: context.taskLabel,
      actor: context.actor,
      actorName: context.actorName,
      actorRole: context.actorRole,
      recipient: callSignAddress(args.recipient),
      recipientName: args.recipient,
      kind,
      status: kind.endsWith('request') ? 'open' : 'completed',
      correlationId: typeof args.correlation_id === 'string' ? args.correlation_id : undefined,
      summary: args.summary,
      detail: typeof args.detail === 'string' ? args.detail : undefined,
    });
    return { content: JSON.stringify({ accepted: true, event }), isError: false };
  }
  if (name === 'ask_human') {
    if (typeof args.question !== 'string' || !args.question.trim()) {
      return { content: 'question must be a non-empty string', isError: true };
    }
    const posted = await postHumanQuestion({
      repository: context.repository,
      taskId: context.taskId,
      actor: context.actor,
      actorName: context.actorName,
      actorRole: context.actorRole,
      question: args.question,
      notify: context.notifyOperator,
    });
    // A question the operator already answered is returned rather than asked
    // again, so a retry of the same task does not page them twice.
    if (posted.answer !== undefined) {
      return {
        content: JSON.stringify({ blocked: false, correlationId: posted.correlationId, answer: posted.answer }),
        isError: false,
      };
    }
    return {
      content: JSON.stringify({
        blocked: true,
        correlationId: posted.correlationId,
        delivered: posted.delivered,
        instruction: posted.delivered
          ? 'Stop this run and report the blocking decision. OpenSwarm resumes the task once the operator answers in Discord.'
          : 'Stop this run and report the blocking decision. Discord is not reachable, so state plainly that the question is only on the coordination board and nobody has been paged.',
      }),
      isError: false,
    };
  }
  return { content: `Unknown coordination tool: ${name}`, isError: true };
}

/**
 * Block until something addressed to this agent lands, or the deadline passes.
 *
 * Two wake-up paths, because neither alone is sufficient:
 *
 *  - **The event hub** (`coordination:published`, emitted by
 *    `CoordinationStore.publish`) is the fast path and covers everything that
 *    happens inside the daemon — a peer agent, and an operator message arriving
 *    through the dashboard's HTTP endpoint. Latency is effectively zero.
 *  - **A slow re-drain** covers publishers in *another* process. The board is a
 *    file, and `openswarm attach` and the CLI write to it from their own
 *    processes, where an in-memory emitter cannot reach. Without this the wait
 *    would silently degrade to "always times out" for exactly the operator path
 *    it exists to serve. (Both caught by the commit-gate review.)
 *
 * The subscription is installed BEFORE the first drain. Draining first left a
 * window where a message published in between reached neither — the drain had
 * already run, and nothing was listening yet — so the agent waited out its full
 * deadline on mail that had actually arrived.
 */
const COORDINATION_WAIT_POLL_MS = 2_000;

export async function waitForInbox(
  store: { consume: (actor: string, options: { repository: string; taskId: string }) => Promise<unknown[]> },
  context: CoordinationToolContext,
  timeoutMs: number,
): Promise<unknown[]> {
  const drain = () => store.consume(context.actor, { repository: context.repository, taskId: context.taskId });
  if (timeoutMs <= 0) return drain();

  const { getEventHub } = await import('../core/eventHub.js');
  const hub = getEventHub();

  return new Promise<unknown[]>((resolve, reject) => {
    let settled = false;
    let draining = false;
    let again = false;
    // A board that cannot be read is not the same as a board with no mail: an
    // empty list is a claim about the board's contents, and only a drain that
    // actually completed can support it. (Caught by the commit-gate review.)
    //
    // What matters is the LAST attempt, not whether any ever worked. `consume`
    // returns everything unseen rather than a delta, so one good read at the
    // end also observes whatever arrived during an earlier failure — but a
    // first read that succeeded empty says nothing about the twenty seconds of
    // failures that followed it, during which a reply could have landed
    // unseen. Tracking "any success" reported those as a clean empty inbox.
    // (Caught by the fresh PR review.)
    let pendingError: unknown;
    let expired = false;

    const stop = () => {
      settled = true;
      clearTimeout(deadline);
      clearInterval(poll);
      hub.off('coordination:published', check);
    };
    const finish = (events: unknown[]) => { if (!settled) { stop(); resolve(events); } };
    const fail = (error: unknown) => { if (!settled) { stop(); reject(error); } };

    // Serialised: two overlapping drains would each mark events consumed, and
    // the loser would return an empty list for mail the winner already took.
    // A wake-up that arrives mid-drain is remembered rather than dropped —
    // otherwise the message that woke us would wait for the next poll, or
    // forever if nothing else is ever published.
    function check(): void {
      if (settled) return;
      if (draining) { again = true; return; }
      draining = true;
      drain()
        .then((events) => {
          pendingError = undefined; // this read saw the board; earlier failures are covered
          if (events.length > 0) finish(events);
        })
        .catch((error) => { pendingError = error; })
        .finally(() => {
          draining = false;
          if (settled) return;
          // A wake-up recorded during this drain is honoured even after the
          // deadline: the message it announced was published before the
          // deadline, and dropping it would report an empty inbox for mail
          // that had already arrived. Bounded, because expiry detaches the
          // wake-up sources — nothing can set `again` again.
          if (again) { again = false; check(); return; }
          if (expired) settleExpired();
        });
    }

    function settleExpired(): void {
      if (pendingError !== undefined) {
        fail(new Error(`Coordination board unavailable: ${pendingError instanceof Error ? pendingError.message : String(pendingError)}`));
        return;
      }
      finish([]);
    }

    // The deadline does not cut off a drain that is already running. `consume`
    // is destructive — it marks what it returns as seen — so resolving `[]`
    // while a drain was in flight threw away the message that drain was in the
    // middle of collecting. The wait can therefore overrun its timeout by one
    // store read, which is the right trade against losing mail.
    // (Caught by the PR review.)
    const deadline = setTimeout(() => {
      expired = true;
      // Detach first: no new wake-ups may be recorded past the deadline, which
      // is what bounds the catch-up above to a single extra drain.
      hub.off('coordination:published', check);
      clearInterval(poll);
      if (draining) return;
      if (again) { again = false; check(); return; }
      settleExpired();
    }, timeoutMs);
    const poll = setInterval(check, COORDINATION_WAIT_POLL_MS);
    // Deliberately NOT unref'd. Someone is awaiting this promise, so the
    // process must stay alive until it settles — unref'ing let a CLI run whose
    // only pending handles were these timers exit mid-wait, and the awaited
    // promise simply never resolved. How long they can hold the loop open is
    // already bounded by `deadline`, which is the clamped timeout.
    // (Caught by the PR review.)
    hub.on('coordination:published', check);
    // Now that something is listening, look at what is already there.
    check();
  });
}
