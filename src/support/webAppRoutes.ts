// ============================================
// OpenSwarm - Desktop-app routes (INT-3388)
// ============================================
//
// The routes added for the desktop shell + issue board, split out of web.ts
// (which is capped at 1500 lines by the pre-commit hook): /api/health, the
// /app + /static/* front-end, and the explicit work dispatch API. Auth is
// still enforced by web.ts's gates before delegation — except /api/health,
// which web.ts intentionally answers ahead of them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { readAppShell, readStaticAsset, StaticAssetError } from './staticAssets.js';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function statusCodeOf(err: unknown): number {
  return err instanceof Error && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Internal error';
}

/**
 * Handle the /app, /static/*, and /api/work* routes. Returns true when the
 * request was handled. `readBody` is injected from web.ts so its size limit
 * applies uniformly.
 */
export async function tryHandleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
  runner: AutonomousRunner | undefined,
  readBody: (req: IncomingMessage) => Promise<string>,
): Promise<boolean> {
  if (url === '/app') {
    const shell = await readAppShell();
    if (!shell) {
      writeJson(res, 404, { error: 'Static assets not built (run npm run build)' });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(shell);
    }
    return true;
  }

  if (url.startsWith('/static/')) {
    try {
      const asset = await readStaticAsset(url);
      res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-cache' });
      res.end(asset.body);
    } catch (err) {
      const status = err instanceof StaticAssetError ? err.statusCode : 500;
      writeJson(res, status, { error: messageOf(err) });
    }
    return true;
  }

  if (url === '/api/work/issues' && req.method === 'GET') {
    const projectPath = requestUrl.searchParams.get('path');
    if (!projectPath) {
      writeJson(res, 400, { error: 'Missing ?path=<projectPath>' });
      return true;
    }
    try {
      const { listWorkIssues } = await import('../automation/workRunner.js');
      writeJson(res, 200, await listWorkIssues(projectPath));
    } catch (err) {
      writeJson(res, statusCodeOf(err), { error: messageOf(err) });
    }
    return true;
  }

  if (url === '/api/work' && req.method === 'POST') {
    if (!runner) {
      writeJson(res, 503, { error: 'Runner not available (daemon starting or autonomous config missing)' });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const { dispatchWork } = await import('../automation/workRunner.js');
      const result = await dispatchWork(runner, {
        issueIds: body.issueIds,
        projectPath: body.projectPath,
      });
      writeJson(res, 202, result);
    } catch (err) {
      writeJson(res, statusCodeOf(err), { error: messageOf(err) });
    }
    return true;
  }

  return false;
}
