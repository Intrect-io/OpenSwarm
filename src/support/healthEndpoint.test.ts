import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildHealthPayload } from './healthEndpoint.js';

const lifecycle = vi.hoisted(() => ({
  pollers: [] as NodeJS.Timeout[],
}));

vi.mock('../adapters/processRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/processRegistry.js')>('../adapters/processRegistry.js');
  return { ...actual, startHealthChecker: vi.fn(), stopHealthChecker: vi.fn() };
});

vi.mock('./gitStatus.js', async () => {
  const actual = await vi.importActual<typeof import('./gitStatus.js')>('./gitStatus.js');
  return {
    ...actual,
    startGitStatusPoller: vi.fn(() => {
      const timer = setInterval(() => {}, 60_000);
      timer.unref();
      lifecycle.pollers.push(timer);
      return timer;
    }),
    stopGitStatusPoller: vi.fn(() => {
      const timer = lifecycle.pollers.pop();
      if (timer) clearInterval(timer);
    }),
  };
});

describe('buildHealthPayload', () => {
  it('reports the vega BackendHealth contract fields', () => {
    const payload = buildHealthPayload({
      env: {},
      pid: 42,
      ppid: 1,
      uptimeS: 12.9,
      version: '1.2.3',
      instanceId: 'fixed-id',
    });
    expect(payload).toEqual({
      status: 'ok',
      app: 'openswarm',
      backend_owner: 'source',
      backend_version: '1.2.3',
      backend_instance_id: 'fixed-id',
      backend_pid: 42,
      backend_parent_pid: 1,
      uptime_s: 12,
    });
  });

  it('detects a supervised (launchd/systemd) run as owner "service"', () => {
    expect(buildHealthPayload({ env: { XPC_SERVICE_NAME: 'com.intrect.openswarm' } }).backend_owner).toBe('service');
    expect(buildHealthPayload({ env: { INVOCATION_ID: 'abc' } }).backend_owner).toBe('service');
    // Interactive shells on newer macOS export XPC_SERVICE_NAME=0 — not a service.
    expect(buildHealthPayload({ env: { XPC_SERVICE_NAME: '0' } }).backend_owner).toBe('source');
  });

  it('honors an explicit OPENSWARM_BACKEND_OWNER override', () => {
    expect(buildHealthPayload({ env: { OPENSWARM_BACKEND_OWNER: 'source', XPC_SERVICE_NAME: 'x' } }).backend_owner).toBe('source');
    expect(buildHealthPayload({ env: { OPENSWARM_BACKEND_OWNER: 'service' } }).backend_owner).toBe('service');
  });

  it('keeps the instance id stable across calls within one process', () => {
    expect(buildHealthPayload().backend_instance_id).toBe(buildHealthPayload().backend_instance_id);
  });
});

describe('GET /api/health over the live server', () => {
  afterEach(async () => {
    const { stopWebServer } = await import('./web.js');
    await stopWebServer();
    for (const timer of lifecycle.pollers) clearInterval(timer);
    lifecycle.pollers.length = 0;
    vi.clearAllMocks();
  });

  it('answers without any auth token even when one is configured', async () => {
    const { startWebServer, stopWebServer, getWebServerPort } = await import('./web.js');
    process.env.OPENSWARM_WEB_TOKEN = 'secret-token';
    try {
      await startWebServer(0);
      const port = getWebServerPort();
      expect(port).toBeTypeOf('number');
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.app).toBe('openswarm');
      expect(typeof body.backend_pid).toBe('number');
      expect(typeof body.backend_version).toBe('string');
      expect(typeof body.backend_instance_id).toBe('string');

      // The rest of /api/* stays gated: same unauthenticated request pattern
      // must NOT leak through just because health was opened up.
      const gated = await fetch(`http://127.0.0.1:${port}/api/stats`, {
        headers: { origin: 'http://evil.example' },
      });
      expect(gated.status).toBe(403);
    } finally {
      delete process.env.OPENSWARM_WEB_TOKEN;
      await stopWebServer();
    }
  });

  it('serves the /app shell and /static assets, and blocks traversal (INT-3388)', async () => {
    const { startWebServer, stopWebServer, getWebServerPort } = await import('./web.js');
    try {
      await startWebServer(0);
      const port = getWebServerPort();

      const app = await fetch(`http://127.0.0.1:${port}/app`);
      expect(app.status).toBe(200);
      expect(app.headers.get('content-type')).toContain('text/html');
      expect(await app.text()).toContain('OpenSwarm');

      const css = await fetch(`http://127.0.0.1:${port}/static/css/tokens.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');

      // Traversal must never surface file content. Node's client rejects raw
      // ../ in the path, so exercise the encoded form end-to-end.
      const traversal = await fetch(`http://127.0.0.1:${port}/static/..%2f..%2fpackage.json`);
      expect([403, 404]).toContain(traversal.status);
      const leaked = await traversal.text();
      expect(leaked).not.toContain('"version"');
    } finally {
      await stopWebServer();
    }
  });

  it('answers malformed /api/work requests with 400, not 500 (review finding)', async () => {
    const { startWebServer, stopWebServer, getWebServerPort } = await import('./web.js');
    try {
      await startWebServer(0);
      const port = getWebServerPort();
      const base = `http://127.0.0.1:${port}`;

      const badJson = await fetch(`${base}/api/work`, { method: 'POST', body: '{not json' });
      expect(badJson.status).toBe(400);

      const missingPath = await fetch(`${base}/api/work`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: ['x'] }),
      });
      expect(missingPath.status).toBe(400);

      const badIds = await fetch(`${base}/api/work`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: '/tmp', issueIds: [42] }),
      });
      expect(badIds.status).toBe(400);

      // The picker source mirrors the dispatch boundary: no runner → empty
      // list, still a clean 200.
      const projects = await fetch(`${base}/api/work/projects`);
      expect(projects.status).toBe(200);
      expect(await projects.json()).toEqual([]);
    } finally {
      await stopWebServer();
    }
  });

  it('collapses tilde/absolute spellings of one repo in /api/work/projects (INT-3395)', async () => {
    const { tryHandleAppRoutes } = await import('./webAppRoutes.js');
    const { homedir } = await import('node:os');

    // repos.json persists both spellings so the denylist matches either; the
    // picker must not show the same repo twice.
    const runner = {
      getAllowedProjects: () => [
        '~/dev/de-artifact',
        '~/dev/kyte-portal',
        `${homedir()}/dev/kyte-portal`,
        `${homedir()}/dev/de-artifact`,
      ],
    } as unknown as Parameters<typeof tryHandleAppRoutes>[4];

    let status = 0;
    let payload = '';
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (body: string) => { payload = body; },
    } as unknown as ServerResponse;

    const handled = await tryHandleAppRoutes(
      { method: 'GET', headers: {} } as IncomingMessage,
      res,
      '/api/work/projects',
      new URL('http://127.0.0.1/api/work/projects'),
      runner,
      async () => '',
    );

    expect(handled).toBe(true);
    expect(status).toBe(200);
    // First spelling wins; each repo appears exactly once.
    expect(JSON.parse(payload)).toEqual([
      { path: '~/dev/de-artifact', name: 'de-artifact' },
      { path: '~/dev/kyte-portal', name: 'kyte-portal' },
    ]);
  });
});
