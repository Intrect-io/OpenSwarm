import type { ToolDefinition } from '../adapters/tools.js';
import { answerHumanQuestion } from './humanQuestions.js';
import { getCoordinationStore } from './coordinationStore.js';
import { repositoryKey } from './repositoryCell.js';

export interface CachedTrackerIssue {
  issueId: string;
  identifier: string;
  title: string;
  state?: string;
  priority?: number;
  blockedBy?: string[];
}

export interface OrchestratorTrackerBridge {
  getCachedIssue: (issueIdOrIdentifier: string) => CachedTrackerIssue | undefined;
  resolveIssue: (issueIdOrIdentifier: string) => Promise<{
    issueId: string;
    identifier: string;
    source: 'cache' | 'tracker';
  } | null>;
  addComment: (issueId: string, body: string, idempotencyKey: string) => Promise<void>;
}

export interface OrchestratorTrackerToolContext {
  repository: string;
  repoKey?: string;
  taskId: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
  tracker?: OrchestratorTrackerBridge;
}

export const ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'tracker_cached_issue',
      description: 'Read one issue from the daemon heartbeat cache without making a Linear request. Use this before any tracker lookup or comment decision.',
      parameters: {
        type: 'object',
        properties: { issue: { type: 'string', description: 'Issue UUID or identifier, for example AX-967.' } },
        required: ['issue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tracker_save_comment',
      description: 'Save a verified comment to an issue already linked to this repository coordination cell. Resolution uses the heartbeat cache first and performs one tracker lookup only on a cache miss. Requires a stable idempotency key.',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'Issue UUID or identifier already present on this repository board.' },
          body: { type: 'string', description: 'Exact comment body backed by verified evidence.' },
          idempotency_key: { type: 'string', description: 'Stable operation key so retries converge on one comment.' },
        },
        required: ['issue', 'body', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_answer_question',
      description: 'Answer and settle a pending worker question after the supervisor has resolved it from cached tracker facts, durable coordination evidence, or a peer consultation. This is not permission to invent missing business authority.',
      parameters: {
        type: 'object',
        properties: {
          correlation_id: { type: 'string' },
          answer: { type: 'string', description: 'Concrete answer with the decisive evidence or approved next action.' },
        },
        required: ['correlation_id', 'answer'],
      },
    },
  },
];

export const ORCHESTRATOR_TRACKER_TOOL_NAMES: ReadonlySet<string> = new Set(
  ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function issueIsInRepositoryCell(issue: string, context: OrchestratorTrackerToolContext): boolean {
  const expected = issue.toLowerCase();
  const repoKey = repositoryKey(context.repoKey, context.repository);
  return getCoordinationStore().list({ repository: context.repository, repoKey, limit: 2_000 })
    .some((event) => event.taskId.toLowerCase() === expected || event.taskLabel?.toLowerCase() === expected);
}

export async function executeOrchestratorTrackerTool(
  name: string,
  args: Record<string, unknown>,
  context: OrchestratorTrackerToolContext,
): Promise<{ content: string; isError: boolean }> {
  if (context.actorRole !== 'orchestrator') {
    return { content: 'Supervisor tracker tools are restricted to the orchestrator role', isError: true };
  }

  if (name === 'coordination_answer_question') {
    const correlationId = nonEmptyString(args.correlation_id);
    const answer = nonEmptyString(args.answer);
    if (!correlationId || !answer) return { content: 'correlation_id and answer are required', isError: true };
    const question = getCoordinationStore().findQuestion(correlationId);
    if (!question || repositoryKey(question.repoKey, question.repository) !== repositoryKey(context.repoKey, context.repository)) {
      return { content: 'Pending question is not in this repository cell', isError: true };
    }
    const result = await answerHumanQuestion(
      correlationId,
      answer,
      context.actorName ?? context.actor,
      'orchestrator',
    );
    return { content: JSON.stringify(result), isError: !result.accepted };
  }

  const issue = nonEmptyString(args.issue);
  if (!issue) return { content: 'issue is required', isError: true };
  if (!issueIsInRepositoryCell(issue, context)) {
    return { content: 'Issue is not linked to this repository coordination cell', isError: true };
  }
  if (!context.tracker) return { content: 'Tracker bridge is unavailable', isError: true };

  if (name === 'tracker_cached_issue') {
    const cached = context.tracker.getCachedIssue(issue);
    return cached
      ? { content: JSON.stringify({ found: true, source: 'cache', issue: cached }), isError: false }
      : { content: JSON.stringify({ found: false, source: 'cache' }), isError: false };
  }

  if (name === 'tracker_save_comment') {
    const body = nonEmptyString(args.body);
    const idempotencyKey = nonEmptyString(args.idempotency_key);
    if (!body || !idempotencyKey) return { content: 'body and idempotency_key are required', isError: true };
    if (body.length > 20_000 || idempotencyKey.length > 200) {
      return { content: 'Comment body or idempotency key exceeds the bounded limit', isError: true };
    }
    const resolved = await context.tracker.resolveIssue(issue);
    if (!resolved) return { content: 'Issue could not be resolved from cache or tracker', isError: true };
    await context.tracker.addComment(resolved.issueId, body, `orchestrator:${idempotencyKey}`);
    return {
      content: JSON.stringify({ saved: true, issue: resolved.identifier, resolutionSource: resolved.source }),
      isError: false,
    };
  }

  return { content: `Unknown supervisor tracker tool: ${name}`, isError: true };
}
