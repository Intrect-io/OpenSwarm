// ============================================
// OpenSwarm - Host health: stop dispatching when the disk is nearly full (AGT-4785)
// ============================================
//
// On 2026-10-20 the host ran out of disk. Tester and worker stages failed with
// ENOSPC while copying git packs into `$TMPDIR/.openswarm-verify-head-*`, most of
// the night's runs ended `infra_error`, and the daemon kept dispatching: every
// new run failed the same way. Nothing in the tree measured free space —
// `errorClassification` only labels ENOSPC "an environment condition, back off
// and retry", which is right for one run and wrong for a whole queue.
//
// This is the measurement and the verdict. The runner reads it once per
// heartbeat, after the worktree sweep (which is what frees space) and before any
// task is fetched or claimed, so a full disk stops new work and never stops the
// cleanup that would end the condition.
//
// Reads fail OPEN: a path that cannot be measured is skipped, and with nothing
// measurable the verdict is `ok`. A health probe that cannot run must not stop
// a daemon that was working.

import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const GiB = 1024 ** 3;

/**
 * Free space below which dispatch pauses. Sized from the night it failed: one
 * verify head clone is about 1 GB (measured on cgf-portal), each worker
 * worktree about 0.5 GB, and verification runs on two slots next to up to eight
 * workers — several GB can be wanted at once, and the incident showed trouble
 * at 2 GB free.
 */
export const DEFAULT_MIN_FREE_BYTES = 10 * GiB;

export type DiskVerdict = 'ok' | 'low';

/** `low` strictly below the floor, `ok` at or above it. */
export function hostDiskVerdict(input: { freeBytes: number; minFreeBytes: number }): DiskVerdict {
  return input.freeBytes < input.minFreeBytes ? 'low' : 'ok';
}

/**
 * Bytes available to an unprivileged process on the volume holding `dir`
 * (`bavail`, not `bfree`: the root-reserved blocks are not ours to use).
 * Throws when the path cannot be measured; {@link lowestFreeBytes} handles that.
 */
export function freeBytesFor(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * The scarcest of several volumes, with the path that is scarcest. Paths that
 * cannot be measured are skipped; `undefined` when none can.
 */
export function lowestFreeBytes(dirs: readonly string[]): { dir: string; freeBytes: number } | undefined {
  let lowest: { dir: string; freeBytes: number } | undefined;
  for (const dir of new Set(dirs)) {
    try {
      const freeBytes = freeBytesFor(dir);
      if (!lowest || freeBytes < lowest.freeBytes) lowest = { dir, freeBytes };
    } catch {
      // Not measurable (missing, no permission): not evidence of a full disk.
    }
  }
  return lowest;
}

/** The directories the daemon writes under: each project's tree, the temp dir verification clones into, and its own state. */
export function dispatchWritePaths(projectPaths: readonly string[], extra: readonly string[] = []): string[] {
  return [...projectPaths, tmpdir(), ...extra];
}

/**
 * True for a failure that means the host may be out of a resource rather than
 * that the task was wrong: ENOSPC, by structured error code first, else by the
 * text git and node print. Deliberately narrow — "no space left for the label"
 * in prose must not match, and neither must a network failure. Text from worker
 * or test output is only a reason to re-measure (see
 * {@link HostDiskGate.resourceFailure}), never a verdict on its own.
 */
export function isHostResourceError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOSPC') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\bENOSPC\b|no space left on device/i.test(message);
}

export interface HostHealth {
  verdict: DiskVerdict;
  /** The scarcest measured volume, when any could be measured. */
  scarcest?: { dir: string; freeBytes: number };
  minFreeBytes: number;
}

/** Measure the volumes the daemon writes to and judge them against the floor. */
export function checkHostHealth(
  dirs: readonly string[],
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): HostHealth {
  const scarcest = lowestFreeBytes(dirs);
  if (!scarcest) return { verdict: 'ok', minFreeBytes };
  return { verdict: hostDiskVerdict({ freeBytes: scarcest.freeBytes, minFreeBytes }), scarcest, minFreeBytes };
}

/** `12.3 GiB`, for the one log line and the one alert. */
export function formatGiB(bytes: number): string {
  return `${(bytes / GiB).toFixed(1)} GiB`;
}

export type DispatchGateDecision =
  /** Disk is fine: carry on. */
  | { pause: false; notice?: string }
  /** Disk is low: skip this heartbeat's claims. `notice` is set only on the first low reading. */
  | { pause: true; line: string; notice?: string };

/**
 * One heartbeat's disk check, remembering the previous one so the operator hears
 * about a *change*, once, instead of every five minutes while the disk is full.
 * On 2026-10-20 the daemon produced a night of near-identical failures; a night
 * of near-identical alerts would be the same noise at a different address.
 */
export class HostDiskGate {
  private low = false;
  /** One "not confirmed" line per run of unconfirmed reports, not one per failing task. */
  private unconfirmedLogged = false;

  constructor(
    private readonly paths: () => readonly string[],
    private readonly minFreeBytes: () => number = () => DEFAULT_MIN_FREE_BYTES,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /**
   * A run reported a host-resource failure (ENOSPC, usually as text in worker or
   * test output). That is a reason to measure, not a verdict: one test that
   * prints "No space left on device" must not drain the whole factory. The free
   * space is measured right away and the gate pauses only when the measurement
   * is below the floor — exactly as {@link evaluate} would, so the low reading
   * then leads to the operator-lifted `auto:disk` factory pause like any other.
   * When the disk measures fine nothing pauses and one line says so.
   */
  resourceFailure(detail: string): DispatchGateDecision {
    const floor = this.minFreeBytes();
    if (floor > 0 && checkHostHealth(this.paths(), floor).verdict === 'low') {
      this.unconfirmedLogged = false;
      return this.evaluate(); // the low transition and its one notice
    }
    // Fine: leave the low/recovered state alone so the heartbeat still announces a recovery.
    if (!this.unconfirmedLogged) {
      this.unconfirmedLogged = true;
      this.log(`[HostHealth] ENOSPC report not confirmed by a free-space measurement; dispatch continues: ${detail}`);
    }
    return { pause: false };
  }

  /** Measure now and decide. A floor of zero or less switches the check off. */
  evaluate(): DispatchGateDecision {
    const floor = this.minFreeBytes();
    if (floor <= 0) {
      const recovered = this.low;
      this.low = false;
      return recovered ? { pause: false, notice: 'Disk-space check switched off; dispatch resumes.' } : { pause: false };
    }
    const health = checkHostHealth(this.paths(), floor);
    if (health.verdict === 'ok') {
      const recovered = this.low;
      this.low = false;
      if (!recovered) return { pause: false };
      const free = health.scarcest ? ` (${formatGiB(health.scarcest.freeBytes)} free on ${health.scarcest.dir})` : '';
      // The automatic `auto:disk` factory pause (AGT-4809) is not lifted here; an operator lifts it.
      return { pause: false, notice: `Disk space recovered${free}; the disk hold is lifted. An auto:disk factory pause stays until \`openswarm unpause\`.` };
    }
    const scarcest = health.scarcest!;
    const line = `${formatGiB(scarcest.freeBytes)} free on ${scarcest.dir}, below the ${formatGiB(floor)} floor`;
    const first = !this.low;
    this.low = true;
    return first
      ? { pause: true, line, notice: `Dispatch paused: ${line}. Worktree cleanup keeps running; new work waits until space is freed.` }
      : { pause: true, line };
  }
}
