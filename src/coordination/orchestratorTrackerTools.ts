import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import type { ToolDefinition } from '../adapters/tools.js';
import { answerHumanQuestion } from './humanQuestions.js';
import { getCoordinationStore } from './coordinationStore.js';
import { repositoryKey } from './repositoryCell.js';
import { executeLedgerOverview, LEDGER_OVERVIEW_TOOL_DEFINITION } from './ledgerOverviewTool.js';

const execFileAsync = promisify(execFile);
const HOST_READ_MAX_BYTES = 200_000;
const HOST_SEARCH_MAX_HITS = 50;

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
      name: 'host_read_file',
      description:
        'Read a file on the development host outside the worker sandbox. Path is repository-relative, or under /warehouse. This is how the supervisor inspects the live checkout the workers cannot reach from bwrap.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path, or an absolute path under the warehouse root.' },
          offset: { type: 'number', description: '1-based start line (default 1).' },
          limit: { type: 'number', description: 'Max lines to return (default 200, max 400).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'host_search_files',
      description:
        'Search file contents on the development-host repository (git grep). Use this instead of asking the operator to paste source.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'POSIX extended regular expression.' },
          path: { type: 'string', description: 'Optional repository-relative subdirectory or file to search.' },
        },
        required: ['pattern'],
      },
    },
  },
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
  LEDGER_OVERVIEW_TOOL_DEFINITION,
];

export const ORCHESTRATOR_TRACKER_TOOL_NAMES: ReadonlySet<string> = new Set(
  ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

export const ORCHESTRATOR_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
  'host_read_file',
  'host_search_files',
]);

export const ORCHESTRATOR_HOST_TOOL_DEFINITIONS: ToolDefinition[] =
  ORCHESTRATOR_TRACKER_TOOL_DEFINITIONS.filter((definition) =>
    ORCHESTRATOR_HOST_TOOL_NAMES.has(definition.function.name));

function warehouseRoot(): string {
  return process.env.OPENSWARM_WAREHOUSE_ROOT?.trim() || '/warehouse';
}

async function resolveHostPath(repository: string, requested: string): Promise<string | undefined> {
  const roots = [resolve(repository), resolve(warehouseRoot())];
  for (const root of roots) {
    const canonicalRoot = existsSync(root) ? await realpath(root) : root;
    const target = isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoot, requested);
    const canonical = existsSync(target) ? await realpath(target) : target;
    const rel = relative(canonicalRoot, canonical);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
      return canonical;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function issueIsInRepositoryCell(issue: string, context: OrchestratorTrackerToolContext): boolean {
  const expected = issue.toLowerCase();
  const repoKey = repositoryKey(context.repoKey, context.repository);
  return getCoordinationStore().list({ repository: context.repository, repoKey, limit: 2_000 })
    .some((event) => event.taskId.toLowerCase() === expected || event.taskLabel?.toLowerCase() === expected);
}

async function executeHostReadTool(
  name: string,
  args: Record<string, unknown>,
  context: OrchestratorTrackerToolContext,
): Promise<{ content: string; isError: boolean }> {
  if (name === 'host_search_files') {
    const pattern = nonEmptyString(args.pattern);
    if (!pattern) return { content: 'pattern is required', isError: true };
    const searchPath = nonEmptyString(args.path) ?? '.';
    const resolved = await resolveHostPath(context.repository, searchPath);
    if (!resolved) return { content: 'path is outside the repository or warehouse', isError: true };
    const repoRoot = existsSync(context.repository) ? await realpath(context.repository) : resolve(context.repository);
    const rel = relative(repoRoot, resolved);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      return { content: 'host_search_files is limited to the repository checkout', isError: true };
    }
    const gitArgs = ['grep', '--no-color', '-n', '-I', '-E', '-e', pattern, '--', rel === '' ? '.' : rel];
    try {
      const { stdout } = await execFileAsync('git', gitArgs, {
        cwd: context.repository,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout.split('\n').filter(Boolean).slice(0, HOST_SEARCH_MAX_HITS);
      return { content: lines.length ? lines.join('\n') : '(no matches)', isError: false };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code: number }).code === 1) {
        return { content: '(no matches)', isError: false };
      }
      return {
        content: 'host_search_files is unavailable: git grep failed. Do not treat this as "no matches".',
        isError: true,
      };
    }
  }

  const requested = nonEmptyString(args.path);
  if (!requested) return { content: 'path is required', isError: true };
  const resolved = await resolveHostPath(context.repository, requested);
  if (!resolved) return { content: 'path is outside the repository or warehouse', isError: true };
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return { content: 'path is not a regular file', isError: true };
    if (info.size > HOST_READ_MAX_BYTES) {
      return { content: `file exceeds ${HOST_READ_MAX_BYTES} bytes`, isError: true };
    }
    const content = await readFile(resolved, 'utf8');
    const lines = content.split('\n');
    const offsetRaw = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.trunc(args.offset) : 1;
    const offset = Math.max(1, offsetRaw) - 1;
    const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 200;
    const limit = Math.min(400, Math.max(1, limitRaw));
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
    const truncated = lines.length > offset + limit
      ? `\n... (${lines.length - offset - limit} more lines)`
      : '';
    return { content: numbered + truncated, isError: false };
  } catch (error) {
    return {
      content: `host_read_file failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

export async function executeOrchestratorTrackerTool(
  name: string,
  args: Record<string, unknown>,
  context: OrchestratorTrackerToolContext,
): Promise<{ content: string; isError: boolean }> {
  if (context.actorRole !== 'orchestrator') {
    return { content: 'Supervisor tracker tools are restricted to the orchestrator role', isError: true };
  }

  if (name === 'host_read_file' || name === 'host_search_files') {
    return executeHostReadTool(name, args, context);
  }

  if (name === 'ledger_overview') {
    return executeLedgerOverview();
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
