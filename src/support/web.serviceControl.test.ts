// AGT-3408: the /api/service/* routes shell out to `systemctl` with no bound
// on how long it may run. A wedged user service manager left the HTTP request
// open indefinitely; these routes now pass a `timeout` and turn a timeout
// into the same controlled error response as any other systemctl failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';

type ExecFileCb = (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

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

/** Simulate a timed-out child_process.execFile callback (what Node passes on timeout). */
function stubTimeout(): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecFileCb;
    const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    cb(err, '', '');
    return {};
  }) as unknown as typeof import('node:child_process').execFile);
}

function stubSuccess(stdout: string): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecFileCb;
    cb(null, stdout, '');
    return {};
  }) as unknown as typeof import('node:child_process').execFile);
}

describe('/api/service/* systemctl bounds (AGT-3408)', () => {
  afterEach(async () => {
    await stopWebServer();
    execFileMock.mockReset();
  });

  it('passes a timeout option to every systemctl invocation', async () => {
    stubSuccess('active');
    const port = await freePort();
    await startWebServer(port);

    await fetch(`http://127.0.0.1:${port}/api/service/status`);
    await fetch(`http://127.0.0.1:${port}/api/service/stop`, { method: 'POST' });
    await fetch(`http://127.0.0.1:${port}/api/service/restart`, { method: 'POST' });

    expect(execFileMock).toHaveBeenCalledTimes(3);
    for (const call of execFileMock.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect(opts.timeout).toBeTypeOf('number');
      expect(opts.timeout).toBeGreaterThan(0);
    }
  });

  it('status reports "unknown" instead of hanging when systemctl times out', async () => {
    stubTimeout();
    const port = await freePort();
    await startWebServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/service/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unknown' });
  });

  it('stop returns a controlled 500 instead of hanging when systemctl times out', async () => {
    stubTimeout();
    const port = await freePort();
    await startWebServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/service/stop`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('restart returns a controlled 500 instead of hanging when systemctl times out', async () => {
    stubTimeout();
    const port = await freePort();
    await startWebServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/service/restart`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
