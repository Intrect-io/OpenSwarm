// ============================================
// OpenSwarm - Agent tools for durable repository threads
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';
import {
  createCoordinationThread,
  followCoordinationThread,
  getCoordinationThread,
  listCoordinationThreads,
  markCoordinationThreadRead,
  postCoordinationThreadMessage,
  resolveCoordinationThread,
  unfollowCoordinationThread,
  type CoordinationThreadStatus,
} from './coordinationThreads.js';

export interface CoordinationThreadToolContext {
  repository: string;
  taskId: string;
  taskLabel?: string;
  actor: string;
  actorName?: string;
  actorRole?: string;
}

const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 32 } as const;

export const COORDINATION_THREAD_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'coordination_thread_create',
      description: 'Open a durable repository discussion shared across tasks and restarts. Use it for decisions, file/PR ownership, integration risks, and evidence that should outlive the transient inbox. The creator automatically follows the thread.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
          related_task_ids: stringArray,
          related_files: stringArray,
          related_pull_requests: stringArray,
          idempotency_key: { type: 'string', description: 'Stable key unique to this intended thread creation, reused on retries.' },
        },
        required: ['subject', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_thread_list',
      description: 'List durable repository threads. By default returns threads related to the current task; use scope="repository" to discover cross-task work or scope="following" for subscribed threads and unread counts.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['related', 'repository', 'following'] },
          status: { type: 'string', enum: ['open', 'resolved'] },
          limit: { type: 'number' },
          cursor: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_thread_get',
      description: 'Read one durable thread, its participants, and a page of messages. Set mark_read after you have incorporated the page.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          message_limit: { type: 'number' },
          message_after_seq: { type: 'number' },
          mark_read: { type: 'boolean' },
        },
        required: ['thread_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_thread_reply',
      description: 'Append an idempotent reply to an open durable thread. Speaking automatically follows the thread and marks your own reply read.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          body: { type: 'string' },
          idempotency_key: { type: 'string', description: 'Stable key unique to this intended reply, reused on retries.' },
        },
        required: ['thread_id', 'body', 'idempotency_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_thread_follow',
      description: 'Follow or unfollow a durable thread. Followers can query unread counts; a thread creator cannot unfollow their own thread.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          following: { type: 'boolean' },
        },
        required: ['thread_id', 'following'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordination_thread_resolve',
      description: 'Resolve an open durable thread with compare-and-swap. Pass the version returned by thread_get so a concurrent reply cannot be closed unseen.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          expected_version: { type: 'number' },
        },
        required: ['thread_id', 'expected_version'],
      },
    },
  },
];

export const COORDINATION_THREAD_TOOL_NAMES: ReadonlySet<string> = new Set(
  COORDINATION_THREAD_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

export const COORDINATION_THREAD_GUIDANCE_PROMPT = `

## Durable repository threads

The inbox is for immediate delivery; repository threads are the durable place
for cross-task decisions, file or PR ownership, integration risks, and evidence.
Check related or followed open threads before choosing ownership that could
conflict with another task. Reply with evidence, and resolve only the version
you actually read.
`;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function optionalStrings(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

/** Execute a thread tool using identity from the trusted run context, never model arguments. */
export async function executeCoordinationThreadTool(
  name: string,
  args: Record<string, unknown>,
  context: CoordinationThreadToolContext,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'coordination_thread_create') {
      const thread = createCoordinationThread({
        repository: context.repository,
        subject: requiredString(args, 'subject'),
        actor: context.actor,
        actorName: context.actorName,
        actorRole: context.actorRole,
        taskId: context.taskId,
        taskLabel: context.taskLabel,
        body: optionalString(args, 'body'),
        relatedTaskIds: optionalStrings(args, 'related_task_ids'),
        relatedFiles: optionalStrings(args, 'related_files'),
        relatedPullRequests: optionalStrings(args, 'related_pull_requests'),
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      return { content: JSON.stringify({ accepted: true, thread }), isError: false };
    }

    if (name === 'coordination_thread_list') {
      const scope = args.scope ?? 'related';
      if (!['related', 'repository', 'following'].includes(String(scope))) {
        throw new Error('scope must be related, repository, or following');
      }
      const status = optionalString(args, 'status') as CoordinationThreadStatus | undefined;
      if (status && status !== 'open' && status !== 'resolved') throw new Error('status must be open or resolved');
      const page = listCoordinationThreads({
        repository: context.repository,
        status,
        ...(scope === 'related' ? { relatedTaskId: context.taskId } : {}),
        ...(scope === 'following' ? { participant: { actor: context.actor, taskId: context.taskId } } : {}),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        cursor: optionalString(args, 'cursor'),
      });
      return { content: JSON.stringify(page), isError: false };
    }

    if (name === 'coordination_thread_get') {
      const threadId = requiredString(args, 'thread_id');
      const detail = getCoordinationThread({
        repository: context.repository,
        threadId,
        messageLimit: typeof args.message_limit === 'number' ? args.message_limit : undefined,
        messageAfterSeq: typeof args.message_after_seq === 'number' ? args.message_after_seq : undefined,
      });
      if (args.mark_read === true) {
        markCoordinationThreadRead({
          repository: context.repository, threadId, actor: context.actor, taskId: context.taskId,
        });
      }
      return { content: JSON.stringify(detail), isError: false };
    }

    if (name === 'coordination_thread_reply') {
      const threadId = requiredString(args, 'thread_id');
      const message = postCoordinationThreadMessage({
        repository: context.repository,
        threadId,
        actor: context.actor,
        actorName: context.actorName,
        actorRole: context.actorRole,
        taskId: context.taskId,
        taskLabel: context.taskLabel,
        body: requiredString(args, 'body'),
        idempotencyKey: requiredString(args, 'idempotency_key'),
      });
      const thread = getCoordinationThread({ repository: context.repository, threadId, messageLimit: 1 }).thread;
      return { content: JSON.stringify({ accepted: true, message, thread }), isError: false };
    }

    if (name === 'coordination_thread_follow') {
      const threadId = requiredString(args, 'thread_id');
      if (typeof args.following !== 'boolean') throw new Error('following must be a boolean');
      if (args.following) {
        const participants = followCoordinationThread({
          repository: context.repository,
          threadId,
          actor: context.actor,
          actorName: context.actorName,
          actorRole: context.actorRole,
          taskId: context.taskId,
          taskLabel: context.taskLabel,
        });
        return { content: JSON.stringify({ following: true, participants }), isError: false };
      }
      const changed = unfollowCoordinationThread({
        repository: context.repository, threadId, actor: context.actor, taskId: context.taskId,
      });
      return { content: JSON.stringify({ following: false, changed }), isError: false };
    }

    if (name === 'coordination_thread_resolve') {
      const expectedVersion = args.expected_version;
      if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new Error('expected_version must be a positive integer');
      }
      const thread = resolveCoordinationThread({
        repository: context.repository,
        threadId: requiredString(args, 'thread_id'),
        expectedVersion,
        actor: context.actor,
        taskId: context.taskId,
      });
      return { content: JSON.stringify({ accepted: true, thread }), isError: false };
    }

    return { content: `Unknown coordination thread tool: ${name}`, isError: true };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
