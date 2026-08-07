// ============================================
// OpenSwarm - HTTP request-body helpers
// ============================================
//
// Split out of web.ts (capped at 1500 lines by the pre-commit hook) when the
// desktop-app routes landed (INT-3388). Behavior unchanged.

import type { IncomingMessage } from 'node:http';

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let totalBytes = 0;
    let settled = false;

    const fail = (statusCode: number, message: string) => {
      if (settled) return;
      settled = true;
      reject(new HttpError(statusCode, message));
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        fail(413, 'Request body too large');
        return;
      }
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(data);
    });
    req.on('aborted', () => fail(400, 'Request body aborted'));
    req.on('error', () => fail(400, 'Request body error'));
  });
}
