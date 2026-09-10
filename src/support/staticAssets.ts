// ============================================
// OpenSwarm - Static web asset resolution (INT-3388)
// ============================================
//
// The new dashboard front-end lives as real files under web/static/ instead of
// an inline TS template string. In the published package those files ship as
// dist/web-static (copied by the postbuild script); a tsx dev run has no dist,
// so the source directory is the fallback. Resolution happens once per lookup
// rather than at module load so a build finishing mid-session is picked up.

import { constants, existsSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
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

type ContainedReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'escaped' | 'not-found' };

/**
 * Resolve `relative` under `root` and read it — one race-safe strategy
 * shared by every caller below instead of a bespoke check per call site.
 * `realpathSync` resolves symlinked path segments (including a symlinked
 * directory further up the chain, or the leaf itself) up front so an escape
 * can be told apart from a plain miss; the actual read then opens that
 * resolved path with `O_NOFOLLOW`, so a same-instant swap into a symlink in
 * the window between the check and the read fails the open instead of
 * following it out of root.
 */
async function readContainedFile(root: string, relative: string): Promise<ContainedReadResult> {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const candidate = resolve(rootReal, relative);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    return { ok: false, reason: 'escaped' };
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return { ok: false, reason: 'escaped' };
  }
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // Genuinely missing, or a same-instant swap into a symlink — both are a
    // read-step failure; the escape class was already handled above.
    return { ok: false, reason: 'not-found' };
  }
  try {
    return { ok: true, body: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

/**
 * Read a static asset by its URL path under /static/. Throws StaticAssetError
 * 404 when the file (or the whole static root) is missing, and 403 when the
 * requested path escapes the static root.
 */
export async function readStaticAsset(urlPath: string): Promise<{ body: Buffer; contentType: string }> {
  const root = resolveStaticRoot();
  if (!root) throw new StaticAssetError(404, 'Static assets not built (run npm run build)');

  const relative = decodeURIComponent(urlPath.replace(/^\/static\/?/, ''));
  if (!relative || relative.includes('\0')) throw new StaticAssetError(404, 'Not found');

  const result = await readContainedFile(root, relative);
  if (!result.ok) {
    throw result.reason === 'escaped' ? new StaticAssetError(403, 'Forbidden') : new StaticAssetError(404, 'Not found');
  }
  return { body: result.body, contentType: contentTypeFor(relative) };
}

/** A fixed page-shell file at the static root — null when assets aren't built, missing, or unsafe to read. */
async function readShellFile(filename: string): Promise<Buffer | null> {
  const root = resolveStaticRoot();
  if (!root) return null;
  const result = await readContainedFile(root, filename);
  return result.ok ? result.body : null;
}

/** The /orchestration page shell, from the same static root as /app. */
export async function readOrchestrationShell(): Promise<Buffer | null> {
  return readShellFile('orchestration.html');
}

/** The /chat room shell (AGT-4019), from the same static root as /app. */
export async function readChatShell(): Promise<Buffer | null> {
  return readShellFile('chat.html');
}

/** The operator warehouse shell (AGT-4128). */
export async function readWarehouseShell(): Promise<Buffer | null> {
  return readShellFile('warehouse.html');
}

/** Durable repository thread board (AGT-4130). */
export async function readThreadBoardShell(): Promise<Buffer | null> {
  return readShellFile('threads.html');
}

/** The /app entry document, or null when assets are not present. */
export async function readAppShell(): Promise<Buffer | null> {
  return readShellFile('app.html');
}
