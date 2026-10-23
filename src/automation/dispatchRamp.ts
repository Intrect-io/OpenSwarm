/** Limits new claims while a daemon warms up after startup. */
export class DispatchRamp {
  private heartbeatCount = 0;

  constructor(
    private readonly claimsPerHeartbeat = 2,
    private readonly rampHeartbeats = 2,
  ) {}

  budget(availableSlots: number): number {
    const slots = Math.max(0, Math.floor(availableSlots));
    const budget = this.heartbeatCount < this.rampHeartbeats
      ? Math.min(slots, Math.max(0, Math.floor(this.claimsPerHeartbeat)))
      : slots;
    this.heartbeatCount++;
    return budget;
  }
}