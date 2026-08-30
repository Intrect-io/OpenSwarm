import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tryHandleWarehouseRoutes } from './warehouseRoutes.js';

const ROOT = await fs.mkdtemp('/var/tmp/openswarm-warehouse-routes-');
const OUTSIDE = await fs.mkdtemp('/var/tmp/openswarm-warehouse-outside-');

type Response = { handled: boolean; status: number; headers: Record<string, string>; body: Buffer };

async function call(
  method: string,
  rawUrl: string,
  body: Buffer = Buffer.alloc(0),
  abortAfterHeaders = false,
): Promise<Response> {
  const req = Object.assign(Readable.from(body.length ? [body] : []), { method, headers: {} }) as IncomingMessage;
  let status = 0;
  let headersSent = false;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = new PassThrough() as unknown as ServerResponse;
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('error', () => {});
  Object.defineProperty(res, 'headersSent', { get: () => headersSent });
  res.writeHead = ((code: number, values: Record<string, string> = {}) => {
    status = code;
    headersSent = true;
    headers = values;
    if (abortAfterHeaders) res.destroy(new Error('simulated client disconnect'));
    return res;
  }) as ServerResponse['writeHead'];
  const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
  const handled = await tryHandleWarehouseRoutes(req, res, requestUrl.pathname, requestUrl);
  return { handled, status, headers, body: Buffer.concat(chunks) };
}

function json(response: Response): any {
  return JSON.parse(response.body.toString('utf8'));
}

beforeAll(async () => {
  vi.stubEnv('OPENSWARM_WAREHOUSE_ROOT', ROOT);
  vi.stubEnv('OPENSWARM_WAREHOUSE_WRITE_ROOT', ROOT);
  await fs.mkdir(path.join(ROOT, 'vega-agent', 'env'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'INDEX.md'), '# Warehouse\n');
  await fs.writeFile(path.join(ROOT, 'vega-agent', 'env', '.env'), 'KEY=value\n');
  await fs.symlink(path.join(ROOT, 'INDEX.md'), path.join(ROOT, 'inside-link'));
  await fs.writeFile(path.join(OUTSIDE, 'secret.txt'), 'outside\n');
  await fs.symlink(path.join(OUTSIDE, 'secret.txt'), path.join(ROOT, 'outside-link'));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.rm(OUTSIDE, { recursive: true, force: true });
});

describe('warehouse HTTP routes', () => {
  it('lists dotfiles with size and mtime for browser exploration', async () => {
    const response = await call('GET', '/api/warehouse/tree?path=vega-agent/env');
    expect(response).toMatchObject({ handled: true, status: 200 });
    expect(json(response).entries).toEqual([
      expect.objectContaining({ name: '.env', type: 'file', size: 10 }),
    ]);
  });

  it('bounds every directory request to 201 reads and requires subdirectories above 200 entries', async () => {
    const many = path.join(ROOT, 'many');
    await fs.mkdir(many);
    await Promise.all(Array.from({ length: 205 }, (_, index) => (
      fs.writeFile(path.join(many, `item-${String(index).padStart(3, '0')}`), '')
    )));
    const response = await call('GET', '/api/warehouse/tree?path=many');
    expect(response.status).toBe(413);
    expect(json(response).error).toContain('split it into subdirectories');
  });

  it('downloads the authorized canonical file with attachment headers', async () => {
    const response = await call('GET', '/api/warehouse/file?path=INDEX.md');
    expect(response.status).toBe(200);
    expect(response.headers['Content-Disposition']).toContain('attachment');
    expect(response.body.toString('utf8')).toBe('# Warehouse\n');
  });

  it('does not attempt a JSON error after download headers are committed', async () => {
    const response = await call('GET', '/api/warehouse/file?path=INDEX.md', Buffer.alloc(0), true);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(0);
  });

  it('uploads without clobbering, then overwrites only when explicit', async () => {
    const file = 'vega-agent/env/new.env';
    const created = await call('POST', `/api/warehouse/file?path=${file}`, Buffer.from('one'));
    const refused = await call('POST', `/api/warehouse/file?path=${file}`, Buffer.from('two'));
    const replaced = await call('POST', `/api/warehouse/file?path=${file}&overwrite=true`, Buffer.from('two'));
    expect(created.status).toBe(201);
    expect(refused.status).toBe(409);
    expect(replaced.status).toBe(201);
    await expect(fs.readFile(path.join(ROOT, file), 'utf8')).resolves.toBe('two');
  });

  it.each([
    '/api/warehouse/file?path=../outside',
    '/api/warehouse/file?path=/etc/passwd',
    '/api/warehouse/file?path=C:%5CWindows%5Cwin.ini',
    '/api/warehouse/file?path=inside-link',
    '/api/warehouse/file?path=outside-link',
  ])('refuses traversal, absolute and symlink-out reads: %s', async (url) => {
    const response = await call('GET', url);
    expect([400, 403]).toContain(response.status);
  });

  it('refuses an upload through a symlink whose canonical target is outside', async () => {
    const response = await call('POST', '/api/warehouse/file?path=outside-link&overwrite=true', Buffer.from('nope'));
    expect(response.status).toBe(403);
    await expect(fs.readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).resolves.toBe('outside\n');
  });
});
