// ============================================
// OpenSwarm - Deciding whether a recorded process is still running (AGT-4068)
// ============================================
//
// Locks, leases and ownership markers all record a pid and later ask "is that
// process still there". `kill(pid, 0)` cannot answer it in a container, where
// pids are handed out deterministically: a restarted daemon is routinely given
// the very pid its predecessor had, so every record the dead generation left
// behind reads as live against the new one.
//
// The workaround each call site reached for independently was an age cutoff —
// wait long enough and give up on the owner. That is not evidence, it is a
// timer, and it costs exactly as long as it is set to: the task-state lock
// stalled every heartbeat for ten minutes after a restart, and an active
// worktree marker held an admission slot for twenty-four hours (AGT-4023,
// AGT-4053, AGT-4067). This module holds the proof those sites should share
// instead, so the next one does not have to rediscover it.

/** Epoch ms at which THIS process started. `process.uptime()` counts from
 * process start, so sampling it at module load is both cheap and accurate. */
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';

export const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

/** Slack for clock resolution when comparing a record's timestamp to our own
 * start. Erring towards "still theirs" only costs a fallback to the age rule. */
const PROCESS_START_JITTER_MS = 1_000;

/**
 * An id for the pid space this process lives in — the scope within which a pid
 * is unique.
 *
 * Two containers sharing a mounted state directory each have their own pid 1,
 * so a record written by one and read by the other cannot be reasoned about by
 * pid at all. A caller whose state may be shared that way must compare this
 * against the id recorded with the record before trusting `writerProvablyGone`.
 *
 * Host name plus pid-namespace inode, because neither alone is enough: two
 * containers on one host share a host name but not a namespace, while two
 * hosts can hand out the same inode number. Platforms without pid namespaces
 * (macOS, Windows) have exactly one pid space per machine, so the host name
 * alone is the honest answer there — not a missing one.
 */
/**
 * The pid-space id for a given platform, or undefined when it cannot be known.
 *
 * Split out as a pure function because both of its interesting branches are
 * unreachable on a developer's macOS: a mutation to either passed the suite
 * until this existed, which means it was not covered at all.
 *
 * Where pid namespaces exist, an unreadable one is UNKNOWN and never a shared
 * default. Collapsing it to a host-wide value would make two containers that
 * cannot read /proc — and were handed the same host name — compare equal, and
 * that is the one answer that must never be guessed.
 * (Caught by the commit-gate review.)
 */
export function resolveNamespaceId(platform: string, readNamespaceLink: () => string): string | undefined {
  if (platform !== 'linux') {
    // No pid namespaces on this platform: one pid space per machine, so the
    // host name is a complete identification rather than a fallback.
    return hostname();
  }
  try {
    return `${hostname()}:${readNamespaceLink()}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether two pid-space ids denote the same space.
 *
 * Never true when either side is unknown — including when BOTH are, which a
 * bare `===` would call a match and thereby license reclaiming a live owner's
 * resource on no evidence at all.
 */
export function namespacesMatch(recorded: string | undefined, mine: string | undefined): boolean {
  return mine !== undefined && recorded !== undefined && recorded === mine;
}

let namespaceId: string | undefined | null = null; // null = not resolved yet
export function processNamespaceId(): string | undefined {
  if (namespaceId === null) {
    namespaceId = resolveNamespaceId(process.platform, () => readlinkSync('/proc/self/ns/pid'));
  }
  return namespaceId;
}

/** Whether a record written with `recorded` came from this process's pid space. */
export function sameProcessNamespace(recorded: string | undefined): boolean {
  return namespacesMatch(recorded, processNamespaceId());
}

/**
 * Whether a pid currently belongs to some running process. Says nothing about
 * WHICH process — see `writerProvablyGone` for that.
 *
 * Fail-closed in both directions a naive probe gets wrong, because every caller
 * uses a "dead" answer to reclaim something an owner may still be holding:
 *
 *  - A pid that is not a usable positive integer reads as ALIVE. It cannot be
 *    judged, and `process.kill(0, 0)` would signal this process's whole group
 *    rather than answer the question.
 *  - Only `ESRCH` — "no such process" — counts as dead. `EPERM` means the
 *    process is there and owned by someone else, which is very much alive, and
 *    any other errno is a probe that failed rather than a process that is gone.
 */
export function processAppearsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether the process that wrote a record is *provably* gone.
 *
 * A pid is unique among live processes, so a record carrying this process's own
 * pid was written either by this process or by one that has since exited. If it
 * predates our start it cannot be ours, which settles it however alive the pid
 * table claims that pid to be. That is exactly the container-restart shape, and
 * it needs nothing written into the record beyond a pid and a timestamp — so it
 * also reaches records already on disk.
 *
 * Deliberately narrow: it returns false for any pid that is not ours, because a
 * *different* live process legitimately owns its own records. Concurrent
 * OpenSwarm processes — `openswarm attach`, a manual `openswarm run`, a second
 * daemon — must keep their locks and worktrees.
 */
export function writerProvablyGone(record: { pid: number; writtenAtMs: number }): boolean {
  if (record.pid !== process.pid) return false;
  if (!Number.isFinite(record.writtenAtMs)) return false; // unreadable — never claim proof
  return record.writtenAtMs < PROCESS_STARTED_AT_MS - PROCESS_START_JITTER_MS;
}
