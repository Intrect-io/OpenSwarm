import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
const tree = vi.hoisted(() => ({ signal: vi.fn(), terminate: vi.fn() }));
vi.mock('./processTree.js', () => ({
  signalCliProcessTree: tree.signal,
  terminateCliProcessTree: tree.terminate,
}));

const { killProcess, registerProcess } = await import('./processRegistry.js');

function fakeChild(pid: number): EventEmitter & { pid: number } {
  const proc = new EventEmitter() as EventEmitter & { pid: number; stdout: null; stderr: null };
  proc.pid = pid;
  proc.stdout = null;
  proc.stderr = null;
  return proc;
}

function register(pid: number): EventEmitter & { pid: number } {
  const proc = fakeChild(pid);
  registerProcess(
    { pid, adapter: 'codex', role: 'worker', command: 'codex', spawnedAt: Date.now() } as never,
    proc as never,
  );
  return proc;
}

describe('killProcess process ownership', () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    tree.signal.mockReset();
    tree.terminate.mockReset();
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    kill.mockRestore();
  });

  it('terminates through the retained handle, never by raw PID', async () => {
    register(700001);
    await expect(killProcess(700001)).resolves.toBe(true);
    expect(tree.signal).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6000);
    expect(tree.terminate).toHaveBeenCalledTimes(1);
    // The escalation still addresses the handle, so a PID recycled in those 5
    // seconds is never signalled.
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses to signal once the child has closed and released its PID', async () => {
    const proc = register(700002);
    proc.emit('close', 0, null);

    // Close clears the registration, so a later kill finds nothing to own.
    await expect(killProcess(700002)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(tree.signal).not.toHaveBeenCalled();
    expect(tree.terminate).not.toHaveBeenCalled();
  });

  it('force-kills through the handle', async () => {
    register(700003);
    await expect(killProcess(700003, true)).resolves.toBe(true);
    expect(tree.terminate).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });
});
