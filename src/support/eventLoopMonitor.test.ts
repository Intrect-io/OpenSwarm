import { describe, it, expect, vi } from 'vitest';
import {
  classifyStall,
  buildStallSample,
  formatStall,
  startEventLoopMonitor,
  type StallSample,
} from './eventLoopMonitor.js';

vi.mock('./safeLog.js', () => ({ safeConsole: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function sample(overrides: Partial<StallSample> = {}): StallSample {
  return {
    maxDelayMs: 30_000,
    meanDelayMs: 400,
    windowMs: 5_000,
    userCpuMs: 0,
    systemCpuMs: 0,
    fsRead: 0,
    fsWrite: 0,
    voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
    ...overrides,
  };
}

describe('classifyStall', () => {
  it('calls synchronous JS when the window was spent on-CPU in user code', () => {
    const v = classifyStall(sample({ userCpuMs: 4_600, systemCpuMs: 100 }));
    expect(v.cause).toBe('cpu-bound');
    expect(v.cpuSharePct).toBe(94);
    expect(v.reason).toContain('synchronous JS');
  });

  it('separates a kernel-heavy CPU stall from a JS hot loop', () => {
    // Same on-CPU share, opposite split: a synchronous syscall path.
    const v = classifyStall(sample({ userCpuMs: 500, systemCpuMs: 4_200 }));
    expect(v.cause).toBe('cpu-bound');
    expect(v.reason).toContain('kernel');
    expect(v.reason).not.toContain('synchronous JS');
  });

  it('calls it parked when the process was off-CPU for the window', () => {
    // Measured shape of a real blocking wait: execSync('sleep 1') over a 1014ms
    // stall reported user 2ms / sys 1ms.
    const v = classifyStall(sample({ windowMs: 1_014, userCpuMs: 2, systemCpuMs: 1 }));
    expect(v.cause).toBe('blocked-off-cpu');
    expect(v.reason).toContain('parked waiting');
  });

  it('ignores the fs and context-switch counters entirely', () => {
    // A 1s CPU burn really does report 830 involuntary switches and fsRead 0 on
    // macOS; an earlier rule read that as "starved by other tenants". The
    // verdict must not move when those counters do.
    const base = sample({ windowMs: 1_000, userCpuMs: 989, systemCpuMs: 7 });
    const plain = classifyStall(base);
    const loaded = classifyStall({
      ...base, fsRead: 900, fsWrite: 400,
      voluntaryContextSwitches: 700, involuntaryContextSwitches: 830,
    });
    expect(loaded.cause).toBe('cpu-bound');
    expect(loaded).toEqual(plain);
  });

  it('refuses to guess between the thresholds', () => {
    expect(classifyStall(sample({ userCpuMs: 2_000, systemCpuMs: 250 })).cause).toBe('inconclusive');
  });

  it('refuses to ratio against a window too short to mean anything', () => {
    const v = classifyStall(sample({ windowMs: 40, userCpuMs: 39 }));
    expect(v.cause).toBe('inconclusive');
    expect(v.reason).toContain('too short');
  });
});

describe('buildStallSample', () => {
  const usage = (over: Partial<NodeJS.ResourceUsage> = {}): NodeJS.ResourceUsage => ({
    fsRead: 0, fsWrite: 0, involuntaryContextSwitches: 0, ipcReceived: 0, ipcSent: 0,
    majorPageFault: 0, maxRSS: 0, minorPageFault: 0, sharedMemorySize: 0, signalsCount: 0,
    swappedOut: 0, systemCPUTime: 0, unsharedDataSize: 0, unsharedStackSize: 0,
    userCPUTime: 0, voluntaryContextSwitches: 0, ...over,
  });

  it('passes lag through in ms and converts resource usage from us', () => {
    const s = buildStallSample(
      { maxDelayMs: 28_580, meanDelayMs: 412 },
      usage({ userCPUTime: 1_000_000, systemCPUTime: 500_000, fsRead: 10, voluntaryContextSwitches: 5 }),
      usage({ userCPUTime: 4_000_000, systemCPUTime: 900_000, fsRead: 42, voluntaryContextSwitches: 31 }),
      5_000,
    );
    expect(s.maxDelayMs).toBeCloseTo(28_580, 0);   // ns -> ms
    expect(s.meanDelayMs).toBeCloseTo(412, 0);
    expect(s.userCpuMs).toBe(3_000);               // us -> ms, and a delta
    expect(s.systemCpuMs).toBe(400);
    expect(s.fsRead).toBe(32);
    expect(s.voluntaryContextSwitches).toBe(26);
  });

  it('survives a tracker reporting a non-finite value', () => {
    const s = buildStallSample({ maxDelayMs: Infinity, meanDelayMs: NaN }, usage(), usage(), 5_000);
    expect(s.maxDelayMs).toBe(0);
    expect(s.meanDelayMs).toBe(0);
  });
});

describe('formatStall', () => {
  it('leaves one line carrying the delay and the verdict', () => {
    const s = sample({ maxDelayMs: 28_580, meanDelayMs: 412, userCpuMs: 4_600 });
    const line = formatStall(s, classifyStall(s));
    expect(line).toContain('[EventLoop] Blocked 28580ms');
    expect(line).toContain('cpu-bound');
    // Raw counters ride along as evidence even though they do not decide.
    expect(line).toContain('[fs r0/w0 ctx v0/i0]');
  });
});

describe('startEventLoopMonitor', () => {
  it('reports only windows that reach the threshold, and never holds the process open', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    let cpu = 0;
    const usage = (): NodeJS.ResourceUsage => ({
      fsRead: 0, fsWrite: 0, involuntaryContextSwitches: 0, ipcReceived: 0, ipcSent: 0,
      majorPageFault: 0, maxRSS: 0, minorPageFault: 0, sharedMemorySize: 0, signalsCount: 0,
      swappedOut: 0, systemCPUTime: 0, unsharedDataSize: 0, unsharedStackSize: 0,
      userCPUTime: (cpu += 1_000), voluntaryContextSwitches: 0,
    });
    const stop = startEventLoopMonitor({
      windowMs: 50, thresholdMs: 1_000_000, resourceUsage: usage,
      onStall: (_s, v) => seen.push(v.cause),
    });
    vi.advanceTimersByTime(500);
    // A threshold no real delay can reach must produce nothing at all.
    expect(seen).toEqual([]);
    stop();
    vi.useRealTimers();
  });

  it('stops the previous watcher when the same slot is re-armed', () => {
    // A failed `start()` leaves the monitor running with no `performStop()`;
    // the retry must replace it, not double-report every stall.
    vi.useFakeTimers();
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = startEventLoopMonitor({
      windowMs: 10, tickMs: 10, thresholdMs: 0, onStall: () => first.push('x'),
    });
    stopFirst();
    const stopSecond = startEventLoopMonitor({
      windowMs: 10, tickMs: 10, thresholdMs: 0, onStall: () => second.push('x'),
    });
    vi.advanceTimersByTime(100);
    expect(first).toEqual([]);
    expect(second.length).toBeGreaterThan(0);
    stopSecond();
    vi.useRealTimers();
  });

  it('contains a throwing reporter rather than taking down the process it measures', () => {
    vi.useFakeTimers();
    const stop = startEventLoopMonitor({
      windowMs: 10,
      thresholdMs: 0, // every window qualifies
      onStall: () => { throw new Error('reporter exploded'); },
    });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    stop();
    vi.useRealTimers();
  });
});
