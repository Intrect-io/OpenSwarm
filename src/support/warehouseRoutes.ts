// Operator-facing warehouse API (AGT-4128).
// web.ts applies local/Tailscale/token authorization before delegating here.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants, existsSync, realpathSync } from 'node:fs';
import { link, lstat, open, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

class WarehouseHttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRoot(): string {
  return process.env.OPENSWARM_WAREHOUSE_ROOT?.trim() || '/warehouse';
}

function writeRoot(): string {
  return process.env.OPENSWARM_WAREHOUSE_WRITE_ROOT?.trim() || readRoot();
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(raw: string | null, allowEmpty: boolean): string {
  const value = (raw ?? '').trim();
  if ((!value && !allowEmpty) || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new WarehouseHttpError(400, 'path must be a relative warehouse path');
  }
  return value;
}

function existingRoot(root: string): string {
  if (!existsSync(root)) throw new WarehouseHttpError(503, 'Warehouse is not provisioned');
  return realpathSync(root);
}

/** Resolve and authorize an existing path once; callers perform I/O on this exact string. */
export function resolveWarehouseReadPath(raw: string | null, allowEmpty = false): string {
  const rel = safeRelativePath(raw, allowEmpty);
  const root = existingRoot(readRoot());
  const lexical = resolve(root, rel || '.');
  if (!isInside(root, lexical)) throw new WarehouseHttpError(403, 'Path escapes the warehouse');
  let canonical: string;
  try {
    canonical = realpathSync(lexical);
  } catch {
    throw new WarehouseHttpError(404, 'Warehouse path not found');
  }
  if (!isInside(root, canonical)) throw new WarehouseHttpError(403, 'Path escapes the warehouse');
  return canonical;
}

interface AnchoredTarget {
  directory: FileHandle;
  ioDirectory: string;
  name: string;
}

/**
 * Anchor a final path component to an already-open, authorized directory.
 * Linux production I/O goes through /proc/self/fd/<dirfd>, which prevents a
 * path component from being swapped after validation. The inode recheck is the
 * portable fallback used by development/test hosts without procfs dirfd paths.
 */
async function openAnchoredTarget(rootPath: string, raw: string | null): Promise<AnchoredTarget> {
  const rel = safeRelativePath(raw, false);
  const root = existingRoot(rootPath);
  const lexical = resolve(root, rel);
  if (!isInside(root, lexical)) throw new WarehouseHttpError(403, 'Path escapes the warehouse');

  let parent: string;
  try {
    parent = realpathSync(resolve(lexical, '..'));
  } catch {
    throw new WarehouseHttpError(404, 'Warehouse directory not found');
  }
  if (!isInside(root, parent)) throw new WarehouseHttpError(403, 'Path escapes the warehouse');

  const directory = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedInfo = await directory.stat();
    let ioDirectory = parent;
    if (process.platform === 'linux') {
      ioDirectory = `/proc/self/fd/${directory.fd}`;
      const openedPath = realpathSync(ioDirectory);
      if (!isInside(root, openedPath)) throw new WarehouseHttpError(403, 'Path escapes the warehouse');
    } else {
      const currentPath = realpathSync(parent);
      const currentInfo = await stat(currentPath);
      if (
        !isInside(root, currentPath)
        || currentInfo.dev !== openedInfo.dev
        || currentInfo.ino !== openedInfo.ino
      ) {
        throw new WarehouseHttpError(403, 'Warehouse directory changed during validation');
      }
    }
    return { directory, ioDirectory, name: basename(lexical) };
  } catch (error) {
    await directory.close();
    throw error;
  }
}

function readUpload(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(bytes);
      }
    });
    req.on('end', () => {
      if (tooLarge) reject(new WarehouseHttpError(413, `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`));
      else resolveBody(Buffer.concat(chunks));
    });
    req.on('aborted', () => reject(new WarehouseHttpError(400, 'Upload aborted')));
    req.on('error', () => reject(new WarehouseHttpError(400, 'Upload failed')));
  });
}

async function writeUpload(target: AnchoredTarget, body: Buffer, overwrite: boolean): Promise<void> {
  const temporaryName = `.${target.name}.${process.pid}.${randomUUID()}.tmp`;
  const temporary = join(target.ioDirectory, temporaryName);
  const destination = join(target.ioDirectory, target.name);
  let handle: FileHandle | null = null;
  try {
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink()) throw new WarehouseHttpError(403, 'Symbolic-link targets are not accepted');
      if (existing.isDirectory()) throw new WarehouseHttpError(409, 'Upload target is a directory');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    if (overwrite) {
      await rename(temporary, destination);
    } else {
      // link() is the atomic no-clobber publication step: unlike access()+
      // rename(), it cannot overwrite a target created between the two calls.
      await link(temporary, destination);
      await unlink(temporary);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function statusOf(error: unknown): number {
  if (error instanceof WarehouseHttpError) return error.statusCode;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return 409;
  if (error && typeof error === 'object' && 'code' in error && ['ELOOP', 'EPERM'].includes(String(error.code))) return 403;
  if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return 404;
  return 500;
}

function messageOf(error: unknown): string {
  if (error instanceof WarehouseHttpError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    return 'File already exists; enable overwrite explicitly';
  }
  if (error && typeof error === 'object' && 'code' in error && ['ELOOP', 'EPERM'].includes(String(error.code))) {
    return 'Symbolic-link targets are not accepted';
  }
  if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
    return 'Warehouse path not found';
  }
  return 'Warehouse operation failed';
}

export async function tryHandleWarehouseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url === '/api/warehouse/tree') {
    try {
      const directory = resolveWarehouseReadPath(requestUrl.searchParams.get('path'), true);
      if (!(await stat(directory)).isDirectory()) throw new WarehouseHttpError(400, 'Path is not a directory');
      const entries = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const info = await lstat(join(directory, entry.name));
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          size: info.size,
          mtime: info.mtime.toISOString(),
        };
      }));
      entries.sort((a, b) => (a.type === 'directory' ? -1 : 1) - (b.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
      writeJson(res, 200, { path: requestUrl.searchParams.get('path') ?? '', entries });
    } catch (error) {
      writeJson(res, statusOf(error), { error: messageOf(error) });
    }
    return true;
  }

  if (req.method === 'GET' && url === '/api/warehouse/file') {
    let target: AnchoredTarget | null = null;
    let file: FileHandle | null = null;
    try {
      target = await openAnchoredTarget(readRoot(), requestUrl.searchParams.get('path'));
      file = await open(join(target.ioDirectory, target.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile()) throw new WarehouseHttpError(400, 'Path is not a file');
      const body = await file.readFile();
      const filename = target.name.replace(/["\\\r\n]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      res.end(body);
    } catch (error) {
      writeJson(res, statusOf(error), { error: messageOf(error) });
    } finally {
      await file?.close().catch(() => {});
      await target?.directory.close().catch(() => {});
    }
    return true;
  }

  if (req.method === 'POST' && url === '/api/warehouse/file') {
    let target: AnchoredTarget | null = null;
    try {
      target = await openAnchoredTarget(writeRoot(), requestUrl.searchParams.get('path'));
      const overwrite = requestUrl.searchParams.get('overwrite') === 'true';
      const body = await readUpload(req);
      await writeUpload(target, body, overwrite);
      writeJson(res, 201, { ok: true, path: requestUrl.searchParams.get('path'), size: body.length, overwritten: overwrite });
    } catch (error) {
      writeJson(res, statusOf(error), { error: messageOf(error) });
    } finally {
      await target?.directory.close().catch(() => {});
    }
    return true;
  }

  return false;
}
