import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { readBody, HttpError } from './httpBody.js';

function mockRequest(chunks: Buffer[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

describe('readBody UTF-8 chunk boundaries', () => {
  it('decodes a multi-byte character split across two chunks', async () => {
    // Korean '한' is UTF-8: EA B5 98 — split after first byte
    const full = Buffer.from('한', 'utf8');
    expect(full.length).toBe(3);
    const body = await readBody(mockRequest([full.subarray(0, 1), full.subarray(1)]));
    expect(body).toBe('한');
  });

  it('decodes an emoji split across chunk boundaries', async () => {
    // 😀 is F0 9F 98 80
    const full = Buffer.from('😀', 'utf8');
    const body = await readBody(mockRequest([full.subarray(0, 2), full.subarray(2)]));
    expect(body).toBe('😀');
  });

  it('rejects oversized bodies with HttpError 413', async () => {
    const req = new EventEmitter() as IncomingMessage;
    const pending = readBody(req);
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    queueMicrotask(() => req.emit('data', big));
    await expect(pending).rejects.toMatchObject({ statusCode: 413 } satisfies Partial<HttpError>);
  });
});
