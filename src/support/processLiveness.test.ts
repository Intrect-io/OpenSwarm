import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import {
  PROCESS_STARTED_AT_MS,
  processAppearsAlive,
  processNamespaceId,
  namespacesMatch,
  resolveNamespaceId,
  sameProcessNamespace,
  writerProvablyGone,
} from './processLiveness.js';

afterEach(() => { vi.restoreAllMocks(); });

// Every caller turns a "dead" answer into reclaiming something — a lock, a
// worktree — so each way of being wrong here takes a resource away from a live
// owner. These pin the fail-closed direction; a blanket `catch { return false }`
// passes none of them. (AGT-4068, caught by the commit gate)
describe('processAppearsAlive', () => {
  it('reads a pid it cannot judge as alive, without signalling anything', () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(processAppearsAlive(pid)).toBe(true);
    }
    // pid 0 means "this process's whole group" to kill(2) — asking the question
    // must never be the thing that signals it.
    expect(kill).not.toHaveBeenCalled();
  });

  it('treats a process owned by someone else (EPERM) as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(processAppearsAlive(4242)).toBe(true);
  });

  it('treats a probe that merely failed as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
    });
    expect(processAppearsAlive(4242)).toBe(true);
  });

  it('reports dead only for ESRCH — no such process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(processAppearsAlive(4242)).toBe(false);
  });

  it('says the running test process is alive', () => {
    expect(processAppearsAlive(process.pid)).toBe(true);
  });
});

describe('writerProvablyGone', () => {
  it('proves death for our own pid recorded before we started', () => {
    expect(writerProvablyGone({ pid: process.pid, writtenAtMs: PROCESS_STARTED_AT_MS - 60_000 })).toBe(true);
  });

  it('claims nothing about a pid that is not ours, however old the record', () => {
    // A different live process legitimately owns its own records — including a
    // concurrent OpenSwarm CLI or a second daemon.
    expect(writerProvablyGone({ pid: process.pid + 1, writtenAtMs: 0 })).toBe(false);
  });

  it('claims nothing about a record we could have written ourselves', () => {
    expect(writerProvablyGone({ pid: process.pid, writtenAtMs: Date.now() })).toBe(false);
  });

  it('claims nothing when the timestamp is unreadable', () => {
    expect(writerProvablyGone({ pid: process.pid, writtenAtMs: Number.NaN })).toBe(false);
  });
});

describe('processNamespaceId / sameProcessNamespace', () => {
  it('is stable, and identifies this machine when it can be resolved at all', () => {
    expect(processNamespaceId()).toBe(processNamespaceId());
    const id = processNamespaceId();
    // undefined only on Linux with an unreadable /proc/self/ns/pid.
    if (id !== undefined) expect(id).toContain(hostname());
  });

  it('matches only a record written in this same pid space', () => {
    const mine = processNamespaceId();
    if (mine !== undefined) expect(sameProcessNamespace(mine)).toBe(true);
    expect(sameProcessNamespace('some-other-host:pid:[4026531999]')).toBe(false);
  });

  it('never matches an unknown namespace — on either side', () => {
    // Two processes that both cannot identify their pid space are not thereby
    // in the same one. A bare `===` would call undefined === undefined a match
    // and license reclaiming a live owner's lock on no evidence.
    expect(sameProcessNamespace(undefined)).toBe(false);
    expect(namespacesMatch(undefined, undefined)).toBe(false);
    expect(namespacesMatch('ns-a', undefined)).toBe(false);
    expect(namespacesMatch(undefined, 'ns-a')).toBe(false);
    expect(namespacesMatch('ns-a', 'ns-a')).toBe(true);
    expect(namespacesMatch('ns-a', 'ns-b')).toBe(false);
  });

  // Both branches below are unreachable on macOS, so they are exercised through
  // the pure resolver rather than the platform. Without this, a mutation that
  // collapses an unreadable Linux namespace to a shared host-wide default
  // passes the whole suite. (AGT-4068)
  it('reports an unreadable Linux pid namespace as unknown, not as a shared default', () => {
    const id = resolveNamespaceId('linux', () => { throw new Error('EACCES /proc/self/ns/pid'); });
    expect(id).toBeUndefined();
  });

  it('identifies a readable Linux pid namespace by host and namespace together', () => {
    const id = resolveNamespaceId('linux', () => 'pid:[4026531836]');
    expect(id).toBe(`${hostname()}:pid:[4026531836]`);
  });

  it('uses the host name alone where the platform has no pid namespaces', () => {
    const read = vi.fn(() => 'pid:[4026531836]');
    expect(resolveNamespaceId('darwin', read)).toBe(hostname());
    expect(read).not.toHaveBeenCalled();
  });
});
