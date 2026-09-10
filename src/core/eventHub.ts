// ============================================
// OpenSwarm - Event Hub
// Global singleton EventEmitter + SSE client management
// ============================================

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { CostInfo } from '../support/costTracker.js';
import type { MonitorState } from './types.js';
import type { CoordinationEvent } from '../coordination/coordinationStore.js';
import {
  appendTaskLog,
  cancelTaskLogCleanup,
  scheduleTaskLogCleanup,
  __resetTaskLogsForTests,
} from './taskLogStore.js';
import { getInstanceId } from '../support/healthEndpoint.js';

// Resolved once; healthEndpoint mints it at module load.
let cachedGeneration: string | null = null;
function daemonGeneration(): string {
  cachedGeneration ??= getInstanceId();
  return cachedGeneration;
}

// Types

export interface SwarmStats {
  runningTasks: number;
  queuedTasks: number;
  completedToday: number;
  uptime: number;
  schedulerPaused: boolean;
}

export type HubEvent =
  | { type: 'stats'; data: SwarmStats }
  | { type: 'task:queued'; data: { taskId: string; title: string; projectPath: string; issueIdentifier?: string } }
  | { type: 'task:started'; data: { taskId: string; title: string; issueIdentifier?: string } }
  | { type: 'task:completed'; data: { taskId: string; success: boolean; duration: number } }
  | { type: 'pipeline:stage'; data: {
      taskId: string;
      stage: string;
      status: 'start' | 'complete' | 'fail';
      repository?: string;
      projectPath?: string;
      worktree?: string;
      branch?: string;
      issueIdentifier?: string;
      title?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      durationMs?: number;
      // What the agent actually produced — populated for `status: 'complete'`.
      summary?: string;
      filesChanged?: string[];
      filesChangedCount?: number;
      commands?: string[];
      commandsCount?: number;
      decision?: 'approve' | 'revise' | 'reject';
      feedback?: string;
      issues?: string[];
      issuesCount?: number;
      suggestionsCount?: number;
      // Tester
      passed?: number;
      failed?: number;
      coverage?: number;
      failedTests?: string[];
      // Documenter
      changelogEntry?: string;
      // Auditor
      bsScore?: number;
      criticalCount?: number;
      warningCount?: number;
      // Worker confidence-gate
      confidencePercent?: number;
      haltReason?: string;
      rateLimitResetsAt?: number;
      // Errors
      error?: string;
    } }
  | { type: 'pipeline:iteration'; data: { taskId: string; iteration: number } }
  | { type: 'pipeline:escalation'; data: { taskId: string; iteration: number; fromModel?: string; toModel?: string; toEffort?: string; reason?: string } }
  | { type: 'pipeline:fanout'; data: {
      taskId: string;
      iteration: number;
      enabled: boolean;
      shouldFanOut: boolean;
      score: number;
      threshold: number;
      reasons: string[];
    } }
  // `ts`/`seq` are stamped by broadcastEvent, not by emitters — see its log case.
  | { type: 'log'; data: { taskId: string; stage: string; line: string; ts?: number; seq?: number; gen?: string } }
  | { type: 'project:toggled'; data: { projectPath: string; enabled: boolean } }
  | { type: 'task:cost'; data: { taskId: string; cost: CostInfo } }
  | { type: 'chat:user'; data: { text: string; ts: number } }
  | { type: 'chat:agent'; data: { text: string; ts: number } }
  | { type: 'knowledge:updated'; data: { projectSlug: string; nodeCount: number; edgeCount: number } }
  | { type: 'monitor:checked'; data: { id: string; name: string; state: MonitorState; output?: string; checkCount: number } }
  | { type: 'monitor:stateChange'; data: { id: string; name: string; from: MonitorState; to: MonitorState; issueId?: string } }
  | { type: 'process:spawn'; data: { pid: number; taskId: string; stage: string; model?: string; projectPath: string } }
  | { type: 'process:exit'; data: {
      pid: number;
      taskId?: string;
      stage?: string;
      model?: string;
      projectPath?: string;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
    } }
  | { type: 'conflict:detected'; data: { repo: string; prNumber: number; branch: string } }
  | { type: 'conflict:resolving'; data: { repo: string; prNumber: number; branch: string; attempt: number } }
  | { type: 'conflict:resolved'; data: { repo: string; prNumber: number; branch: string; filesResolved: number } }
  | { type: 'conflict:failed'; data: { repo: string; prNumber: number; branch: string; reason: string } }
  | { type: 'pr_processor_start'; data: { repos: string[] } }
  | { type: 'pr_processor_end'; data: { lastRun: number | null; nextRun: number | null } }
  | { type: 'pr_processor_pr'; data: { pr: string; title: string } }
  | { type: 'work:queued'; data: { workId: string; projectPath: string; taskIds: string[] } }
  | { type: 'coordination:event'; data: CoordinationEvent }
  | { type: 'heartbeat' };

