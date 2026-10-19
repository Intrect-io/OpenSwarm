/** Isolated, read-only 3900 preview. No daemon modules, home state or providers. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../web/static');
const port = Number(process.argv[2] ?? 3900);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Read-only preview'); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/orchestration?demo=normal' }); res.end(); return; }
  let relative = ['/chat', '/orchestration'].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : url.pathname.startsWith('/static/') ? url.pathname.slice(8) : '';
  try { relative = decodeURIComponent(relative); } catch { res.writeHead(400); res.end(); return; }
  const path = resolve(root, relative);
  if (!relative || !path.startsWith(root + sep)) { res.writeHead(404); res.end('Preview supports /chat?demo=normal and /orchestration?demo=normal'); return; }
  try { const content = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : content); }
  catch { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Read-only demo preview: http://localhost:${port}/orchestration?demo=normal`));
