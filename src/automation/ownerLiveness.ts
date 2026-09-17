// Whether a run's recorded owner is still alive (AGT-4072)
//
// A run row names its owner as `<pid>-<uuid>`. Deciding from that whether the
// owner still runs is the reconciler's whole problem, and a pid answers it
// only inside one pid namespace: two containers bind-mounting the same state
// directory both run their daemon as pid 7, so "pid 7 is alive here" says
// nothing about a row written over there, and "pid 7 is *me* but the uuid is
// not mine" — the container-restart proof — fires on a LIVE peer instead of a
// dead prior generation. The row therefore carries the writer's pid space, and
// this module turns (owner, space, ours) into a verdict the reconciler can act
// on without a clock.

import { namespacesMatch } from '../support/processLiveness.js';

export type OwnerVerdict =
  /** The owner has provably exited; its lease may be reclaimed now. */
  | 'gone'
  /** The owner is running; leave the row alone. */
  | 'alive'
  /** The owner cannot be judged from here; only the age timer may reclaim it. */
  | 'unknown';

export interface OwnerLivenessInput {
  ownerInstanceId: string;
  /** The pid space the row was claimed in, as stored; absent on legacy rows. */
  ownerPidSpace: string | undefined;
  ourInstanceId: string;
  ourPidSpace: string | undefined;
  ourPid: number;
  processIsAlive: (pid: number) => boolean;
}

/** The pid embedded in an owner instance id, or `null` when it carries none. */
export function ownerProcessId(instanceId: string): number | null {
  const match = instanceId.match(/^(\d+)-/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Judge a row's owner.
 *
 * - **Proof-capable space (Linux: boot id + pid namespace)** that matches ours:
 *   the pid numbering is ours, so a pid probe is sound, and a row carrying our
 *   own pid under a different instance id was written by a process that has
 *   since exited — the container-restart case, decided without a timer.
 * - **Proof-capable space that differs from ours**: another container on the
 *   same ledger. Its pids mean nothing here — `unknown`, whatever the probe
 *   would say, so a live peer is never reclaimed.
 * - **Machine hint (non-Linux: `hint:<host>`)** that matches ours: not a proof
 *   (two hosts can share a name), but a probe within one host is as sound as
 *   it was before the column existed, so the pre-column rule is kept for it.
 *   A hint that differs is evidence the row came from elsewhere — `unknown`.
 * - **No recorded space** (legacy row, or a writer that could not name its
 *   space): `unknown`. Fail closed to the timer.
 */
export function ownerVerdict(input: OwnerLivenessInput): OwnerVerdict {
  const pid = ownerProcessId(input.ownerInstanceId);
  if (pid === null) return 'unknown';
  const { ownerPidSpace, ourPidSpace } = input;
  if (ownerPidSpace === undefined) return 'unknown';
  const sameSpace = namespacesMatch(ownerPidSpace, ourPidSpace);
  if (!sameSpace) return 'unknown';
  // Same space, whether proven (Linux) or hinted (same host name elsewhere).
  // A hint is not upgraded to a proof here: it merely restores the local probe
  // that every row got before the column existed.
  if (pid === input.ourPid) {
    return input.ownerInstanceId === input.ourInstanceId ? 'alive' : 'gone';
  }
  return input.processIsAlive(pid) ? 'alive' : 'gone';
}