// Singleton

const hub = new EventEmitter();
hub.setMaxListeners(50);

const sseClients = new Set<ServerResponse>();

// Ring buffer: replay last 500 events to new SSE clients
// Excludes high-frequency log lines (only last 50 logs kept)
const EVENT_REPLAY_MAX = 500;
const LOG_REPLAY_MAX = 50;
const replayBuffer: HubEvent[] = [];

// Per-type buffers for REST snapshot endpoints (dashboard refresh)
const LOG_BUFFER_MAX = 300;
const STAGE_BUFFER_MAX = 200;
const CHAT_BUFFER_MAX = 100;

const logBuffer: HubEvent[] = [];
const stageBuffer: HubEvent[] = [];
const chatBuffer: HubEvent[] = [];

// --- Payload / backpressure bounds (AGT-3429) ---
/** Hard cap on one serialized SSE frame (bytes). Oversized events are truncated or dropped. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
/** Hard cap on a single log line retained/broadcast (chars). */
export const MAX_LOG_LINE_CHARS = 4_000;
/** Hard cap on chat text retained/broadcast (chars). */
export const MAX_CHAT_TEXT_CHARS = 16_384;
/** Consecutive full-buffer writes tolerated before a client is disconnected. */
export const SSE_BACKPRESSURE_LIMIT = 64;
/** Hard cap on bytes queued for one client before it is disconnected. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const backpressureCounts = new WeakMap<ServerResponse, number>();
const bufferedBytes = new WeakMap<ServerResponse, number>();

function disconnectClient(res: ServerResponse): void {
  sseClients.delete(res);
  backpressureCounts.delete(res);
  bufferedBytes.delete(res);
  try {
    res.destroy();
  } catch {
    // Already gone.
  }
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Bound attacker-/workload-controlled string fields before JSON serialization
 * so a single event cannot exhaust process memory via retain or fan-out.
 */
function boundEventPayload(event: HubEvent): HubEvent {
  switch (event.type) {
    case 'log':
      return {
        ...event,
        data: { ...event.data, line: truncateChars(event.data.line, MAX_LOG_LINE_CHARS) },
      };
    case 'chat:user':
    case 'chat:agent':
      return {
        ...event,
        data: { ...event.data, text: truncateChars(event.data.text, MAX_CHAT_TEXT_CHARS) },
      };
    case 'pipeline:stage': {
      const d = event.data;
      return {
        ...event,
        data: {
          ...d,
          summary: d.summary !== undefined ? truncateChars(d.summary, MAX_LOG_LINE_CHARS) : undefined,
          feedback: d.feedback !== undefined ? truncateChars(d.feedback, MAX_LOG_LINE_CHARS) : undefined,
          error: d.error !== undefined ? truncateChars(d.error, MAX_LOG_LINE_CHARS) : undefined,
          haltReason: d.haltReason !== undefined ? truncateChars(d.haltReason, MAX_LOG_LINE_CHARS) : undefined,
          changelogEntry: d.changelogEntry !== undefined ? truncateChars(d.changelogEntry, MAX_LOG_LINE_CHARS) : undefined,
          filesChanged: d.filesChanged?.slice(0, 64).map((f) => truncateChars(f, 512)),
          commands: d.commands?.slice(0, 64).map((c) => truncateChars(c, 512)),
          issues: d.issues?.slice(0, 64).map((i) => truncateChars(i, 512)),
          failedTests: d.failedTests?.slice(0, 64).map((t) => truncateChars(t, 512)),
        },
      };
    }
    case 'monitor:checked':
      return {
        ...event,
        data: {
          ...event.data,
          output: event.data.output !== undefined
            ? truncateChars(event.data.output, MAX_LOG_LINE_CHARS)
            : undefined,
        },
      };
    case 'conflict:failed':
      return {
        ...event,
        data: { ...event.data, reason: truncateChars(event.data.reason, MAX_LOG_LINE_CHARS) },
      };
    case 'pipeline:escalation':
      return {
        ...event,
        data: {
          ...event.data,
          reason: event.data.reason !== undefined
            ? truncateChars(event.data.reason, MAX_LOG_LINE_CHARS)
            : undefined,
        },
      };
    default:
      return event;
  }
}

