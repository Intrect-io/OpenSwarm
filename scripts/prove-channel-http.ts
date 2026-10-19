/** Two independent Chromium contexts against actual channel routes and existing HTTP gates. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
const destination = process.argv[2]; assert(destination, 'Usage: <evidence.json>');
const root = mkdtempSync(join(tmpdir(), 'channel-http-')); const repo = join(root, 'validation-project'); mkdirSync(repo);
process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db'); process.env.OPENSWARM_COORDINATION_FILE = join(root, 'board.json');
const { syncChannels, readChannels } = await import('../src/coordination/channelStore.js');
const { channelDatabase } = await import('../src/coordination/channelSchema.js');
const { recordTraceEvent } = await import('../src/coordination/coordinationTrace.js');
const { tryHandleProjectRoutes } = await import('../src/coordination/projectRoutes.js');
const { readBody } = await import('../src/support/httpBody.js');
const { isAuthorizedMutation } = await import('../src/support/webAuth.js');
const channel = syncChannels([repo])[0];
for (let i = 0; i < 70; i++) recordTraceEvent({ id: `http-${i}`, seq: i + 1, timestamp: Date.now(), repository: repo, repoKey: channel.repoKey,
  taskId: 'task', actor: 'worker', actorRole: 'worker', kind: 'advice-response', status: 'completed', correlationId: `c-${i}`, summary: 'Read position fixture', fingerprint: `${i}` });
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!['GET','HEAD'].includes(req.method ?? '') && !isAuthorizedMutation(req)) { res.writeHead(403); res.end('{}'); return; }
  if (url.searchParams.has('loseResponse')) res.end = (() => { req.socket.destroy(); return res; }) as typeof res.end;
  try { if (!await tryHandleProjectRoutes(req, res, url.pathname, url, undefined, [repo], readBody)) { res.writeHead(404); res.end(); } }
  catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
const base = `${origin}/api/coordination/channels/${encodeURIComponent(channel.repoKey)}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const a = await browser.newContext(); const b = await browser.newContext(); const headers = { Origin: origin };
  const higher = await a.request.post(`${base}/read`, { headers, data: { throughSeq: 50 } }); assert.equal(higher.status(), 200);
  const lower = await b.request.post(`${base}/read`, { headers, data: { throughSeq: 10 } }); assert.equal((await lower.json()).readSeq, 50);
  const independent = await b.request.get(`${base}/read`); assert.deepEqual(await independent.json(), { readSeq: 50, unread: 20, latestSeq: 70 });
  const unauth = await a.request.post(`${base}/messages`, { headers: { Origin: 'https://untrusted.example' }, data: { body: 'must not save', idempotencyKey: 'evil' } }); assert.equal(unauth.status(), 403);
  const oversize = await a.request.post(`${base}/messages`, { headers, data: { body: 'x'.repeat(1_100_000), idempotencyKey: 'oversize' } }); assert.equal(oversize.status(), 413);
  const body = { body: 'Save once even if the response is lost.', idempotencyKey: 'lost-response' };
  let responseLost = false;
  try { await a.request.post(`${base}/messages?loseResponse=1`, { headers, data: body }); } catch { responseLost = true; }
  assert(responseLost);
  const receipt = await b.request.post(`${base}/messages`, { headers, data: body }); assert.equal(receipt.status(), 202);
  const saved = await receipt.json(); assert.equal(saved.delivery.status, 'queued');
  assert.deepEqual(channelDatabase().prepare(`SELECT COUNT(*) n FROM coordination_channel_deliveries`).get(), { n: 1 });
  const page = await a.request.get(`${base}/entries`); const records = await page.json(); assert.equal(records.items.length, 50); assert(records.nextCursor);
  const next = await b.request.get(`${base}/entries?cursor=${encodeURIComponent(records.nextCursor)}`); assert.equal((await next.json()).items.length, 21);
  const wrong = await a.request.post(`${base}/messages`, { headers, data: { body: 'wrong recipient', idempotencyKey: 'ended', taskId: 'ended', recipient: 'worker' } }); assert.equal(wrong.status(), 409);
  const evidence = { verifiedAt: new Date().toISOString(), root, readPosition: await independent.json(), unauthenticatedOrigin: unauth.status(),
    bodyLimit: oversize.status(), responseLost, receipt: saved.delivery, rows: readChannels()[0], pages: [50,21], endedRecipient: wrong.status(),
    boundary: 'Production channel route + auth/body reader on isolated loopback HTTP server, two independent Chromium contexts. No production daemon attached.' };
  writeFileSync(destination, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ verified: true, checks: 8, root }));
  await a.close(); await b.close();
} finally { await browser.close(); await new Promise<void>((r) => server.close(() => r())); }
