// The Supervisor is a static page now, so the provider toggle is built in the
// browser from GET /api/providers instead of being injected server-side. The
// list must still be the live registry, or a button could POST a provider that
// isKnownAdapter rejects (INT-3284).
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { startWebServer, stopWebServer } from './web.js';
import { listAdapterNames } from '../adapters/index.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('GET /api/providers', () => {
  afterEach(async () => { await stopWebServer(); });

  it('lists every registered adapter', async () => {
    const port = await freePort();
    await startWebServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: string[] };
    expect(body.providers).toEqual(listAdapterNames());
    expect(body.providers.length).toBeGreaterThan(2);
  });
});
