// `openswarm dash` serves the Supervisor with no runner attached. The heartbeat
// route used to answer 202 there, so the button waited for a start signal
// nothing could send. It now refuses with a reason the page can show.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { startWebServer, stopWebServer } from './web.js';

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

describe('POST /api/heartbeat without a runner', () => {
  afterEach(async () => { await stopWebServer(); });

  it('refuses with 503 and says why', async () => {
    const port = await freePort();
    await startWebServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No daemon runner is attached to this dashboard' });
  });
});
