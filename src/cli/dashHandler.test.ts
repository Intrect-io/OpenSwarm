import { describe, it, expect, vi } from 'vitest';
import { runDashCommand, type DashDeps, type DashChildProcessLike } from './dashHandler.js';

function fakeChild(): DashChildProcessLike & { emit(event: 'error' | 'close', arg?: unknown): void } {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  return {
    on(event: string, listener: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    emit(event, arg) {
      for (const l of listeners[event] ?? []) l(arg);
    },
  } as DashChildProcessLike & { emit(event: 'error' | 'close', arg?: unknown): void };
}

function baseDeps(overrides: Partial<DashDeps> = {}): { deps: DashDeps; signals: Record<string, () => void> } {
  const signals: Record<string, () => void> = {};
  const deps: DashDeps = {
    startWebServer: vi.fn(async () => {}),
    stopWebServer: vi.fn(async () => {}),
    spawnBrowser: vi.fn(() => fakeChild()),
    onSignal: (signal, handler) => { signals[signal] = handler; },
    log: vi.fn(),
    logError: vi.fn(),
    setExitCode: vi.fn(),
    ...overrides,
  };
  return { deps, signals };
}

describe('runDashCommand (AGT-3408)', () => {
  it('registers the same shutdown for SIGINT and SIGTERM, and it runs stopWebServer exactly once even if both fire', async () => {
    const { deps, signals } = baseDeps();
    await runDashCommand(3847, false, deps);

    expect(signals.SIGINT).toBeTypeOf('function');
    expect(signals.SIGTERM).toBeTypeOf('function');

    signals.SIGINT();
    signals.SIGTERM(); // a second signal while stopping must be a no-op
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.stopWebServer).toHaveBeenCalledTimes(1);
    expect(deps.setExitCode).toHaveBeenCalledWith(0);
  });

  it('SIGTERM alone runs the same cleanup as SIGINT', async () => {
    const { deps, signals } = baseDeps();
    await runDashCommand(3847, false, deps);

    signals.SIGTERM();
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.stopWebServer).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('\nDashboard stopped.');
  });

  it('logs the shutdown failure but still reports the server stopped', async () => {
    const { deps, signals } = baseDeps({ stopWebServer: vi.fn(async () => { throw new Error('boom'); }) });
    await runDashCommand(3847, false, deps);

    signals.SIGINT();
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.logError).toHaveBeenCalledWith('[Dashboard] graceful shutdown failed:', expect.any(Error));
    expect(deps.setExitCode).toHaveBeenCalledWith(0);
  });

  it('spawns the browser once with the dashboard URL when open is true', async () => {
    const { deps } = baseDeps();
    await runDashCommand(4000, true, deps);
    expect(deps.spawnBrowser).toHaveBeenCalledWith('http://localhost:4000');
  });

  it('does not spawn a browser when open is false', async () => {
    const { deps } = baseDeps();
    await runDashCommand(4000, false, deps);
    expect(deps.spawnBrowser).not.toHaveBeenCalled();
  });

  it('reports a fallback once when the browser launcher errors, and does not double-report on close', async () => {
    const child = fakeChild();
    const { deps } = baseDeps({ spawnBrowser: vi.fn(() => child) });
    await runDashCommand(4000, true, deps);

    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', 1);

    expect(deps.log).toHaveBeenCalledWith('Open http://localhost:4000 in your browser');
    expect(vi.mocked(deps.log).mock.calls.filter((c) => c[0].startsWith('Open ')).length).toBe(1);
  });

  it('reports a fallback when the launcher exits non-zero without an error event', async () => {
    const child = fakeChild();
    const { deps } = baseDeps({ spawnBrowser: vi.fn(() => child) });
    await runDashCommand(4000, true, deps);

    child.emit('close', 127);

    expect(deps.log).toHaveBeenCalledWith('Open http://localhost:4000 in your browser');
  });

  it('does not report a fallback when the launcher exits 0', async () => {
    const child = fakeChild();
    const { deps } = baseDeps({ spawnBrowser: vi.fn(() => child) });
    await runDashCommand(4000, true, deps);

    child.emit('close', 0);

    expect(vi.mocked(deps.log).mock.calls.some((c) => c[0].startsWith('Open '))).toBe(false);
  });
});
