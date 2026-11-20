/**
 * Cold-start dispatch ramp (AGT-4799).
 *
 * On 2026-10-20 the daemon restarted after two weeks idle; its first heartbeat
 * fetched 990 tasks against 8 free slots and filled every slot at once. This
 * caps how many new claims each heartbeat may make while the daemon warms up.
 *
 * Heartbeats can fire back-to-back (startup triggerNow, the setTimeout(0)
 * re-fire after a task wraps up, the dashboard button), so counting passes
 * alone would lift the cap within seconds. The ramp therefore stays on until
 * BOTH enough heartbeats have actually claimed work AND one heartbeat interval
 * has passed since the ramp started. A pass that claims nothing does not use
 * up the ramp.
 */
import { Cron } from 'croner';

export const DEFAULT_RAMP_CLAIMS = 2;
export const DEFAULT_RAMP_HEARTBEATS = 2;
/** Time floor when the heartbeat interval cannot be derived from the schedule. */
export const DEFAULT_RAMP_INTERVAL_MS = 15 * 60_000;

export interface DispatchRampOptions {
  claimsPerHeartbeat?: number;
  rampHeartbeats?: number;
  /** Minimum time the ramp stays on, normally one heartbeat interval. */
  intervalMs?: number;
  now?: () => number;
}

/** Limits new claims while a daemon warms up after startup. */
export class DispatchRamp {
  private claimingHeartbeats = 0;
  private readonly claimsPerHeartbeat: number;
  private readonly rampHeartbeats: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: DispatchRampOptions = {}) {
    this.claimsPerHeartbeat = Math.max(0, Math.floor(options.claimsPerHeartbeat ?? DEFAULT_RAMP_CLAIMS));
    this.rampHeartbeats = options.rampHeartbeats ?? DEFAULT_RAMP_HEARTBEATS;
    this.intervalMs = options.intervalMs ?? DEFAULT_RAMP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  /** True while new claims are still capped. */
  active(): boolean {
    return this.claimingHeartbeats < this.rampHeartbeats || this.now() - this.startedAt < this.intervalMs;
  }

  /** Slot budget for this admission pass. Does not count the pass; see record(). */
  budget(availableSlots: number): number {
    const slots = Math.max(0, Math.floor(availableSlots));
    return this.active() ? Math.min(slots, this.claimsPerHeartbeat) : slots;
  }

  /** Count the pass as a ramp heartbeat only when it actually enqueued a claim. */
  record(enqueued: number): void {
    if (enqueued > 0) this.claimingHeartbeats++;
  }
}

/**
 * The shortest gap between the schedule's next few runs, so an irregular cron
 * (e.g. a long overnight gap) does not stretch the floor. Falls back to
 * DEFAULT_RAMP_INTERVAL_MS when the schedule is missing or unparsable.
 */
export function scheduleIntervalMs(schedule: string | undefined): number {
  if (!schedule) return DEFAULT_RAMP_INTERVAL_MS;
  try {
    const runs = new Cron(schedule, { paused: true }).nextRuns(6).map(run => run.getTime());
    let shortest = Infinity;
    for (let i = 1; i < runs.length; i++) shortest = Math.min(shortest, runs[i] - runs[i - 1]);
    return Number.isFinite(shortest) && shortest > 0 ? shortest : DEFAULT_RAMP_INTERVAL_MS;
  } catch {
    return DEFAULT_RAMP_INTERVAL_MS;
  }
}

const ramps = new WeakMap<object, DispatchRamp>();

/**
 * Per-owner ramp so the runner needs a single call and no extra state: a new
 * runner instance (daemon start) gets a fresh ramp on its first admission pass,
 * and the time floor counts from that pass.
 */
export function dispatchBudget(
  owner: object,
  claimsPerHeartbeat: number | undefined,
  availableSlots: number,
  schedule?: string,
  now?: () => number,
): number {
  let ramp = ramps.get(owner);
  if (!ramp) {
    ramp = new DispatchRamp({ claimsPerHeartbeat, intervalMs: scheduleIntervalMs(schedule), now });
    ramps.set(owner, ramp);
  }
  return ramp.budget(availableSlots);
}

/** Report how many claims the owner's admission pass enqueued. */
export function recordDispatchClaims(owner: object, enqueued: number): void {
  ramps.get(owner)?.record(enqueued);
}
