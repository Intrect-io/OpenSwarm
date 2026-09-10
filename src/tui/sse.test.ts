import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';

const httpGetMock = vi.hoisted(() => vi.fn());

vi.mock('node:http', () => ({
  default: { get: httpGetMock },
}));

import { connectEventStream, eventStreamPath, parseSseFrames } from './sse.js';

afterEach(() => {
  httpGetMock.mockReset();
});

describe('parseSseFrames (EPIC INT-1813 S5)', () => {
  it('parses complete frames and returns the incomplete tail', () => {
    const buf =
      'data: {"type":"heartbeat"}\n\n' +
      'data: {"type":"log","data":{"taskId":"t","stage":"s","line":"hi"}}\n\n' +
      'data: {"type":"hea';
    const { events, rest } = parseSseFrames(buf);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('heartbeat');
    expect(events[1].type).toBe('log');
    expect(rest).toBe('data: {"type":"hea');
  });

  it('skips a malformed frame without throwing', () => {
    const { events } = parseSseFrames('data: not json\n\ndata: {"type":"heartbeat"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('heartbeat');
  });

  it('parses CRLF-delimited frames', () => {
    const { events, rest } = parseSseFrames('data: {"type":"heartbeat"}\r\n\r\n');
    expect(events).toEqual([{ type: 'heartbeat' }]);
    expect(rest).toBe('');
  });

  it('rejects structurally invalid JSON values', () => {
    const { events } = parseSseFrames('data: null\n\ndata: {"type":"log","data":null}\n\ndata: {"type":"heartbeat"}\n\n');
    expect(events).toEqual([{ type: 'heartbeat' }]);
  });

  it('ignores non-data lines (SSE comments / keepalive)', () => {
    const { events, rest } = parseSseFrames(': keepalive\n\ndata: {"type":"heartbeat"}\n\n');
    expect(events).toHaveLength(1);
    expect(rest).toBe('');
  });

  it('uses skipReplay on reconnect paths to avoid replay duplicates', () => {
    expect(eventStreamPath(false)).toBe('/api/events');
    expect(eventStreamPath(true)).toBe('/api/events?skipReplay=1');
  });

  it('reconnects with skipReplay after an established stream ends', async () => {
    const paths: string[] = [];
    const responses: EventEmitter[] = [];
    httpGetMock.mockImplementation((options: { path: string }, callback: (res: EventEmitter & { setEncoding: () => void; resume?: () => void }) => void) => {
      paths.push(options.path);
      const res = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        resume: vi.fn(),
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      responses.push(res);
      callback(res);
      return Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    });

    const handle = connectEventStream({ port: 3847, onEvent: vi.fn(), reconnectMs: 1 });
    responses[0].emit('end');
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.close();

    expect(paths).toEqual(['/api/events', '/api/events?skipReplay=1']);
  });

  it('reconnects when the request stalls before response headers (AGT-3455)', async () => {
    const paths: string[] = [];
    let firstReq: EventEmitter & { destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn> };
    httpGetMock.mockImplementation((options: { path: string }, _callback: (res: EventEmitter) => void) => {
      paths.push(options.path);
      const req = Object.assign(new EventEmitter(), {
        destroy: vi.fn(function (this: EventEmitter, err?: Error) {
          this.emit('error', err ?? new Error('destroyed'));
        }),
        setTimeout: vi.fn(function (this: EventEmitter, ms: number) {
          if (ms > 0 && paths.length === 1) {
            queueMicrotask(() => this.emit('timeout'));
          }
        }),
      });
      if (paths.length === 1) firstReq = req;
      else {
        const res = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
          resume: vi.fn(),
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
        queueMicrotask(() => _callback(res));
      }
      return req;
    });

    const handle = connectEventStream({ port: 3847, onEvent: vi.fn(), reconnectMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.close();

    expect(firstReq!.destroy).toHaveBeenCalled();
    expect(paths[0]).toBe('/api/events');
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});
