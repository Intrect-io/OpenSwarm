import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearProgressSource, IdleBackoff, registerProgressSource } from '../automation/idleBackoff.js';
import { useTestDaemonToken } from './daemonToken.testing.js';

useTestDaemonToken();
const lifecycle = vi.hoisted(() => ({ pollers: [] as NodeJS.Timeout[] }));

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

describe('GET /api/health progress clock (AGT-4607)', () => {
  afterEach(async () => {
    const { stopWebServer } = await import('./web.js');
    await stopWebServer();
    for (const timer of lifecycle.pollers) clearInterval(timer);
    lifecycle.pollers.length = 0;
    clearProgressSource();
    vi.clearAllMocks();
  });

  it('reports the age of the last progress in the health response', async () => {
    let clock = Date.parse('2026-11-21T00:00:00.000Z');
    const idle = new IdleBackoff({ now: () => clock, log: () => {} });
    idle.beginHeartbeat();
    idle.markProgress();
    clock += 90 * 60_000; // 90 min since the last task was selected
    idle.beginHeartbeat();
    clock += 60_000;
    registerProgressSource(idle, () => true);

    const { startWebServer, getWebServerPort } = await import('./web.js');
    await startWebServer(0);
    const res = await fetch(`http://127.0.0.1:${getWebServerPort()}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.progress).toEqual({
      active: true,
      lastProgressAt: '2026-11-21T00:00:00.000Z',
      lastProgressAgeMs: 91 * 60_000,
      lastHeartbeatAt: '2026-11-21T01:30:00.000Z',
      lastHeartbeatAgeMs: 60_000,
      consecutiveEmptySelections: 0,
      heartbeatIntervalMultiplier: 1,
    });
  });
});
