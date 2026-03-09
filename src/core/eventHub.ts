// ============================================
// OpenSwarm - Event Hub
// Global singleton EventEmitter + SSE client management
// ============================================

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { CostInfo } from '../support/costTracker.js';
import type { MonitorState } from './types.js';

// ============================================
// Types
// ============================================

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
  | { type: 'pipeline:stage'; data: { taskId: string; stage: string; status: 'start' | 'complete' | 'fail'; model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number } }
  | { type: 'pipeline:iteration'; data: { taskId: string; iteration: number } }
  | { type: 'pipeline:escalation'; data: { taskId: string; iteration: number; fromModel?: string; toModel: string } }
  | { type: 'log'; data: { taskId: string; stage: string; line: string } }
  | { type: 'project:toggled'; data: { projectPath: string; enabled: boolean } }
  | { type: 'task:cost'; data: { taskId: string; cost: CostInfo } }
  | { type: 'chat:user'; data: { text: string; ts: number } }
  | { type: 'chat:agent'; data: { text: string; ts: number } }
  | { type: 'knowledge:updated'; data: { projectSlug: string; nodeCount: number; edgeCount: number } }
  | { type: 'monitor:checked'; data: { id: string; name: string; state: MonitorState; output?: string; checkCount: number } }
  | { type: 'monitor:stateChange'; data: { id: string; name: string; from: MonitorState; to: MonitorState; issueId?: string } }
  | { type: 'process:spawn'; data: { pid: number; taskId: string; stage: string; model?: string; projectPath: string } }
  | { type: 'process:exit'; data: { pid: number; exitCode: number | null; signal: string | null; durationMs: number } }
  | { type: 'conflict:detected'; data: { repo: string; prNumber: number; branch: string } }
  | { type: 'conflict:resolving'; data: { repo: string; prNumber: number; branch: string; attempt: number } }
  | { type: 'conflict:resolved'; data: { repo: string; prNumber: number; branch: string; filesResolved: number } }
  | { type: 'conflict:failed'; data: { repo: string; prNumber: number; branch: string; reason: string } }
  | { type: 'pr_processor_start'; data: { repos: string[] } }
  | { type: 'pr_processor_end'; data: { lastRun: number | null; nextRun: number | null } }
  | { type: 'pr_processor_pr'; data: { pr: string; title: string } }
  | { type: 'heartbeat' };

// ============================================
// Singleton
// ============================================

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

// ============================================
// Exports
// ============================================

export function getEventHub(): EventEmitter {
  return hub;
}

export function broadcastEvent(event: HubEvent): void {
  // Skip replaying heartbeat/stats to avoid noise on reconnect
  if (event.type !== 'heartbeat') {
    pushReplay(event);
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

export function addSSEClient(res: ServerResponse, skipReplay = false): () => void {
  // Replay buffered events to new client so they see current state
  if (!skipReplay && replayBuffer.length > 0) {
    try {
      for (const event of replayBuffer) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      // Client already gone
    }
  }
  sseClients.add(res);

  // Cleanup function that removes client from set
  const cleanup = () => {
    sseClients.delete(res);
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
  return logBuffer;
}

export function getStageBuffer(): HubEvent[] {
  return stageBuffer;
}

export function getChatBuffer(): HubEvent[] {
  return chatBuffer;
}

// Test cleanup function - clears all buffers and clients
export function __resetForTests(): void {
  // Clear all SSE clients
  sseClients.clear();
  // Clear all buffers
  replayBuffer.length = 0;
  logBuffer.length = 0;
  stageBuffer.length = 0;
  chatBuffer.length = 0;
  // Clear all event listeners on the hub
  hub.removeAllListeners();
}