/** Serialize an event for SSE; drop if still over the hard byte cap after field bounds. */
function serializeEventFrame(event: HubEvent): string | null {
  const bounded = boundEventPayload(event);
  const frame = `data: ${JSON.stringify(bounded)}\n\n`;
  if (Buffer.byteLength(frame, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    return null;
  }
  return frame;
}

function writeToClient(res: ServerResponse, data: string): void {
  try {
    const ok = res.write(data);
    if (!ok) {
      const nextCount = (backpressureCounts.get(res) ?? 0) + 1;
      const nextBytes = (bufferedBytes.get(res) ?? 0) + Buffer.byteLength(data, 'utf8');
      if (nextCount >= SSE_BACKPRESSURE_LIMIT || nextBytes >= SSE_MAX_BUFFERED_BYTES) {
        disconnectClient(res);
        return;
      }
      backpressureCounts.set(res, nextCount);
      bufferedBytes.set(res, nextBytes);
      res.once('drain', () => {
        backpressureCounts.set(res, 0);
        bufferedBytes.set(res, 0);
      });
    } else {
      backpressureCounts.set(res, 0);
      bufferedBytes.set(res, 0);
    }
  } catch {
    disconnectClient(res);
  }
}

function pushReplay(event: HubEvent): void {
  if (event.type === 'log') {
    // Keep only recent log lines in replay buffer to avoid bloat
    const logCount = replayBuffer.filter(e => e.type === 'log').length;
    if (logCount >= LOG_REPLAY_MAX) {
      const firstLogIdx = replayBuffer.findIndex(e => e.type === 'log');
      if (firstLogIdx !== -1) replayBuffer.splice(firstLogIdx, 1);
    }
  }
  replayBuffer.push(event);
  if (replayBuffer.length > EVENT_REPLAY_MAX) {
    replayBuffer.shift();
  }
}

// Exports

export function getEventHub(): EventEmitter {
  return hub;
}

export function broadcastEvent(event: HubEvent): void {
  // Bound payload fields before any retain / serialize / fan-out.
  const bounded = boundEventPayload(event);
  // Mutate the caller's event when it is a log so stamped ts/seq remain visible
  // on the same object emitters may hold (INT-3402 tests rely on this).
  if (event.type === 'log' && bounded.type === 'log') {
    event.data.line = bounded.data.line;
  } else if (
    (event.type === 'chat:user' || event.type === 'chat:agent')
    && (bounded.type === 'chat:user' || bounded.type === 'chat:agent')
  ) {
    event.data.text = bounded.data.text;
  }

  const overCap = bounded.type !== 'heartbeat'
    && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_EVENT_PAYLOAD_BYTES;

  // Skip replaying heartbeat/stats to avoid noise on reconnect
  if (bounded.type !== 'heartbeat' && !overCap) {
    pushReplay(bounded);
  }
  // Per-task transcript rings for the cockpit (INT-3402). Fed here — the one
  // choke point every emitter already goes through — so no broadcast site
  // changes. task:started/completed drive the retention lifecycle.
  if (bounded.type === 'log' && event.type === 'log') {
    // The ring and the SSE copy of this line carry the SAME ts AND sequence,
    // which is what lets a client merge a REST transcript snapshot with lines
    // that streamed in while the request was in flight. The sequence — not the
    // millisecond — is the join key: an agent emits several lines per ms.
    // (INT-3402)
    const ts = Date.now();
    event.data.ts = ts;
    bounded.data.ts = ts;
    const seq = appendTaskLog(event.data.taskId, event.data.stage, event.data.line, ts);
    event.data.seq = seq;
    bounded.data.seq = seq;
    // Which process the sequence belongs to. Carried ON the line so a client
    // needs no separate round trip (and no ordering luck) to notice a restart.
    const gen = daemonGeneration();
    event.data.gen = gen;
    bounded.data.gen = gen;
  } else if (bounded.type === 'task:started') {
    cancelTaskLogCleanup(bounded.data.taskId);
  } else if (bounded.type === 'task:completed') {
    scheduleTaskLogCleanup(bounded.data.taskId);
  }
  if (overCap) return;
  // Per-type buffers for REST snapshot
  switch (bounded.type) {
    case 'log':
      logBuffer.push(bounded);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
      break;
    case 'pipeline:stage':
    case 'pipeline:iteration':
    case 'pipeline:escalation':
    case 'pipeline:fanout':
    case 'task:queued':
    case 'task:started':
    case 'task:completed':
    case 'task:cost':
    case 'monitor:checked':
    case 'monitor:stateChange':
    case 'process:spawn':
    case 'process:exit':
    case 'conflict:detected':
    case 'conflict:resolving':
    case 'conflict:resolved':
    case 'conflict:failed':
    case 'coordination:event':
      stageBuffer.push(bounded);
      if (stageBuffer.length > STAGE_BUFFER_MAX) stageBuffer.shift();
      break;
    case 'chat:user':
    case 'chat:agent':
      chatBuffer.push(bounded);
      if (chatBuffer.length > CHAT_BUFFER_MAX) chatBuffer.shift();
      break;
  }
  const data = serializeEventFrame(bounded);
  if (data === null) return;
  for (const res of sseClients) {
    writeToClient(res, data);
  }
}

export function addSSEClient(res: ServerResponse, skipReplay = false): () => void {
  // Replay buffered events to new client so they see current state
  if (!skipReplay && replayBuffer.length > 0) {
    try {
      for (const event of replayBuffer) {
        const frame = serializeEventFrame(event);
        if (frame === null) continue;
        res.write(frame);
      }
    } catch {
      // A client that cannot consume replay is already gone. Do not retain it
      // until a future broadcast happens to discover the failure again.
      return () => {};
    }
  }
  sseClients.add(res);
  backpressureCounts.set(res, 0);
  bufferedBytes.set(res, 0);

  // Cleanup function that removes client from set
  const cleanup = () => {
    sseClients.delete(res);
    backpressureCounts.delete(res);
    bufferedBytes.delete(res);
    // Remove the close listener after cleanup to prevent memory leak
    res.removeListener('close', cleanup);
  };

  // Register close listener to auto-cleanup when client disconnects
  res.once('close', cleanup);

  return cleanup;
}

export function getActiveSSECount(): number {
  return sseClients.size;
}

export function getLogBuffer(): HubEvent[] {
  return structuredClone(logBuffer);
}

export function getStageBuffer(): HubEvent[] {
  return structuredClone(stageBuffer);
}

export function getChatBuffer(): HubEvent[] {
  return structuredClone(chatBuffer);
}

// Test cleanup function - clears all buffers and clients
export function __resetForTests(): void {
  // Clear all SSE clients
  sseClients.clear();
  __resetTaskLogsForTests();
  // Clear all buffers
  replayBuffer.length = 0;
  logBuffer.length = 0;
  stageBuffer.length = 0;
  chatBuffer.length = 0;
  // Clear all event listeners on the hub
  hub.removeAllListeners();
}
