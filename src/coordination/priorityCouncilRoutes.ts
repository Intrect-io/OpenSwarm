// ============================================
// OpenSwarm - HTTP API for priority councils
// ============================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { repositoryKey } from './repositoryCell.js';
import { getPriorityCouncil, listPriorityCouncils, type PriorityCouncilStatus } from './priorityCouncil.js';
import { executePriorityCouncilTool, type PriorityCouncilToolContext } from './priorityCouncilTools.js';

type BodyReader = (req: IncomingMessage) => Promise<string>;

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorStatus(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/unavailable/i.test(message)) return 503;
  if (/version conflict|idempotency|duplicate|already has an open|expired|quorum not reached/i.test(message)) return 409;
  return 400;
}

function publicError(statusCode: number): string {
  if (statusCode === 404) return 'Priority council not found';
  if (statusCode === 409) return 'Priority council conflict';
  if (statusCode === 503) return 'Priority council store unavailable';
  return 'Invalid priority council request';
}

async function readJson(req: IncomingMessage, readBody: BodyReader | undefined): Promise<Record<string, unknown>> {
  if (!readBody) throw new Error('Body reader unavailable');
  try {
    const parsed = JSON.parse(await readBody(req) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Request body must be a valid JSON object');
  }
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

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function requiredStrings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function operatorContext(repository: string): PriorityCouncilToolContext {
  return {
    repository,
    repoKey: repositoryKey(undefined, repository),
    taskId: 'operator',
    taskLabel: 'Operator',
    actor: 'operator-dashboard',
    actorName: 'Operator',
    actorRole: 'human',
  };
}

function translateOptions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('options must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each option must be an object');
    const option = entry as Record<string, unknown>;
    const scheduling = option.schedulingFacts;
    if (scheduling !== undefined && (!scheduling || typeof scheduling !== 'object' || Array.isArray(scheduling))) {
      throw new Error('schedulingFacts must be an object');
    }
    const facts = scheduling as Record<string, unknown> | undefined;
    return {
      id: requiredString(option, 'id'),
      label: requiredString(option, 'label'),
      task_id: requiredString(option, 'taskId'),
      evidence_ids: requiredStrings(option, 'evidenceIds'),
      ...(facts === undefined ? {} : {
        scheduling_facts: {
          priority: optionalNumber(facts, 'priority'),
          topo_rank: optionalNumber(facts, 'topoRank'),
          due_date: optionalNumber(facts, 'dueDate'),
          downstream_count: optionalNumber(facts, 'downstreamCount'),
          blocked_by: requiredStrings(facts, 'blockedBy'),
          linear_state: optionalString(facts, 'linearState'),
        },
      }),
    };
  });
}

function translateSnapshotEvidence(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('snapshotEvidence must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each evidence record must be an object');
    const evidence = entry as Record<string, unknown>;
    return {
      id: requiredString(evidence, 'id'), source: requiredString(evidence, 'source'),
      summary: requiredString(evidence, 'summary'), ref: optionalString(evidence, 'ref'),
    };
  });
}

async function executeMutation(
  res: ServerResponse,
  name: string,
  args: Record<string, unknown>,
  context: PriorityCouncilToolContext,
  successStatus = 200,
): Promise<void> {
  const result = await executePriorityCouncilTool(name, args, context);
  if (result.isError) {
    writeJson(res, errorStatus(result.content), { error: result.content });
    return;
  }
  writeJson(res, successStatus, JSON.parse(result.content));
}

function councilPath(url: string): { councilId: string; action?: 'evidence' | 'finalize' } | undefined {
  const match = /^\/api\/coordination\/councils\/([^/]+)(?:\/(evidence|finalize))?$/.exec(url);
  if (!match) return undefined;
  try {
    return { councilId: decodeURIComponent(match[1]), action: match[2] as 'evidence' | 'finalize' | undefined };
  } catch {
    throw new Error('Council id is not valid URL encoding');
  }
}

/** Auth and request-size gates are enforced by web.ts before this handler. */
export async function tryHandlePriorityCouncilRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
  readBody?: BodyReader,
): Promise<boolean> {
  try {
    if (url === '/api/coordination/councils' && req.method === 'GET') {
      const repository = requestUrl.searchParams.get('repository');
      if (!repository) throw new Error('repository query parameter is required');
      const status = requestUrl.searchParams.get('status') ?? undefined;
      if (status && !['open', 'finalized', 'expired'].includes(status)) throw new Error('Invalid council status');
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '', 10);
      writeJson(res, 200, {
        items: listPriorityCouncils({
          repository: repositoryKey(undefined, repository),
          threadId: requestUrl.searchParams.get('threadId') ?? undefined,
          status: status as PriorityCouncilStatus | undefined,
          limit: Number.isSafeInteger(limit) ? limit : undefined,
        }),
      });
      return true;
    }

    if (url === '/api/coordination/councils' && req.method === 'POST') {
      const body = await readJson(req, readBody);
      const repository = requiredString(body, 'repository');
      await executeMutation(res, 'coordination_council_open', {
        thread_id: requiredString(body, 'threadId'),
        reason: requiredString(body, 'reason'),
        subject: requiredString(body, 'subject'),
        options: translateOptions(body.options),
        snapshot_version: requiredString(body, 'snapshotVersion'),
        snapshot_captured_at: optionalNumber(body, 'snapshotCapturedAt'),
        snapshot_evidence: translateSnapshotEvidence(body.snapshotEvidence),
        required_quorum: optionalNumber(body, 'requiredQuorum'),
        expires_in_ms: optionalNumber(body, 'expiresInMs'),
        idempotency_key: requiredString(body, 'idempotencyKey'),
      }, operatorContext(repository), 201);
      return true;
    }

    const path = councilPath(url);
    if (!path) return false;

    if (!path.action && req.method === 'GET') {
      const repository = requestUrl.searchParams.get('repository');
      if (!repository) throw new Error('repository query parameter is required');
      writeJson(res, 200, getPriorityCouncil({
        repository: repositoryKey(undefined, repository), councilId: path.councilId,
      }));
      return true;
    }

    if (path.action === 'evidence' && req.method === 'POST') {
      const body = await readJson(req, readBody);
      const repository = requiredString(body, 'repository');
      await executeMutation(res, 'coordination_council_evidence', {
        council_id: path.councilId,
        option_id: requiredString(body, 'optionId'),
        summary: requiredString(body, 'summary'),
        refs: requiredStrings(body, 'refs'),
        idempotency_key: requiredString(body, 'idempotencyKey'),
      }, operatorContext(repository), 201);
      return true;
    }

    if (path.action === 'finalize' && req.method === 'POST') {
      const body = await readJson(req, readBody);
      const repository = requiredString(body, 'repository');
      await executeMutation(res, 'coordination_council_finalize', {
        council_id: path.councilId,
        expected_version: optionalNumber(body, 'expectedVersion'),
        idempotency_key: requiredString(body, 'idempotencyKey'),
      }, operatorContext(repository));
      return true;
    }

    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = errorStatus(message);
    writeJson(res, statusCode, { error: publicError(statusCode) });
    return true;
  }
}
