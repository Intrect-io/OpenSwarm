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
  | { type: 'task:completed'; data: { taskId: string; success: boolean; duration: number }
      & Record<string, unknown> }
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

// --- Retention bounds (AGT-3429) -------------------------------------------
// A single retained event must never be able to dominate process memory: a
// worker report, a monitor dump, or a chat transcript can each carry megabytes
// of attacker- or workload-controlled text. Cap the serialized form of every
// event BEFORE it is retained in any ring buffer or written to any SSE client.

/** Hard cap on the serialized JSON size of a single retained event (64 KB). */
const MAX_EVENT_JSON_LENGTH = 64 * 1024;
/** Marker appended when an event's serialized payload was truncated. */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Return `event` with any oversized string fields shortened so its serialized
 * JSON form stays under `MAX_EVENT_JSON_LENGTH`. Mutates and returns the same
 * object: broadcastEvent owns the event at this point (buffers hold the same
 * reference the SSE write serializes), so one pass bounds replay, snapshot,
 * and live delivery together.
 */
function boundEventPayload(event: HubEvent): HubEvent {
  if (event.type === 'heartbeat') return event;
  const data = event.data as Record<string, unknown>;
  if (!data || typeof data !== 'object') return event;

  const measure = (): number => JSON.stringify(event).length;
  if (measure() <= MAX_EVENT_JSON_LENGTH) return event;

  // Longest string fields first: truncating the biggest offender is the
  // cheapest way back under the cap, and repeated passes converge because
  // each pass removes at least half of one oversized field.
  const stringFields = Object.entries(data)
    .filter(([, v]) => typeof v === 'string')
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);

  for (const [key, value] of stringFields) {
    const s = value as string;
    if (s.length <= TRUNCATION_MARKER.length + 1) continue;
    data[key] = s.slice(0, Math.max(1, Math.floor(s.length / 2))) + TRUNCATION_MARKER;
    if (measure() <= MAX_EVENT_JSON_LENGTH) return event;
  }

  // Still over (many medium strings or huge arrays): drop the bulky
  // non-scalar collections entirely rather than retain them.
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
      delete data[key];
      if (measure() <= MAX_EVENT_JSON_LENGTH) return event;
    }
  }
  return event;
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
  // Bound the serialized payload BEFORE retention or delivery (AGT-3429).
  boundEventPayload(event);
  // Skip replaying heartbeat/stats to avoid noise on reconnect
  if (event.type !== 'heartbeat') {
    pushReplay(event);
  }
  // Per-task transcript rings for the cockpit (INT-3402). Fed here — the one
  // choke point every emitter already goes through — so no broadcast site
  // changes. task:started/completed drive the retention lifecycle.
  if (event.type === 'log') {
    // The ring and the SSE copy of this line carry the SAME ts AND sequence,
    // which is what lets a client merge a REST snapshot with lines
    // that streamed in while the request was in flight. The sequence — not the
    // millisecond — is the join key: an agent emits several lines per ms.
    // (INT-3402)
    const ts = Date.now();
    event.data.ts = ts;
    event.data.seq = appendTaskLog(event.data.taskId, event.data.stage, event.data.line, ts);
    // Which process the sequence belongs to. Carried ON the line so a client
    // needs no separate round trip (and no ordering luck) to notice a restart.
    event.data.gen = daemonGeneration();
  } else if (event.type === 'task:started') {
    cancelTaskLogCleanup(event.data.taskId);
  } else if (event.type === 'task:completed') {
    scheduleTaskLogCleanup(event.data.taskId);
  }
  // Per-type buffers for REST snapshot
  switch (event.type) {
    case 'log':
      logBuffer.push(event);
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
      stageBuffer.push(event);
      if (stageBuffer.length > STAGE_BUFFER_MAX) stageBuffer.shift();
      break;
    case 'chat:user':
    case 'chat:agent':
      chatBuffer.push(event);
      if (chatBuffer.length > CHAT_BUFFER_MAX) chatBuffer.shift();
      break;
  }
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

// --- SSE backpressure (AGT-3429) --------------------------------------------
// res.write() returning false means the socket buffer is full. A consumer that
// never drains (dead dashboard tab, stalled reader) would otherwise make the
// hub queue megabytes per client. Track consecutive full writes and evict the
// client once it exceeds the threshold.

/** Consecutive full-buffer writes tolerated before a client is disconnected. */
const SSE_BACKPRESSURE_LIMIT = 64;
/** Hard cap on bytes queued for one client before it is disconnected. */
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const backpressureCounts = new WeakMap<ServerResponse, number>();

function disconnectClient(res: ServerResponse): void {
  sseClients.delete(res);
  backpressureCounts.delete(res);
  try {
    res.destroy();
  } catch {
    // Already gone.
  }
}

export function addSSEClient(res: ServerResponse, skipReplay = false): () => void {
  // Replay buffered events to new client so they see current state
  if (!skipReplay && replayBuffer.length > 0) {
    try {
      for (const event of replayBuffer) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      // A client that cannot consume replay is already gone. Do not retain it
      // until a future broadcast happens to discover the failure again.
      return () => {};
    }
  }
  sseClients.add(res);
  backpressureCounts.set(res, 0);

  // Cleanup function that removes client from set
  const cleanup = () => {
    sseClients.delete(res);
    backpressureCounts.delete(res);
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
