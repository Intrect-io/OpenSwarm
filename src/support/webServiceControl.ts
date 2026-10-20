// Service-control routes for the dashboard: /api/service/{status,stop,restart}.
// Split out of web.ts, which sits at the repo's per-file line cap.
import { execFile } from 'node:child_process';
import type { ServerResponse } from 'node:http';

// `systemctl` talking to a wedged user service manager can hang past any
// caller's patience; bound it so a stuck call surfaces as a controlled error
// instead of leaving the HTTP request open indefinitely. (AGT-3408)
const SYSTEMCTL_TIMEOUT_MS = 10_000;

// Never leak raw Error objects (which include stack traces in many runtimes)
// or arbitrary thrown values to HTTP responses.
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return 'Internal error';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function systemctl(action: 'stop' | 'restart'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('systemctl', ['--user', action, 'openswarm'], { timeout: SYSTEMCTL_TIMEOUT_MS }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * Serve one service-control route. Returns false when `url`/`method` is not one
 * of them, so the caller's router can keep looking.
 */
export async function handleServiceControl(url: string, method: string | undefined, res: ServerResponse): Promise<boolean> {
  if (url === '/api/service/status' && method === 'GET') {
    try {
      const status = await new Promise<string>((resolve) => {
        execFile('systemctl', ['--user', 'is-active', 'openswarm'], { timeout: SYSTEMCTL_TIMEOUT_MS }, (err, stdout) => {
          resolve(err ? 'unknown' : stdout.trim());
        });
      });
      sendJson(res, 200, { status });
    } catch {
      sendJson(res, 500, { status: 'unknown' });
    }
    return true;
  }
  const action = url === '/api/service/stop' ? 'stop' : url === '/api/service/restart' ? 'restart' : null;
  if (!action || method !== 'POST') return false;
  try {
    await systemctl(action);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: safeErrorMessage(e) });
  }
  return true;
}
