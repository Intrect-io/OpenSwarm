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
  /**
   * Disk is low, or a reported host-resource failure holds dispatch for a while
   * (`hold`): skip this heartbeat's claims. `notice` is set only on the first reading.
   * Only a measured low (no `hold`) becomes the operator-lifted `auto:disk` factory pause.
   */
  | { pause: true; line: string; notice?: string; hold?: true };

/** How long an ENOSPC report the free-space measurement did not confirm holds dispatch. */
export const DEFAULT_RESOURCE_FAILURE_HOLD_MS = 15 * 60_000;

/**
 * One heartbeat's disk check, remembering the previous one so the operator hears
 * about a *change*, once, instead of every five minutes while the disk is full.
 * On 2026-10-20 the daemon produced a night of near-identical failures; a night
 * of near-identical alerts would be the same noise at a different address.
 */
export class HostDiskGate {
  private low = false;
  /** An unconfirmed ENOSPC report holds dispatch until this time; 0 = no hold. */
  private heldUntil = 0;
  private holdLine = '';

  constructor(
    private readonly paths: () => readonly string[],
    private readonly minFreeBytes: () => number = () => DEFAULT_MIN_FREE_BYTES,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly options: { now?: () => number; holdMs?: number } = {},
  ) {}

  private now(): number { return (this.options.now ?? Date.now)(); }

  /**
   * A run reported a host-resource failure (ENOSPC, usually as text in worker or
   * test output). The free space is measured right away: below the floor it is
   * the ordinary low reading, which leads to the operator-lifted `auto:disk`
   * factory pause. When the disk measures fine the report may still be true for
   * a volume the gate does not measure (a tmpfs, a container overlay), so
   * dispatch is held for a while (AGT-4785) — but only held: the hold expires on
   * its own and never becomes a factory pause, so one test that prints "No space
   * left on device" cannot drain the factory until an operator steps in.
   */
  resourceFailure(detail: string): DispatchGateDecision {
    const floor = this.minFreeBytes();
    if (floor > 0 && checkHostHealth(this.paths(), floor).verdict === 'low') return this.evaluate();
    const line = `Host resource failure: ${detail}`;
    if (this.heldUntil > this.now()) return { pause: true, hold: true, line: this.holdLine };
    const holdMs = this.options.holdMs ?? DEFAULT_RESOURCE_FAILURE_HOLD_MS;
    this.heldUntil = this.now() + holdMs;
    this.holdLine = line;
    this.log(`[HostHealth] ENOSPC report not confirmed by a free-space measurement; holding dispatch for ${Math.round(holdMs / 60_000)} min: ${detail}`);
    return { pause: true, hold: true, line, notice: `Dispatch paused for ${Math.round(holdMs / 60_000)} min after a host resource failure the free-space check did not confirm: ${detail}` };
  }

  /** The unconfirmed-report hold, while it lasts; a one-time recovery notice once it expires. */
  private holdDecision(): DispatchGateDecision | undefined {
    if (this.heldUntil === 0) return undefined;
    if (this.heldUntil > this.now()) return { pause: true, hold: true, line: this.holdLine };
    this.heldUntil = 0;
    return { pause: false, notice: 'Host resource hold expired; dispatch recovered.' };
  }

  /**
   * Measure now without touching the remembered state, so a caller freeing space
   * (AGT-4816) can re-check between steps without spending the one recovery notice
   * {@link evaluate} gives. False when the check is switched off or nothing is measurable.
   */
  belowFloor(): boolean {
    const floor = this.minFreeBytes();
    return floor > 0 && checkHostHealth(this.paths(), floor).verdict === 'low';
  }

  /** Measure now and decide. A floor of zero or less switches the check off. */
  evaluate(): DispatchGateDecision {
    const floor = this.minFreeBytes();
    if (floor <= 0) {
      const recovered = this.low;
      this.low = false;
      return recovered ? { pause: false, notice: 'Disk-space check switched off; dispatch resumes.' } : (this.holdDecision() ?? { pause: false });
    }
    const health = checkHostHealth(this.paths(), floor);
    if (health.verdict === 'ok') {
      const recovered = this.low;
      this.low = false;
      if (!recovered) return this.holdDecision() ?? { pause: false };
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
