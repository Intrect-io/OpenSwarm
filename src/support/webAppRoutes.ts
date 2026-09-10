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
import { readStaticAsset, StaticAssetError } from './staticAssets.js';

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
 * Page shells: a URL, and the reader that returns its HTML.
 *
 * These were six copies of the same ten lines. One table and one helper means
 * a new page is one entry, and the 404-when-unbuilt behaviour has a single
 * definition rather than six that can drift apart.
 */
const PAGE_SHELLS: Record<string, () => Promise<Buffer | null>> = {
  '/orchestration': async () => (await import('./staticAssets.js')).readOrchestrationShell(),
  '/chat': async () => (await import('./staticAssets.js')).readChatShell(),
  '/warehouse': async () => (await import('./staticAssets.js')).readWarehouseShell(),
  '/usage': async () => (await import('./staticAssets.js')).readUsageShell(),
  '/threads': async () => (await import('./staticAssets.js')).readThreadBoardShell(),
  '/app': async () => (await import('./staticAssets.js')).readAppShell(),
};

/**
 * Serve the shell registered for this URL. Returns false when the URL names no
 * page, so the caller falls through to the routes after it.
 *
 * A missing shell is 404, not 500: the assets are a build product, and the
 * message says how to produce them.
 */
export async function tryServePageShell(res: ServerResponse, url: string): Promise<boolean> {
  // hasOwn, not a bare index: `url` is request input, and this must not
  // depend on the caller's `/`-prefix invariant surviving a future change.
  if (!Object.hasOwn(PAGE_SHELLS, url)) return false;
  const load = PAGE_SHELLS[url];
  const shell = await load();
  if (!shell) {
    writeJson(res, 404, { error: 'Static assets not built (run npm run build)' });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(shell);
  }
  return true;
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
  {
    const { tryHandleWarehouseRoutes } = await import('./warehouseRoutes.js');
    if (await tryHandleWarehouseRoutes(req, res, url, requestUrl)) return true;
  }

  {
    const { tryHandlePriorityCouncilRoutes } = await import('../coordination/priorityCouncilRoutes.js');
    if (await tryHandlePriorityCouncilRoutes(req, res, url, requestUrl, readBody)) return true;
  }

  {
    const { tryHandleCoordinationThreadRoutes } = await import('../coordination/coordinationThreadRoutes.js');
    if (await tryHandleCoordinationThreadRoutes(req, res, url, requestUrl, readBody)) return true;
  }

  {
    const { tryHandleCoordinationRoutes } = await import('../coordination/coordinationRoutes.js');
    if (await tryHandleCoordinationRoutes(req, res, url, requestUrl, readBody)) return true;
  }

  // Cockpit read surface (sessions/transcript/diff/quota) lives in its own
  // module (INT-3402); web.ts's auth gates already ran before this delegation.
  {
    const { tryHandleWorkSessionRoutes } = await import('./workSessionRoutes.js');
    if (await tryHandleWorkSessionRoutes(req, res, url, requestUrl, runner)) return true;
  }

  if (await tryServePageShell(res, url)) return true;

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

  if (url === '/api/work/projects' && req.method === 'GET') {
    // The dispatchable repo set — exactly what dispatchWork's boundary check
    // accepts, so the picker can never offer a path that would 403.
    // (/api/local-projects scans CHILDREN of allowed paths and omits the
    // allowed repos themselves, so it disagrees with the boundary check.)
    //
    // allowedProjects holds both tilde and absolute spellings of the same repo
    // (repos.json writes both so the denylist matches either), which the picker
    // would otherwise show as duplicate entries. Collapse by the same
    // normalization the boundary check applies, keeping the first spelling.
    const { normalizeProjectPath } = await import('../orchestration/taskScheduler.js');
    const seen = new Set<string>();
    const projects: Array<{ path: string; name: string }> = [];
    for (const path of runner?.getAllowedProjects() ?? []) {
      const canonical = normalizeProjectPath(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      projects.push({ path, name: path.split('/').filter(Boolean).pop() ?? path });
    }
    writeJson(res, 200, projects);
    return true;
  }

  if (url === '/api/work' && req.method === 'POST') {
    // Malformed input is a client error, not a daemon failure: parse and
    // shape-check explicitly (and before the runner-availability check, so a
    // bad request is reported as such even while the daemon is starting).
    let body: { issueIds?: unknown; projectPath?: unknown };
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      writeJson(res, 400, { error: 'Request body is not valid JSON' });
      return true;
    }
    if (typeof body.projectPath !== 'string' || !body.projectPath.trim()) {
      writeJson(res, 400, { error: 'projectPath must be a non-empty string' });
      return true;
    }
    if (!Array.isArray(body.issueIds) || body.issueIds.some((id) => typeof id !== 'string')) {
      writeJson(res, 400, { error: 'issueIds must be an array of strings' });
      return true;
    }
    if (!runner) {
      writeJson(res, 503, { error: 'Runner not available (daemon starting or autonomous config missing)' });
      return true;
    }
    try {
      const { dispatchWork } = await import('../automation/workRunner.js');
      const result = await dispatchWork(runner, {
        issueIds: body.issueIds as string[],
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
