// ============================================
// OpenSwarm - Event loop stall monitor
// Names what a multi-second block was spending its time on
// ============================================

import { safeConsole as console } from './safeLog.js';

/**
 * One observation window's worth of evidence about a stall.
 *
 * External probing established that the daemon blocks its event loop for tens
 * of seconds under dispatch load (AGT-4079: 28.58 s measured, one sample
 * censored at the probe's own 30 s ceiling), and that it logs *nothing* while
 * it happens — the second stall sat inside a 43-second gap with no output at
 * all. Seven candidate mechanisms were eliminated from outside; every survivor
 * lives inside that silent gap, so the next discriminating measurement has to
 * come from inside the process.
 */
export interface StallSample {
  /** Longest single event-loop delay seen in the window. */
  maxDelayMs: number;
  meanDelayMs: number;
  /** Wall-clock length of the window the delay was observed in. */
  windowMs: number;
  /** CPU consumed by this process during the window. */
  userCpuMs: number;
  systemCpuMs: number;
  /** Filesystem operations issued during the window. */
  fsRead: number;
  fsWrite: number;
  /** A thread yielding to wait (I/O) vs. being pre-empted (CPU contention). */
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
}

export type StallCause = 'cpu-bound' | 'blocked-off-cpu' | 'inconclusive';

export interface StallVerdict {
  cause: StallCause;
  /** CPU this process used as a percentage of the window. */
  cpuSharePct: number;
  reason: string;
}

/** Below this the window is too short for the ratios to mean anything. */
const MIN_WINDOW_MS = 100;
/** At or above this share of the window on-CPU, the loop was computing. */
const CPU_BOUND_SHARE_PCT = 70;
/** Below this share, the process was parked rather than working. */
const OFF_CPU_SHARE_PCT = 25;

/**
 * Classify a stall from CPU accounting.
 *
 * Deliberately not a stack trace: by the time a delay is observable the frame
 * that caused it has already returned, so nothing sampled here can name it.
 * What CPU share *can* settle is the question that splits the remaining
 * AGT-4079 candidates — was the process burning CPU in synchronous JS, or
 * parked waiting on something? Those have disjoint fixes, and picking the
 * wrong one costs a full investigate-and-deploy cycle.
 *
 * Only CPU share and the user/system split drive the verdict. An earlier
 * version also branched on `fsRead`/`fsWrite` and voluntary-vs-involuntary
 * context switches; measured against real stalls those counters do not support
 * it. On macOS `getrusage` leaves fs counts and voluntary switches at zero even
 * for a run of `readFileSync` (12 reads -> `fsRead: 0`), and *involuntary*
 * switches turned out to track being pre-empted **while busy** — 830 during a
 * 1 s CPU burn versus 20 during a 1 s blocking wait — which is the opposite of
 * the "starved by other tenants" reading they were given. They stay in
 * {@link StallSample} and in the log line as raw evidence; they do not decide.
 */
export function classifyStall(sample: StallSample): StallVerdict {
  if (sample.windowMs < MIN_WINDOW_MS) {
    return { cause: 'inconclusive', cpuSharePct: 0, reason: 'window too short to ratio against' };
  }
  const cpuMs = sample.userCpuMs + sample.systemCpuMs;
  const cpuSharePct = Math.round((cpuMs / sample.windowMs) * 1000) / 10;

  if (cpuSharePct >= CPU_BOUND_SHARE_PCT) {
    // System time dominating means the CPU went into the kernel — a large
    // synchronous read/write or a compression/crypto path — not a JS hot loop.
    return {
      cause: 'cpu-bound',
      cpuSharePct,
      reason: sample.systemCpuMs > sample.userCpuMs
        ? `on-CPU ${cpuSharePct}% of the window, mostly in the kernel (sys ${Math.round(sample.systemCpuMs)}ms > user ${Math.round(sample.userCpuMs)}ms) — a synchronous syscall path, not a JS hot loop`
        : `on-CPU ${cpuSharePct}% of the window in user code (user ${Math.round(sample.userCpuMs)}ms) — synchronous JS`,
    };
  }

  if (cpuSharePct < OFF_CPU_SHARE_PCT) {
    return {
      cause: 'blocked-off-cpu',
      cpuSharePct,
      reason: `off-CPU ${Math.round((100 - cpuSharePct) * 10) / 10}% of the window (user ${Math.round(sample.userCpuMs)}ms, sys ${Math.round(sample.systemCpuMs)}ms) — parked waiting, not computing`,
    };
  }

  return { cause: 'inconclusive', cpuSharePct, reason: `on-CPU ${cpuSharePct}% — between the CPU-bound and off-CPU thresholds` };
}

/** Render one line, so a stall leaves a marker inside an otherwise silent window. */
export function formatStall(sample: StallSample, verdict: StallVerdict): string {
  // The counters after the verdict are raw evidence, not inputs to it — see
  // classifyStall. They are printed so a future reader can check whether this
  // platform populates them before anyone builds a rule on them again.
  return `[EventLoop] Blocked ${Math.round(sample.maxDelayMs)}ms (mean ${Math.round(sample.meanDelayMs)}ms over ${Math.round(sample.windowMs)}ms) — ${verdict.cause}: ${verdict.reason}`
    + ` [fs r${sample.fsRead}/w${sample.fsWrite} ctx v${sample.voluntaryContextSwitches}/i${sample.involuntaryContextSwitches}]`;
}

