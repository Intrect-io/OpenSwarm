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
import { readFileSync, readlinkSync } from 'node:fs';
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
 * Split out as a pure function because its interesting branches are unreachable
 * on a developer's macOS: mutations to them passed the whole suite until this
 * existed, which means they were not covered at all.
 *
 * On Linux the id is the kernel's **boot id** plus the pid-namespace inode.
 * Both halves are load-bearing and neither is enough alone:
 *
 *  - The inode separates two containers on one host, but is a per-boot counter,
 *    so two hosts hand out the same numbers routinely.
 *  - The boot id separates hosts (and reboots), and containers share their
 *    host's, so it cannot separate containers by itself.
 *
 * The host name is deliberately NOT used: this container reports `localhost`,
 * so two deployments sharing a state directory over a network filesystem would
 * have matched on it and reclaimed each other's live locks and worktrees.
 * (Caught by the fresh PR review.)
 *
 * A source that cannot be read makes the id UNKNOWN, never a shared default —
 * collapsing it would make every process that cannot read /proc compare equal,
 * which is the one answer that must never be guessed. After a host reboot the
 * boot id changes, so records written before it read as unjudgeable and fall
 * back to the age rules; everything they described is dead by then anyway.
 */
/** A pid space this process can actually reason about pids in. */
const PROOF_PREFIX = 'pidns:';
/** A machine hint: good enough to rule a record OUT, never to rule one IN. */
const HINT_PREFIX = 'host:';

/**
 * Whether an id names a real pid space, or is only a machine hint.
 *
 * Only a real pid space licenses `writerProvablyGone`: "this pid is mine, so
 * its writer has exited" needs the pid numbering to be the same numbering, and
 * a host name does not establish that.
 */
export function isProofCapableSpace(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PROOF_PREFIX);
}

export function resolveNamespaceId(
  platform: string,
  readNamespaceLink: () => string,
  readBootId: () => string,
): string | undefined {
  if (platform !== 'linux') {
    // A machine HINT, not a pid-space proof — and the prefix says which.
    //
    // The host name is asymmetric evidence, exactly like an owner id. A
    // *mismatch* is a sound signal that the record came from somewhere else, so
    // it is enough to withhold the local pid probe and protect a live remote
    // owner in the ordinary distinct-host case. A *match* proves nothing: two
    // machines sharing a state directory can carry the same host name, and this
    // project's own container reports `localhost`. So it never licenses the
    // proof — `isProofCapableSpace` gates that on a real pid namespace.
    //
    // A MAC was tried instead and is worse: this developer's Mac reports
    // `7a:83:be:1b:ed:d5`, whose locally-administered bit is set because macOS
    // randomises Wi-Fi addresses per network, and Docker and VPN adapters are
    // software-assigned too. Closing the same-host-name case honestly needs an
    // OS identity call (AGT-4069). (Caught by the fresh PR review, three times
    // — the first two rejected the host name as a proof, which it is not used
    // as here.)
    return `${HINT_PREFIX}${hostname()}`;
  }
  try {
    return `${PROOF_PREFIX}${readBootId().trim()}:${readNamespaceLink()}`;
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
    namespaceId = resolveNamespaceId(
      process.platform,
      () => readlinkSync('/proc/self/ns/pid'),
      () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
    );
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
 * pid was written either by this process or by one that has since exited.
 * Deciding which is what the two signals below are for, and either suffices:
 *
 *  - **`ownerId`** — an id minted per process. Ours means the record is ours and
 *    live; anything else, *given that the pid is ours*, means a process that has
 *    exited. Note the pid conjunct is doing the work: a differing id alone
 *    proves nothing, because a live sibling process also differs (AGT-4067).
 *    Clock-free, so nothing below can undermine it.
 *  - **`writtenAtMs`** — the fallback for records carrying no owner id. A record
 *    older than our own start cannot be ours.
 *
 * The timestamp path needs a margin and the margin is the reason `ownerId`
 * exists. It has to absorb an imprecise timestamp — for a lock file that is the
 * **mtime**, and on a filesystem with one-second granularity a lock we wrote at
 * `…13.900` reports `…13.000`, before our own start of `…13.231`, so without a
 * margin we would reclaim our own live lock. But a container recreate takes
 * about half a second, which is *inside* any margin large enough for that, so
 * the timestamp path cannot decide the very case this exists for. Measured on
 * vela: lock written 17:12:12.670, successor started 17:12:13.231, gap 0.561 s
 * against a 1 s margin. (AGT-4071)
 *
 * Deliberately narrow in both paths: false for any pid that is not ours, because
 * a *different* live process legitimately owns its own records. Concurrent
 * OpenSwarm processes — `openswarm attach`, a manual `openswarm run`, a second
 * daemon — must keep their locks and worktrees.
 */
export function writerProvablyGone(record: {
  pid: number;
  writtenAtMs?: number;
  ownerId?: string;
  ourOwnerId?: string;
}): boolean {
  if (record.pid !== process.pid) return false;
  if (record.ownerId !== undefined && record.ourOwnerId !== undefined) {
    return record.ownerId !== record.ourOwnerId;
  }
  if (record.writtenAtMs === undefined || !Number.isFinite(record.writtenAtMs)) return false;
  return record.writtenAtMs < PROCESS_STARTED_AT_MS - PROCESS_START_JITTER_MS;
}
