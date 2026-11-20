/**
 * Cold-start dispatch ramp (AGT-4799).
 *
 * On 2026-10-20 the daemon restarted after two weeks idle; its first heartbeat
 * fetched 990 tasks against 8 free slots and filled every slot at once. This
 * caps how many new claims each heartbeat may make for the first few admission
 * passes after the runner starts, then lifts the cap.
 */
export const DEFAULT_RAMP_CLAIMS = 2;
export const DEFAULT_RAMP_HEARTBEATS = 2;

/** Limits new claims while a daemon warms up after startup. */
export class DispatchRamp {
  private heartbeatCount = 0;

  constructor(
    private readonly claimsPerHeartbeat = DEFAULT_RAMP_CLAIMS,
    private readonly rampHeartbeats = DEFAULT_RAMP_HEARTBEATS,
  ) {}

  /** Slot budget for this admission pass. Each call counts as one heartbeat. */
  budget(availableSlots: number): number {
    const slots = Math.max(0, Math.floor(availableSlots));
    const budget = this.heartbeatCount < this.rampHeartbeats
      ? Math.min(slots, Math.max(0, Math.floor(this.claimsPerHeartbeat)))
      : slots;
    this.heartbeatCount++;
    return budget;
  }
}

const ramps = new WeakMap<object, DispatchRamp>();

/**
 * Per-owner ramp so the runner needs a single call and no extra state: a new
 * runner instance (daemon start) gets a fresh ramp on its first admission pass.
 */
export function dispatchBudget(owner: object, claimsPerHeartbeat: number | undefined, availableSlots: number): number {
  let ramp = ramps.get(owner);
  if (!ramp) {
    ramp = new DispatchRamp(claimsPerHeartbeat ?? DEFAULT_RAMP_CLAIMS);
    ramps.set(owner, ramp);
  }
  return ramp.budget(availableSlots);
}