export interface EventLoopMonitorOptions {
  /** Report a window whose worst delay reaches this. Default 2000ms. */
  thresholdMs?: number;
  /** How often to evaluate. Default 5000ms. */
  windowMs?: number;
  /** Timer period whose lateness is measured. Default 100ms. */
  tickMs?: number;
  /** Injected for tests. */
  now?: () => number;
  resourceUsage?: () => NodeJS.ResourceUsage;
  onStall?: (sample: StallSample, verdict: StallVerdict) => void;
}

const DEFAULT_THRESHOLD_MS = 2_000;
const DEFAULT_WINDOW_MS = 5_000;
/**
 * Timer period. 100ms bounds the resolution of a reported stall to +/-100ms,
 * which is far finer than the multi-second blocks this exists to catch, while
 * costing ten no-op callbacks a second.
 */
const DEFAULT_TICK_MS = 100;

/**
 * Measures how late a fixed-period timer actually fires. Its own lateness *is*
 * the loop's stall: nothing else can run while synchronous work holds the loop,
 * so the tick that should have fired at T lands at T+stall.
 *
 * Node's `perf_hooks.monitorEventLoopDelay` is the obvious instrument here and
 * it does not work for this: measured on this runtime (v26), an 800 ms
 * busy-wait left its `max` at the 21 ms warm-up value, and a 900 ms
 * `Atomics.wait` left it at 0. Timer lateness, by contrast, is what caught the
 * 354 ms block that a single embedding call causes and the 779 ms of its model
 * load — so it is what this uses.
 */
export class LagTracker {
  private maxMs = 0;
  private sumMs = 0;
  private samples = 0;
  private last: number;

  constructor(private readonly tickMs: number, now: number) {
    this.last = now;
  }

  observe(now: number): void {
    // Clamp at zero: a timer firing early (or a clock stepping backwards) is
    // not negative lag, and letting it through would cancel out real stalls in
    // the mean.
    const lag = Math.max(0, now - this.last - this.tickMs);
    this.last = now;
    if (lag > this.maxMs) this.maxMs = lag;
    this.sumMs += lag;
    this.samples += 1;
  }

  get maxDelayMs(): number { return this.maxMs; }
  get meanDelayMs(): number { return this.samples > 0 ? this.sumMs / this.samples : 0; }

  reset(now: number): void {
    this.maxMs = 0;
    this.sumMs = 0;
    this.samples = 0;
    this.last = now;
  }
}

/**
 * Build a sample from a lag tracker and two resource-usage snapshots.
 *
 * Split out from the timer so the arithmetic — the part that is easy to get
 * subtly wrong, since resource usage reports microseconds while everything
 * else here is milliseconds — is testable without waiting on real time.
 */
export function buildStallSample(
  lag: Pick<LagTracker, 'maxDelayMs' | 'meanDelayMs'>,
  before: NodeJS.ResourceUsage,
  after: NodeJS.ResourceUsage,
  windowMs: number,
): StallSample {
  const finite = (value: number): number => (Number.isFinite(value) ? value : 0);
  return {
    maxDelayMs: finite(lag.maxDelayMs),
    meanDelayMs: finite(lag.meanDelayMs),
    windowMs,
    userCpuMs: (after.userCPUTime - before.userCPUTime) / 1e3,
    systemCpuMs: (after.systemCPUTime - before.systemCPUTime) / 1e3,
    fsRead: after.fsRead - before.fsRead,
    fsWrite: after.fsWrite - before.fsWrite,
    voluntaryContextSwitches: after.voluntaryContextSwitches - before.voluntaryContextSwitches,
    involuntaryContextSwitches: after.involuntaryContextSwitches - before.involuntaryContextSwitches,
  };
}

/**
 * Start watching the event loop. Returns a stop function.
 *
 * Always-on by design: the stalls only appear under dispatch load, so an
 * instrument that has to be switched on after the fact never sees one — the
 * first 65 samples of the external probe, taken at 2 running tasks, contained
 * zero stalls while the same probe later caught two.
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): () => void {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const now = options.now ?? Date.now;
  const readUsage = options.resourceUsage ?? (() => process.resourceUsage());
  const report = options.onStall ?? ((sample, verdict) => console.warn(formatStall(sample, verdict)));

  const lag = new LagTracker(tickMs, now());
  let usageAt = readUsage();
  let windowStart = now();

  const timer = setInterval(() => {
    const at = now();
    lag.observe(at);
    const elapsed = at - windowStart;
    if (elapsed < windowMs) return;

    const usageNow = readUsage();
    if (lag.maxDelayMs >= thresholdMs) {
      const sample = buildStallSample(lag, usageAt, usageNow, elapsed);
      try {
        report(sample, classifyStall(sample));
      } catch { /* an instrument must never take down what it measures */ }
    }
    lag.reset(at);
    usageAt = usageNow;
    windowStart = at;
  }, tickMs);
  // Never keep the process alive for the sake of its own instrumentation.
  timer.unref?.();

  return () => clearInterval(timer);
}
