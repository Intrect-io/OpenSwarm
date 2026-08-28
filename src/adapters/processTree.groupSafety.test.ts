import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  signalCliProcessTree,
  terminateCliProcessTree,
  trackCliProcessTree,
  untrackCliProcessTree,
} from './processTree.js';

// What went wrong: unit tests handed fabricated pids (1, 321) to the close
// handler, which group-killed them via process.kill(-pid, SIGKILL). kill(-1)
// addresses every process the user may signal — it wiped the operator's whole
// login session twice and severed the SSH connection running the suite on a
// remote host. These tests pin the ownership proof that prevents it.

afterEach(() => vi.restoreAllMocks());

function proc(pid: number | undefined) {
  return { pid, kill: vi.fn(() => true) } as never;
}

describe('process-group signalling ownership proof', () => {
  it('never addresses pid 1 as a group, even if a lookup claims it leads one', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(1);
    signalCliProcessTree(target, 'SIGKILL', 'linux', () => ({ pgid: 1, ppid: process.pid }));
    expect(kill).not.toHaveBeenCalled();
    expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('never group-signals our own process', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const self = proc(process.pid);
    signalCliProcessTree(self, 'SIGTERM', 'linux', () => ({ pgid: process.pid, ppid: 1 }));
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses the group when the pid does not lead it', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(4242);
    // The OS says 4242 belongs to group 999: killing -4242 would address
    // whoever owns that number now, not our child.
    signalCliProcessTree(target, 'SIGKILL', 'linux', () => ({ pgid: 999, ppid: process.pid }));
    expect(kill).not.toHaveBeenCalled();
    expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('refuses a live group leader that is not our child', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(4248);
    // A fabricated pid can collide with a real, unrelated session leader.
    // Leading a group is not enough — the process must also be OUR child.
    signalCliProcessTree(target, 'SIGKILL', 'linux', () => ({ pgid: 4248, ppid: 1 }));
    expect(kill).not.toHaveBeenCalled();
    expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('refuses an exited pid that was never tracked as our detached leader', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(4243);
    signalCliProcessTree(target, 'SIGKILL', 'linux', () => null);
    expect(kill).not.toHaveBeenCalled();
    expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('group-kills a verified detached child', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    terminateCliProcessTree(proc(4244), 'linux', () => ({ pgid: 4244, ppid: process.pid }));
    expect(kill).toHaveBeenCalledWith(-4244, 'SIGKILL');
  });

  it('sweeps an exited leader\'s orphans individually, never by group signal', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(4246);
    // Track time: alive, leads its own group, our direct child.
    trackCliProcessTree(target, () => ({ pgid: 4246, ppid: process.pid }));
    try {
      // Kill time: the leader already exited (the OS has nothing to report),
      // but its orphaned descendants keep the group id reserved. They are
      // signalled one pid at a time; kill(-pgid) must never fire post-mortem.
      const listMembers = vi.fn()
        .mockReturnValueOnce([
          { pid: 6001, elapsedMs: 60_000 },
          { pid: 6002, elapsedMs: 45_000 },
        ])
        .mockReturnValue([]);
      signalCliProcessTree(target, 'SIGKILL', 'linux', () => null, listMembers);
      expect(kill).toHaveBeenCalledWith(6001, 'SIGKILL');
      expect(kill).toHaveBeenCalledWith(6002, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(-4246, 'SIGKILL');
      // Second enumeration catches descendants forked mid-sweep.
      expect(listMembers).toHaveBeenCalledTimes(2);
    } finally {
      untrackCliProcessTree(target);
    }
  });

  it('skips group members younger than the leader\'s death (recycled group id)', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exitListeners: Array<() => void> = [];
    const target = {
      pid: 4249,
      kill: vi.fn(() => true),
      once: (event: string, listener: () => void) => {
        if (event === 'exit') exitListeners.push(listener);
      },
    } as never;
    trackCliProcessTree(target, () => ({ pgid: 4249, ppid: process.pid }));
    try {
      for (const listener of exitListeners) listener();
      // The kill arrives 10s after the leader died. A member only 4s old was
      // born after that death: the group id was recycled — leak, never misfire.
      vi.setSystemTime(Date.now() + 10_000);
      signalCliProcessTree(target, 'SIGKILL', 'linux', () => null, () => [
        { pid: 6100, elapsedMs: 4_000 },
      ]);
      expect(kill).not.toHaveBeenCalled();
      expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      untrackCliProcessTree(target);
      vi.useRealTimers();
    }
  });

  it('still sweeps a member that predates the leader\'s death long after it', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exitListeners: Array<() => void> = [];
    const target = {
      pid: 4250,
      kill: vi.fn(() => true),
      once: (event: string, listener: () => void) => {
        if (event === 'exit') exitListeners.push(listener);
      },
    } as never;
    trackCliProcessTree(target, () => ({ pgid: 4250, ppid: process.pid }));
    try {
      for (const listener of exitListeners) listener();
      vi.setSystemTime(Date.now() + 10_000);
      const listMembers = vi.fn()
        .mockReturnValueOnce([{ pid: 6200, elapsedMs: 30_000 }])
        .mockReturnValue([]);
      signalCliProcessTree(target, 'SIGKILL', 'linux', () => null, listMembers);
      expect(kill).toHaveBeenCalledWith(6200, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(-4250, 'SIGKILL');
    } finally {
      untrackCliProcessTree(target);
      vi.useRealTimers();
    }
  });

  it('records no track-time ownership for a child that is not ours', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = proc(4247);
    trackCliProcessTree(target, () => ({ pgid: 4247, ppid: 999 }));
    try {
      signalCliProcessTree(target, 'SIGKILL', 'linux', () => null);
      expect(kill).not.toHaveBeenCalled();
      expect((target as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      untrackCliProcessTree(target);
    }
  });
});
