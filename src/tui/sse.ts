// ============================================
// OpenSwarm - SSE client for the daemon event stream (EPIC INT-1813 S5)
// parseSseFrames is pure (unit-tested); connectEventStream is the network
// boundary that GETs /api/events and feeds parsed HubEvents to a callback,
// replacing the old 5-second poll in the TUI.
// ============================================

import http from 'node:http';
import type { HubEvent } from '../core/eventHub.js';

const MAX_SSE_PARTIAL_BUFFER_CHARS = 64 * 1024;
/** Bound how long we wait for response headers before treating the connect as stalled. */
const SSE_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Parse accumulated SSE text into events + the leftover (incomplete) tail.
 * Wire format (eventHub): `data: <json>\n\n` per event. Malformed frames are
 * skipped rather than throwing, so one bad frame can't kill the stream.
 */
export function parseSseFrames(buffer: string): { events: HubEvent[]; rest: string } {
  const events: HubEvent[] = [];
  let rest = buffer;
  let idx: number;
  const frameBoundary = /\r?\n\r?\n/;
  while ((idx = rest.search(frameBoundary)) !== -1) {
    const boundary = rest.slice(idx).match(frameBoundary)?.[0] ?? '\n\n';
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + boundary.length);
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      try {
        const value = JSON.parse(json) as unknown;
        if (isHubEvent(value)) events.push(value);
      } catch {
        // skip a malformed frame
      }
    }
  }
  return { events, rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHubEvent(value: unknown): value is HubEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'heartbeat') return true;
  if (!isRecord(value.data)) return false;
  if (value.type === 'pipeline:stage') {
    return typeof value.data.taskId === 'string'
      && typeof value.data.stage === 'string'
      && ['start', 'complete', 'fail'].includes(String(value.data.status));
  }
  if (value.type === 'pipeline:fanout') {
    return typeof value.data.taskId === 'string'
      && typeof value.data.enabled === 'boolean'
      && typeof value.data.shouldFanOut === 'boolean'
      && typeof value.data.score === 'number'
      && typeof value.data.threshold === 'number'
      && Array.isArray(value.data.reasons);
  }
  if (value.type === 'log') return typeof value.data.taskId === 'string' && typeof value.data.stage === 'string' && typeof value.data.line === 'string';
  if (value.type === 'process:spawn') return typeof value.data.taskId === 'string' && typeof value.data.stage === 'string';
  if (value.type === 'process:exit') return value.data.taskId === undefined || typeof value.data.taskId === 'string';
  return true;
}

export interface EventStreamHandle {
  close: () => void;
}

export interface EventStreamOptions {
  port: number;
  host?: string;
  onEvent: (event: HubEvent) => void;
  onStatus?: (connected: boolean) => void;
  /** Reconnect delay in ms after a drop/error (default 2000). */
  reconnectMs?: number;
}

export function eventStreamPath(skipReplay: boolean): string {
  return skipReplay ? '/api/events?skipReplay=1' : '/api/events';
}

function isValidSseResponse(res: http.IncomingMessage): boolean {
  if (typeof res.statusCode === 'number' && (res.statusCode < 200 || res.statusCode >= 300)) return false;

  // Unit tests use a tiny EventEmitter mock; real IncomingMessage always has headers.
  if (!Object.prototype.hasOwnProperty.call(res, 'headers')) return true;

  const rawContentType = res.headers['content-type'];
  const contentType = Array.isArray(rawContentType) ? rawContentType.join(';') : rawContentType;
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}

/** Subscribe to the daemon's /api/events SSE stream, auto-reconnecting on drop. */
export function connectEventStream(opts: EventStreamOptions): EventStreamHandle {
  const host = opts.host ?? '127.0.0.1';
  const reconnectMs = opts.reconnectMs ?? 2000;
  let buffer = '';
  let closed = false;
  let connectedOnce = false;
  let req: http.ClientRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (closed || timer) return;
    buffer = '';
    opts.onStatus?.(false);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, reconnectMs);
  };

  function connect() {
    if (closed) return;
    req = http.get(
      { host, port: opts.port, path: eventStreamPath(connectedOnce), headers: { Accept: 'text/event-stream' } },
      (res) => {
        // Headers arrived — cancel the connect-stall timer.
        req?.setTimeout(0);
        if (!isValidSseResponse(res)) {
          res.resume();
          scheduleReconnect();
          return;
        }
        connectedOnce = true;
        opts.onStatus?.(true);
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > MAX_SSE_PARTIAL_BUFFER_CHARS) {
            buffer = '';
            res.destroy(new Error('SSE partial buffer exceeded limit'));
            return;
          }
          const { events, rest } = parseSseFrames(buffer);
          buffer = rest;
          for (const e of events) opts.onEvent(e);
        });
        res.on('error', scheduleReconnect);
        res.on('end', scheduleReconnect);
      },
    );
    // If the TCP connect succeeds but headers never arrive (stalled proxy/daemon),
    // destroy and reconnect rather than hanging forever. (audit AGT-3455)
    req.setTimeout(SSE_CONNECT_TIMEOUT_MS);
    req.on('timeout', () => {
      req?.destroy(new Error('SSE connect timed out waiting for response headers'));
    });
    req.on('error', scheduleReconnect);
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
    },
  };
}
