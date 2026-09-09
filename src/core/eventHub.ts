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
  | { type: 'task:failed'; data: { taskId: string; error: string; duration: number } }
  | { type: 'task:log'; data: { taskId: string; text: string; level?: string } }
  | { type: 'task:stage'; data: { taskId: string; stage: string; status: string } }
  | { type: 'task:progress'; data: { taskId: string; progress: number; text: string } }
  | { type: 'task:cost'; data: { taskId: string; cost: CostInfo } }
  | { type: 'task:monitor'; data: { taskId: string; state: MonitorState } }
  | { type: 'task:removed'; data: { taskId: string } }
  | { type: 'task:queued:removed'; data: { taskId: string } }
  | { type: 'task:queued:reorder'; data: { taskId: string; position: number } }
  | { type: 'agent:status'; data: { agentId: string; status: string; taskId?: string } }
  | { type: 'agent:thinking'; data: { agentId: string; text: string } }
  | { type: 'agent:error'; data: { agentId: string; error: string } }
  | { type: 'agent:done'; data: { agentId: string; result: string } }
  | { type: 'chat:user'; data: { text: string } }
  | { type: 'chat:agent'; data: { text: string; agentId?: string } }
  | { type: 'coordination:event'; data: CoordinationEvent }
  | { type: 'conflict:detected'; data: { taskId: string; conflict: string } }
  | { type: 'conflict:resolved'; data: { taskId: string } }
  | { type: 'conflict:failed'; data: { taskId: string; error: string } }
  | { type: 'daemon:status'; data: { status: string; uptime: number } }
  | { type: 'daemon:error'; data: { error: string } }
  | { type: 'daemon:shutdown'; data: { reason: string } }
  | { type: 'daemon:started'; data: { generation: string } }
  | { type: 'system:info'; data: { message: string } };

// --- Buffers ---

/** Max events retained for replay to new SSE clients. */
const REPLAY_BUFFER_MAX = 500;
/** Max log events retained in memory. */
const LOG_BUFFER_MAX = 2000;
/** Max stage events retained in memory. */
const STAGE_BUFFER_MAX = 500;
/** Max chat events retained in memory. */
const CHAT_BUFFER_MAX = 200;

const replayBuffer: HubEvent[] = [];
const logBuffer: HubEvent[] = [];
const stageBuffer: HubEvent[] = [];
const chatBuffer: HubEvent[] = [];

export function pushReplay(event: HubEvent): void {
  replayBuffer.push(event);
  if (replayBuffer.length > REPLAY_BUFFER_MAX) replayBuffer.shift();
}

// --- Hub ---

const hub = new EventEmitter();

export function getEventHub(): EventEmitter {
  return hub;
}

// --- SSE Clients ---

const sseClients = new Set<ServerResponse>();

// --- Backpressure (AGT-3429) ---
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

// --- Broadcast ---

export function broadcastEvent(event: HubEvent): void {
  // Push to replay buffer
  pushReplay(event);

  // Push to typed buffers
  switch (event.type) {
    case 'task:log':
      logBuffer.push(event);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
      break;
    case 'task:stage':
    case 'task:progress':
    case 'task:cost':
    case 'task:monitor':
    case 'agent:status':
    case 'agent:thinking':
    case 'agent:error':
    case 'agent:done':
    case 'conflict:detected':
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
      const ok = res.write(data);
      if (!ok) {
        // write() returned false — socket buffer is full. Track and evict if
        // the client exceeds the backpressure threshold.
        const count = (backpressureCounts.get(res) ?? 0) + 1;
        if (count >= SSE_BACKPRESSURE_LIMIT) {
          disconnectClient(res);
        } else {
          backpressureCounts.set(res, count);
        }
      } else {
        // Successful write — reset backpressure counter for this client.
        backpressureCounts.set(res, 0);
      }
    } catch {
      disconnectClient(res);
    }
  }
}

// --- SSE Client Management ---

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