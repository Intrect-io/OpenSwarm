import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';

const writeProviderOverrideMock = vi.hoisted(() => vi.fn());

vi.mock('../core/providerOverride.js', () => ({
  readProviderOverride: vi.fn(),
  writeProviderOverride: writeProviderOverrideMock,
  formatProviderOverrideMismatchWarning: vi.fn(),
}));

import { setWebRunner, startWebServer, stopWebServer } from './web.js';

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

describe('POST /api/provider persistence (INT-3284)', () => {
  beforeEach(() => {
    writeProviderOverrideMock.mockReset();
    setWebRunner(undefined);
  });

  afterEach(async () => {
    await stopWebServer();
    setWebRunner(undefined);
  });

  it('writes provider-override even when no autonomous runner is attached', async () => {
    const port = await freePort();
    await startWebServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; provider: string };
    expect(body).toEqual({ ok: true, provider: 'openrouter' });
    expect(writeProviderOverrideMock).toHaveBeenCalledWith('openrouter');
  });

  it('still writes override when a runner is attached (idempotent with switchProvider)', async () => {
    const runner = {
      switchProvider: vi.fn(),
      providerSwitchViolation: vi.fn(() => null),
      getEnabledProjects: vi.fn(() => []),
      getAllowedProjects: vi.fn(() => []),
      enableProject: vi.fn(),
      disableProject: vi.fn(),
      updateAllowedProjects: vi.fn(),
      registerProjectPath: vi.fn(),
    } as unknown as AutonomousRunner;
    setWebRunner(runner);

    const port = await freePort();
    await startWebServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gpt' }),
    });
    expect(res.status).toBe(200);
    expect(runner.switchProvider).toHaveBeenCalledWith('gpt');
    expect(writeProviderOverrideMock).toHaveBeenCalledWith('gpt');
  });

  it('refuses a switch the runner refuses (a delegated CLI the operator did not opt in to), and persists nothing (AGT-4444)', async () => {
    // One click on the dashboard used to undo the startup refusal: the toggle only checked isKnownAdapter.
    const runner = {
      switchProvider: vi.fn(),
      providerSwitchViolation: vi.fn(() => "'claude' delegates the tool loop to its own CLI"),
      getEnabledProjects: vi.fn(() => []),
      getAllowedProjects: vi.fn(() => []),
      enableProject: vi.fn(),
      disableProject: vi.fn(),
      updateAllowedProjects: vi.fn(),
      registerProjectPath: vi.fn(),
    } as unknown as AutonomousRunner;
    setWebRunner(runner);

    const port = await freePort();
    await startWebServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('allowDelegatedAdapters: true');
    expect(runner.switchProvider).not.toHaveBeenCalled();
    expect(writeProviderOverrideMock).not.toHaveBeenCalled();
  });
});
