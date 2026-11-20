export class PkceSettlement {
  private state: 'pending' | 'claimed' | 'settled' = 'pending';

  /** Atomically reserve the one callback allowed to perform an exchange. */
  tryClaim(): boolean {
    if (this.state !== 'pending') return false;
    this.state = 'claimed';
    return true;
  }

  /** Return true only for the first terminal completion. */
  finish(): boolean {
    if (this.state === 'settled') return false;
    this.state = 'settled';
    return true;
  }

  get settled(): boolean {
    return this.state === 'settled';
  }
}

export const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/** Minimal response surface the superseded-callback helper needs. */
export interface CallbackResponse {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

/**
 * End a callback response whose exchange lost the settlement race.
 *
 * A callback that claimed the exchange holds an open response while the token
 * request runs. If the login timeout or a server error settles the flow first,
 * the handler must not resolve or reject again, but the browser still waits on
 * this response. Returning without ending it left the tab loading and the
 * socket open. This answers exactly once with 410 Gone and `Connection: close`
 * so the socket is released; a response that already ended is left alone.
 */
export function endSupersededCallback(res: CallbackResponse): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
  }
  res.end(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenSwarm Auth</title></head>' +
      '<body><p>This login attempt already ended (timed out or was cancelled). ' +
      'Close this tab and start the login again.</p></body></html>',
  );
}
