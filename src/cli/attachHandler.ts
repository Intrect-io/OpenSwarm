// ============================================
// OpenSwarm - `openswarm attach <issueId> <files...>`
// ============================================
//
// Upload file(s) to a running task's coordination inbox and notify its
// agent — the CLI's counterpart to the dashboard's /chat attach button
// (AGT-4031, web/static/js/chatView.mjs). Neither
// POST /api/coordination/attachment nor POST /api/coordination/message had
// a CLI consumer before this (AGT-4058).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CoordinationEvent } from '../coordination/coordinationStore.js';
import { DAEMON_PORT } from './daemon.js';

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export interface ResolvedIssue {
  id: string;
  identifier: string;
}

export interface ResolveIssueDeps {
  ensureTaskSource?: () => Promise<unknown>;
  getIssue?: (id: string) => Promise<{ id: string; identifier: string } | null>;
}

/**
 * `AGT-123` or a raw issue UUID -> `{ id (UUID), identifier }`. `taskId` on a
 * coordination event is the Linear issue UUID, not the human-readable
 * identifier (src/orchestration/decisionEngine.ts's `taskEventKey`), so this
 * mirrors `openswarm work`'s own resolution (workCommand.ts) rather than
 * inventing a second convention.
 */
export async function resolveIssue(identifier: string, deps: ResolveIssueDeps = {}): Promise<ResolvedIssue | null> {
  const ensureTaskSource = deps.ensureTaskSource
    ?? (async () => (await import('./reviewCommand.js')).ensureTaskSource());
  const getIssue = deps.getIssue
    ?? (async (id: string) => (await import('../linear/linear.js')).getIssue(id));
  await ensureTaskSource();
  const issue = await getIssue(identifier);
  return issue ? { id: issue.id, identifier: issue.identifier } : null;
}

// ---- Ported from web/static/js/conversationModel.mjs -----------------------
// Small, pure, dependency-free — ported natively rather than imported across
// the src/ -> dist/ / web/static/ -> dist/web-static/ build boundary, which
// resolves differently in dev (tsx, unbuilt) vs. prod (compiled dist/, where
// web/static/js/ is not mirrored at dist/cli/'s relative path). Keep in sync
// with conversationModel.mjs's `isUtterance`/`openQuestionFor`/
// `latestAddressable` by hand if the dashboard's semantics change.

const NON_CONVERSATION_KINDS = new Set<CoordinationEvent['kind']>(['instruction-snapshot']);

function isUtterance(event: CoordinationEvent): boolean {
  return !NON_CONVERSATION_KINDS.has(event.kind);
}

/**
 * Last agent (non-human actor) to speak about this task, or null if none has
 * yet. Also excludes `actorRole: 'daemon'`: unlike the dashboard's own
 * `latestAddressable` (which only excludes `'human'`), this CLI picks a
 * recipient with no human in the loop to notice a bad pick, so it must not
 * be looser than the dashboard about it. `adapter-route`
 * (`src/agents/worker.ts`'s `recordRoute`, actor `adapter-router`) and
 * `mcp-audit` (`daemonActor` in `runCoordination.ts`/`orchestratorAgent.ts`,
 * actor `openswarm-daemon`) are both stamped `actorRole: 'daemon'` — neither
 * identity ever runs an agentic loop or calls `coordination_read`, so
 * addressing either would silently strand the message forever. `review-run`
 * events keep `actorRole: 'review-agent'` (a real agent's own call sign,
 * `periodicReview.ts`) and are unaffected. Caught by `openswarm review`, not
 * self-caught.
 */
export function latestAddressable(events: readonly CoordinationEvent[]): CoordinationEvent | null {
  const spoken = [...events].filter(isUtterance).sort((a, b) => a.seq - b.seq);
  for (let i = spoken.length - 1; i >= 0; i -= 1) {
    if (spoken[i].actorRole !== 'human' && spoken[i].actorRole !== 'daemon') return spoken[i];
  }
  return null;
}

/**
 * An unanswered blocking question `actorAddress` is parked on, scoped to the
 * same task/repository — answering it beats filing a new note, or the agent
 * stays blocked (AGT-4030). Returns null without a task/repository scope:
 * an address is not unique (agents name themselves), so a scopeless lookup
 * could offer to answer someone else's question on a different task.
 */
