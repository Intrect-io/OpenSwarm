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

/**
 * Read the full request body as a UTF-8 string, using a streaming TextDecoder
 * so that multi-byte characters split across TCP chunks are decoded correctly.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8', { stream: true });
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
      data += decoder.decode(chunk, { stream: true });
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      // Flush any remaining buffered bytes from the decoder
      data += decoder.decode();
      resolve(data);
    });
    req.on('aborted', () => fail(400, 'Request body aborted'));
    req.on('error', () => fail(400, 'Request body error'));
  });
}
