// Kill-switch routes for the dashboard (AGT-4808):
//   GET  /api/factory/pause   -> { pauses, error? }
//   POST /api/factory/pause   { projectPath?, mode?: 'drain'|'now', reason? }
//   POST /api/factory/resume  { projectPath? }
// Split out of web.ts, which sits at the repo's per-file line cap. The rows are
// the same ones `openswarm pause` writes; the daemon applies them on its next
// heartbeat with no restart.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunnerPauseControl } from '../automation/runnerPauseControl.js';
import { readBody } from './httpBody.js';
import { safeErrorMessage } from './webServiceControl.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Returns false when the route is not one of these, so the caller's router keeps looking. */
export async function handleFactoryPause(
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
  pauses: RunnerPauseControl | undefined,
  log: (line: string) => void = () => {},
): Promise<boolean> {
  const isPause = url === '/api/factory/pause';
  const isResume = url === '/api/factory/resume';
  if (!isPause && !isResume) return false;
  if (isResume && req.method !== 'POST') return false;
  if (req.method !== 'GET' && req.method !== 'POST') return false;
  if (!pauses) {
    sendJson(res, 503, { error: 'No daemon runner is attached to this dashboard' });
    return true;
  }
  if (req.method === 'GET') {
    const state = pauses.list();
    sendJson(res, state.error ? 500 : 200, state);
    return true;
  }
  let input: { projectPath?: unknown; mode?: unknown; reason?: unknown };
  try {
    input = JSON.parse((await readBody(req)) || '{}') as typeof input;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return true;
  }
  const projectPath = typeof input.projectPath === 'string' && input.projectPath.trim() ? input.projectPath : null;
  const mode = input.mode === undefined || input.mode === 'drain' ? 'drain' : input.mode === 'now' ? 'now' : undefined;
  if (!mode) {
    sendJson(res, 400, { error: "mode must be 'drain' or 'now'" });
    return true;
  }
  try {
    if (isPause) {
      pauses.store.set({ projectPath, mode, reason: typeof input.reason === 'string' ? input.reason : undefined, actor: 'dashboard' });
      log(`⏸ Pause set from the dashboard (${projectPath ?? 'factory'}, ${mode}); applies on the next heartbeat`);
    } else {
      pauses.store.clear(projectPath);
      log(`▶ Pause lifted from the dashboard (${projectPath ?? 'factory'})`);
    }
    sendJson(res, 200, { ok: true, ...pauses.list() });
  } catch (error) {
    sendJson(res, 500, { error: safeErrorMessage(error) });
  }
  return true;
}