export function openQuestionFor(
  events: readonly CoordinationEvent[],
  actorAddress: string | undefined,
  scope: { taskId?: string; repository?: string } = {},
): CoordinationEvent | null {
  if (!actorAddress) return null;
  if (!scope.taskId && !scope.repository) return null;
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

// ---- HTTP surface -----------------------------------------------------------

/** Every daemon request after the initial health probe needs its own bound
 * too — a daemon that answers /api/stats can still stall on a later request
 * (lock contention, a slow write), and an interactive CLI has no other way
 * out of that than a timeout. Caught by openswarm review, not self-caught. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Uploads can be up to MAX_ATTACHMENT_BYTES (64MiB, attachmentStore.ts) —
 * needs more room than a small JSON call. */
const UPLOAD_TIMEOUT_MS = 60_000;

async function fetchTaskHistory(taskId: string, port: number): Promise<CoordinationEvent[]> {
  const res = await fetch(
    `${baseUrl(port)}/api/coordination/history?taskId=${encodeURIComponent(taskId)}&limit=200`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`Could not read the coordination board (HTTP ${res.status})`);
  const body = await res.json() as { events?: CoordinationEvent[] };
  return body.events ?? [];
}

export interface UploadedAttachment {
  filepath: string;
  filename: string;
  path: string;
  bytes: number;
}

/** Throws with the server's own error text on 400/413/507, matching
 * providerCommand.ts's res.ok -> else res.text() pattern. */
async function uploadAttachment(taskId: string, filepath: string, port: number): Promise<UploadedAttachment> {
  const filename = basename(filepath);
  const bytes = readFileSync(filepath);
  const query = `?taskId=${encodeURIComponent(taskId)}&filename=${encodeURIComponent(filename)}`;
  const res = await fetch(`${baseUrl(port)}/api/coordination/attachment${query}`, {
    method: 'POST',
    body: bytes,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = `upload failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(detail) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (detail) message = detail.slice(0, 200);
    }
    throw new Error(message);
  }
  const stored = await res.json() as { filename: string; path: string; bytes: number };
  return { filepath, filename: stored.filename, path: stored.path, bytes: stored.bytes };
}

async function postMessage(
  exchange: { correlationId: string; repository: string; taskId: string },
  recipient: string,
  text: string,
  port: number,
): Promise<void> {
  const res = await fetch(`${baseUrl(port)}/api/coordination/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      correlationId: exchange.correlationId,
      recipient,
      repository: exchange.repository,
      taskId: exchange.taskId,
      text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = `message not delivered (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(detail) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (detail) message = detail.slice(0, 200);
    }
    throw new Error(message);
  }
}

async function isDaemonReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(port)}/api/stats`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface RunAttachOptions {
  message?: string;
  port?: number;
  deps?: ResolveIssueDeps;
}

/** CLI entry point. Returns a process exit code, matching runProviderCommand's shape. */
export async function runAttachCommand(
  issueIdentifier: string,
  filepaths: string[],
  opts: RunAttachOptions = {},
): Promise<number> {
  const port = opts.port ?? DAEMON_PORT;

  if (filepaths.length === 0) {
    console.error('Pass at least one file to attach.');
    return 1;
  }

  if (!(await isDaemonReachable(port))) {
    console.error('OpenSwarm daemon is not reachable — start it first (`openswarm start`).');
    return 1;
  }

  const issue = await resolveIssue(issueIdentifier, opts.deps);
  if (!issue) {
    console.error(`Issue not found: ${issueIdentifier}`);
    return 1;
  }

  let events: CoordinationEvent[];
  try {
    events = await fetchTaskHistory(issue.id, port);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const target = latestAddressable(events);
  if (!target) {
    console.error(`No agent is addressable yet for ${issue.identifier} — it hasn't spoken on the coordination board.`);
    return 1;
  }
  const question = openQuestionFor(events, target.actor, { repository: target.repository, taskId: target.taskId });
  const exchange = question ?? target;

  const uploaded: UploadedAttachment[] = [];
  let hadFailure = false;
  for (const filepath of filepaths) {
    try {
      const result = await uploadAttachment(issue.id, filepath, port);
      uploaded.push(result);
      console.log(`Uploaded ${filepath} -> ${result.path} (${result.bytes} bytes)`);
    } catch (error) {
      hadFailure = true;
      console.error(`Failed to upload ${filepath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (uploaded.length === 0) {
    console.error('No files uploaded — nothing to notify the agent about.');
    return 1;
  }

  const text = opts.message?.trim()
    ? `${opts.message.trim()}\n\nAttached files (read them at these paths):\n${uploaded.map((u) => u.path).join('\n')}`
    : `Attached files (read them at these paths):\n${uploaded.map((u) => u.path).join('\n')}`;

  try {
    await postMessage(exchange, target.actor, text, port);
  } catch (error) {
    console.error(`Files uploaded but the message was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`Notified ${target.actorName ?? target.actor} on ${issue.identifier}.`);
  return hadFailure ? 1 : 0;
}
