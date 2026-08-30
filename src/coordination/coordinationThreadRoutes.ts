// ============================================
// OpenSwarm - HTTP API for durable repository threads
// ============================================

import type { IncomingMessage, ServerResponse } from 'node:http';
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
import { repositoryKey } from './repositoryCell.js';
import { publishCoordinationThreadUpdate } from './coordinationThreadTools.js';

type BodyReader = (req: IncomingMessage) => Promise<string>;

function threadRepository(path: string): string {
  return repositoryKey(undefined, path);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 404;
  if (/version conflict|resolved|idempotency key collision/i.test(message)) return 409;
  if (/unavailable/i.test(message)) return 503;
  return 400;
}

async function readJson(req: IncomingMessage, readBody: BodyReader | undefined): Promise<Record<string, unknown>> {
  if (!readBody) throw new Error('Body reader unavailable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req) || '{}');
  } catch {
    throw new Error('Request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function optionalStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function threadPath(url: string): { threadId: string; action?: string } | undefined {
  const match = /^\/api\/coordination\/threads\/([^/]+)(?:\/(messages|follow|read|resolve))?$/.exec(url);
  if (!match) return undefined;
  try {
    return { threadId: decodeURIComponent(match[1]), action: match[2] };
  } catch {
    throw new Error('Thread id is not valid URL encoding');
  }
}

/**
 * Repository-scoped thread API. Mutation authorization and body-size limits
 * are enforced by web.ts before this handler is reached.
 */
export async function tryHandleCoordinationThreadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
  readBody?: BodyReader,
): Promise<boolean> {
  try {
    if (url === '/api/coordination/threads' && req.method === 'GET') {
      const repository = requestUrl.searchParams.get('repository');
      if (!repository) throw new Error('repository query parameter is required');
      const statusRaw = requestUrl.searchParams.get('status') ?? undefined;
      if (statusRaw && statusRaw !== 'open' && statusRaw !== 'resolved') {
        throw new Error('status must be open or resolved');
      }
      const actor = requestUrl.searchParams.get('actor') ?? undefined;
      const participantTaskId = requestUrl.searchParams.get('participantTaskId') ?? undefined;
      if ((actor && !participantTaskId) || (!actor && participantTaskId)) {
        throw new Error('actor and participantTaskId must be provided together');
      }
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '', 10);
      writeJson(res, 200, listCoordinationThreads({
        repository: threadRepository(repository),
        status: statusRaw as CoordinationThreadStatus | undefined,
        relatedTaskId: requestUrl.searchParams.get('taskId') ?? undefined,
        ...(actor && participantTaskId ? { participant: { actor, taskId: participantTaskId } } : {}),
        limit: Number.isSafeInteger(limit) ? limit : undefined,
        cursor: requestUrl.searchParams.get('cursor') ?? undefined,
      }));
      return true;
    }

    if (url === '/api/coordination/threads' && req.method === 'POST') {
      const body = await readJson(req, readBody);
      const repositoryPath = requiredString(body, 'repository');
      const repoKey = threadRepository(repositoryPath);
      const relatedTaskId = requiredString(body, 'taskId');
      const relatedTaskIds = optionalStrings(body, 'relatedTaskIds') ?? [];
      const thread = createCoordinationThread({
        repository: repoKey,
        subject: requiredString(body, 'subject'),
        actor: 'operator-dashboard',
        actorName: 'Operator',
        actorRole: 'human',
        taskId: 'operator',
        taskLabel: 'Operator',
        body: optionalString(body, 'body'),
        relatedTaskIds: [relatedTaskId, ...relatedTaskIds],
        relatedFiles: optionalStrings(body, 'relatedFiles'),
        relatedPullRequests: optionalStrings(body, 'relatedPullRequests'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      });
      const notification = await publishCoordinationThreadUpdate({
        repository: repositoryPath, repoKey, taskId: 'operator', taskLabel: 'Operator',
        actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human',
      }, {
        thread, action: 'created', mutationId: `create:${thread.id}`, body: optionalString(body, 'body'),
      });
      writeJson(res, 201, { thread, notification });
      return true;
    }

    const path = threadPath(url);
    if (!path) return false;

    if (req.method === 'GET' && path.action === undefined) {
      const repository = requestUrl.searchParams.get('repository');
      if (!repository) throw new Error('repository query parameter is required');
      const messageLimit = Number.parseInt(requestUrl.searchParams.get('messageLimit') ?? '', 10);
      const messageAfterSeq = Number.parseInt(requestUrl.searchParams.get('messageAfterSeq') ?? '', 10);
      writeJson(res, 200, getCoordinationThread({
        repository: threadRepository(repository),
        threadId: path.threadId,
        messageLimit: Number.isSafeInteger(messageLimit) ? messageLimit : undefined,
        messageAfterSeq: Number.isSafeInteger(messageAfterSeq) ? messageAfterSeq : undefined,
      }));
      return true;
    }

    const body = await readJson(req, readBody);
    const repositoryPath = requiredString(body, 'repository');
    const repository = threadRepository(repositoryPath);
    const operatorContext = {
      repository: repositoryPath, repoKey: repository, taskId: 'operator', taskLabel: 'Operator',
      actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human',
    };

    if (req.method === 'POST' && path.action === 'messages') {
      const message = postCoordinationThreadMessage({
        repository,
        threadId: path.threadId,
        actor: 'operator-dashboard',
        actorName: 'Operator',
        actorRole: 'human',
        taskId: 'operator',
        taskLabel: 'Operator',
        body: requiredString(body, 'body'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      });
      const thread = getCoordinationThread({ repository, threadId: path.threadId, messageLimit: 1 }).thread;
      const notification = await publishCoordinationThreadUpdate(operatorContext, {
        thread, action: 'replied', mutationId: `message:${message.id}`, body: message.body,
      });
      writeJson(res, 201, { message, notification });
      return true;
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && path.action === 'follow') {
      if (req.method === 'POST') {
        const participants = followCoordinationThread({
          repository, threadId: path.threadId, actor: 'operator-dashboard', actorName: 'Operator',
          actorRole: 'human', taskId: 'operator', taskLabel: 'Operator',
        });
        writeJson(res, 200, { following: true, participants });
      } else {
        const changed = unfollowCoordinationThread({
          repository, threadId: path.threadId, actor: 'operator-dashboard', taskId: 'operator',
        });
        writeJson(res, 200, { following: false, changed });
      }
      return true;
    }

    if (req.method === 'POST' && path.action === 'read') {
      const lastReadSeq = markCoordinationThreadRead({
        repository, threadId: path.threadId, actor: 'operator-dashboard', taskId: 'operator',
      });
      writeJson(res, 200, { lastReadSeq });
      return true;
    }

    if (req.method === 'POST' && path.action === 'resolve') {
      if (typeof body.expectedVersion !== 'number'
        || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
        throw new Error('expectedVersion must be a positive integer');
      }
      const thread = resolveCoordinationThread({
        repository,
        threadId: path.threadId,
        expectedVersion: body.expectedVersion,
        actor: 'operator-dashboard',
        taskId: 'operator',
      });
      const notification = await publishCoordinationThreadUpdate(operatorContext, {
        thread, action: 'resolved', mutationId: `resolve:${thread.id}:${thread.version}`,
      });
      writeJson(res, 200, { thread, notification });
      return true;
    }

    return false;
  } catch (error) {
    writeJson(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
