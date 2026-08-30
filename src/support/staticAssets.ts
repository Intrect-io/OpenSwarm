// ============================================
// OpenSwarm - Static web asset resolution (INT-3388)
// ============================================
//
// The new dashboard front-end lives as real files under web/static/ instead of
// an inline TS template string. In the published package those files ship as
// dist/web-static (copied by the postbuild script); a tsx dev run has no dist,
// so the source directory is the fallback. Resolution happens once per lookup
// rather than at module load so a build finishing mid-session is picked up.

import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** Package root: staticAssets.js sits at <pkg>/dist/support/ (or src/support/ under tsx). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function resolveStaticRoot(): string | null {
  const root = packageRoot();
  for (const candidate of [join(root, 'dist', 'web-static'), join(root, 'web', 'static')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class StaticAssetError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Read a static asset by its URL path under /static/. Throws StaticAssetError
 * 404 when the file (or the whole static root) is missing, and 403 when the
 * requested path escapes the static root — `resolve()` collapses `..`
 * segments, and the realpath check keeps a symlink planted inside the root
 * from serving files outside it.
 */
export async function readStaticAsset(urlPath: string): Promise<{ body: Buffer; contentType: string }> {
  const root = resolveStaticRoot();
  if (!root) throw new StaticAssetError(404, 'Static assets not built (run npm run build)');

  const relative = decodeURIComponent(urlPath.replace(/^\/static\/?/, ''));
  if (!relative || relative.includes('\0')) throw new StaticAssetError(404, 'Not found');

  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, relative);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new StaticAssetError(403, 'Forbidden');
  }

  let fileReal: string;
  try {
    fileReal = realpathSync(candidate);
  } catch {
    throw new StaticAssetError(404, 'Not found');
  }
  if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
    throw new StaticAssetError(403, 'Forbidden');
  }

  try {
    const body = await readFile(fileReal);
    return { body, contentType: contentTypeFor(candidate) };
  } catch {
    throw new StaticAssetError(404, 'Not found');
  }
}

/** The /app entry document, or null when assets are not present. */
/** The /orchestration page shell, from the same static root as /app. */
export async function readOrchestrationShell(): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, 'orchestration.html'));
  } catch {
    return null;
  }
}

/** The /chat room shell (AGT-4019), from the same static root as /app. */
export async function readChatShell(): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, 'chat.html'));
  } catch {
    return null;
  }
}

/** The operator warehouse shell (AGT-4128). */
export async function readWarehouseShell(): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, 'warehouse.html'));
  } catch {
    return null;
  }
}

/** Durable repository thread board (AGT-4130). */
export async function readThreadBoardShell(): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, 'threads.html'));
  } catch {
    return null;
  }
}

export async function readAppShell(): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return await readFile(join(root, 'app.html'));
  } catch {
    return null;
  }
}
