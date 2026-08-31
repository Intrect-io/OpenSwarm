// ============================================
// OpenSwarm - `openswarm board` / `openswarm threads`
// ============================================
//
// The read half of the coordination plane. `attach` (AGT-4058) gave the CLI a
// way to speak to a running agent, but no way to see who was waiting to be
// spoken to — the operator had to open the dashboard to find the question and
// then come back to the terminal to answer it. These two commands cover the
// GETs behind web/static/{orchestration,chat,threads}.html:
//
//   GET /api/coordination          -> board snapshot (pending questions first)
//   GET /api/coordination/threads  -> thread list
//
// Rendering is deliberately thin. `--json` hands back the daemon's own payload
// so a script can pipe it, and the human format only promises to make the
// parked questions findable.

import type { CoordinationEvent } from '../coordination/coordinationStore.js';
import type { CoordinationThread } from '../coordination/coordinationThreads.js';
import { DAEMON_PORT } from './daemon.js';
import { daemonBaseUrl, isRemoteDaemon, daemonHost } from './daemonEndpoint.js';

/** Matches attachHandler.ts: a daemon that answers /api/stats can still stall. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface BoardSnapshot {
  events: CoordinationEvent[];
  pending: CoordinationEvent[];
  lastSeq: number;
  traceSize?: number;
}

export interface CoordinationCommandOptions {
  port?: number;
  repository?: string;
  json?: boolean;
  limit?: number;
  status?: string;
  fetchImpl?: typeof fetch;
}

/** Shared error shape: the daemon answers 4xx with `{ error }`, plain text otherwise. */
async function readError(res: Response, fallback: string): Promise<string> {
  const detail = await res.text().catch(() => '');
  if (!detail) return `${fallback} (HTTP ${res.status})`;
  try {
    const parsed = JSON.parse(detail) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    return detail.slice(0, 200);
  }
  return `${fallback} (HTTP ${res.status})`;
}

async function getJson<T>(path: string, port: number, doFetch: typeof fetch, fallback: string): Promise<T> {
  const url = `${daemonBaseUrl(port)}${path}`;
  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    // `fetch failed` on its own tells an operator nothing about which daemon
    // was tried or what to do next, and a wrong OPENSWARM_DAEMON_HOST looks
    // identical to a stopped daemon from here.
    const where = isRemoteDaemon() ? `${daemonHost()}:${port}` : `port ${port}`;
    throw new Error(`Could not reach the OpenSwarm daemon at ${where}. `
      + (isRemoteDaemon()
        ? `Check that it is running there and that ${port} is reachable.`
        : 'Start it with `openswarm start`, or point at another host with OPENSWARM_DAEMON_HOST.')
      + ` (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (!res.ok) throw new Error(await readError(res, fallback));
  return await res.json() as T;
}

// ---- Formatting -------------------------------------------------------------

function clock(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
}

/** One line per event. The correlationId is the point: `attach` needs it. */
function formatEvent(event: CoordinationEvent): string {
  const who = event.actorName ?? event.actor;
  const task = event.taskLabel ?? event.taskId;
  const to = event.recipientName ?? event.recipient;
  return `  ${clock(event.timestamp)}  ${task}  ${who}${to ? ` -> ${to}` : ''}\n`
    + `    ${event.kind}/${event.status}  ${event.summary}\n`
    + `    correlationId: ${event.correlationId}`;
}

/**
 * `--limit` arrives from `Number.parseInt`, so it can be NaN or negative, and
 * `slice(-limit)` silently does the wrong thing with both: NaN returns the
 * whole board and a negative count slices from the wrong end.
 */
function sliceCount(limit: number, fallback = 20): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.trunc(limit));
}

export function formatBoard(snapshot: BoardSnapshot, limit: number): string {
  const count = sliceCount(limit);
  const lines: string[] = [];
  const pending = snapshot.pending ?? [];

  lines.push(pending.length
    ? `Waiting on an operator (${pending.length}):`
    : 'Waiting on an operator: none.');
  for (const event of pending) lines.push(formatEvent(event));

  const events = snapshot.events ?? [];
  const recent = events.slice(-count);
  lines.push('');
  lines.push(recent.length ? `Recent board activity (${recent.length} of ${events.length}):` : 'No board activity.');
  for (const event of recent) lines.push(formatEvent(event));

  if (pending.length) {
    lines.push('');
    lines.push('Answer one with:');
    lines.push(`  openswarm attach <issue> -m "your reply"`);
  }
  return lines.join('\n');
}

export function formatThreads(threads: CoordinationThread[], repository: string): string {
  if (!threads.length) return `No coordination threads for ${repository}.`;
  const lines = [`Coordination threads for ${repository} (${threads.length}):`];
  for (const thread of threads) {
    lines.push(`  [${thread.status}] ${thread.subject}`);
    lines.push(`    id: ${thread.id}  messages: ${thread.messageCount}  participants: ${thread.participantCount}`);
    lines.push(`    updated: ${clock(thread.updatedAt)}  tasks: ${thread.relatedTaskIds.join(', ') || '-'}`);
  }
  return lines.join('\n');
}

// ---- Commands ---------------------------------------------------------------

/** Printed once before output so a remote read is never mistaken for a local one. */
function hostNotice(): string | null {
  return isRemoteDaemon() ? `(daemon: ${daemonHost()})` : null;
}

export async function runBoardCommand(opts: CoordinationCommandOptions = {}): Promise<number> {
  const port = opts.port ?? DAEMON_PORT;
  const doFetch = opts.fetchImpl ?? fetch;
  const query = opts.repository ? `?repository=${encodeURIComponent(opts.repository)}` : '';
  try {
    const snapshot = await getJson<BoardSnapshot>(`/api/coordination${query}`, port, doFetch, 'Could not read the coordination board');
    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    const notice = hostNotice();
    if (notice) console.log(notice);
    console.log(formatBoard(snapshot, opts.limit ?? 20));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runThreadsCommand(opts: CoordinationCommandOptions = {}): Promise<number> {
  const port = opts.port ?? DAEMON_PORT;
  const doFetch = opts.fetchImpl ?? fetch;
  // The route requires a repository; the working directory is the only
  // defensible default for a command run from inside a checkout.
  const repository = opts.repository ?? process.cwd();
  const params = new URLSearchParams({ repository });
  if (opts.status) params.set('status', opts.status);
  if (opts.limit !== undefined && Number.isFinite(opts.limit)) params.set('limit', String(Math.max(1, Math.trunc(opts.limit))));
  try {
    const page = await getJson<{ items: CoordinationThread[] }>(
      `/api/coordination/threads?${params.toString()}`, port, doFetch, 'Could not list coordination threads');
    if (opts.json) {
      console.log(JSON.stringify(page, null, 2));
      return 0;
    }
    const notice = hostNotice();
    if (notice) console.log(notice);
    console.log(formatThreads(page.items ?? [], repository));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
