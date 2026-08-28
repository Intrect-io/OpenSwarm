// ============================================
// OpenSwarm - Agent coordination tool contracts
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';
import { getCoordinationStore, type CoordinationKind } from './coordinationStore.js';
import { postHumanQuestion } from './humanQuestions.js';
import { callSignAddress } from './agentNames.js';

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
