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
  /** Routable address other agents send to. */
  actor: string;
  /** Human-facing call sign shown in reports and the dashboard. */
  actorName?: string;
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
      description: 'Publish an advice request/response or delegation request/result to another OpenSwarm agent. Address it by call sign (for example "Magos Corvax-Vigilis"). Use a correlation_id to continue an existing exchange.',
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
  if (name === 'coordination_publish') {
    const kinds = new Set<CoordinationKind>(['advice-request', 'advice-response', 'delegation-request', 'delegation-result']);
    const kind = typeof args.kind === 'string' ? args.kind as CoordinationKind : undefined;
    if (!kind || !kinds.has(kind) || typeof args.recipient !== 'string' || typeof args.summary !== 'string') {
      return { content: 'Invalid coordination_publish arguments', isError: true };
    }
    const event = await store.publish({
      repository: context.repository,
      taskId: context.taskId,
      actor: context.actor,
      actorName: context.actorName,
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
