import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';

const readMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());

vi.mock('./reasoningEffortOverride.js', () => ({
  readReasoningEffortOverride: readMock,
  writeReasoningEffortOverride: writeMock,
}));

import { setWebRunner, startWebServer, stopWebServer } from './web.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

describe('/api/reasoning-effort', () => {
  beforeEach(() => {
    readMock.mockReset();
    writeMock.mockReset();
    setWebRunner(undefined);
  });

  afterEach(async () => {
    await stopWebServer();
    setWebRunner(undefined);
  });

  it('reads and persists the fleet-wide override', async () => {
    readMock.mockReturnValue('medium');
    const port = await freePort();
    await startWebServer(port);

    const current = await fetch(`http://127.0.0.1:${port}/api/reasoning-effort`);
    expect(await current.json()).toEqual({ effort: 'medium' });

    const update = await fetch(`http://127.0.0.1:${port}/api/reasoning-effort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ ok: true, effort: 'high' });
    expect(writeMock).toHaveBeenCalledWith('high');
  });

  it('rejects unsupported effort values', async () => {
    const port = await freePort();
    await startWebServer(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/reasoning-effort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'max' }),
    });
    expect(response.status).toBe(400);
    expect(writeMock).not.toHaveBeenCalled();
  });
});
