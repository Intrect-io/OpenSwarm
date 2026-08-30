import type { PipelineResult } from '../agents/pairPipeline.js';

const DEFAULT_SAMPLE_LIMIT = 256;

export interface DurationSummary {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface SchedulerThroughputSnapshot {
  sampleLimit: number;
  slotUtilization: number;
  peakParallelism: number;
  queueWait: DurationSummary;
  execution: DurationSummary;
  stages: Record<string, DurationSummary>;
  outcomes: Record<string, number>;
  current: {
    maxConcurrent: number;
    availableSlots: number;
    runnableQueued: number;
    blockedByGlobalCapacity: number;
    blockedByProjectCapacity: number;
    blockedByQuarantine: number;
    oldestQueuedAgeMs: number;
  };
}

export interface SchedulerPressureSnapshot {
  running: number;
  maxConcurrent: number;
  availableSlots: number;
  runnableQueued: number;
  blockedByGlobalCapacity: number;
  blockedByProjectCapacity: number;
  blockedByQuarantine: number;
  oldestQueuedAgeMs: number;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function summarize(samples: readonly number[]): DurationSummary {
  if (samples.length === 0) {
    return { count: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    averageMs: Math.round(total / sorted.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Bounded, in-memory scheduler telemetry. It measures the critical path without
 * adding another durable writer to the admission transaction.
 */
export class SchedulerThroughputTracker {
  private readonly sampleLimit: number;
  private readonly queueWaitSamples: number[] = [];
  private readonly executionSamples: number[] = [];
  private readonly stageSamples = new Map<string, number[]>();
  private readonly outcomes = new Map<string, number>();
  private lastObservedAt: number;
  private observedRunning = 0;
  private observedCapacity: number;
  private occupiedSlotMs = 0;
  private capacitySlotMs = 0;
  private peakParallelism = 0;

  constructor(maxConcurrent: number, startedAt = Date.now(), sampleLimit = DEFAULT_SAMPLE_LIMIT) {
    this.observedCapacity = Math.max(1, Math.floor(maxConcurrent));
    this.lastObservedAt = startedAt;
    this.sampleLimit = Math.max(1, Math.floor(sampleLimit));
  }

  private append(samples: number[], value: number): void {
    samples.push(Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
    if (samples.length > this.sampleLimit) samples.splice(0, samples.length - this.sampleLimit);
  }

  observeOccupancy(running: number, maxConcurrent: number, now = Date.now()): void {
    const elapsed = Math.max(0, now - this.lastObservedAt);
    this.occupiedSlotMs += elapsed * this.observedRunning;
    this.capacitySlotMs += elapsed * this.observedCapacity;
    this.lastObservedAt = now;
    this.observedRunning = Math.max(0, Math.floor(running));
    this.observedCapacity = Math.max(1, Math.floor(maxConcurrent));
    this.peakParallelism = Math.max(this.peakParallelism, this.observedRunning);
  }

  recordQueueStart(queuedAt: number, startedAt = Date.now()): void {
    this.append(this.queueWaitSamples, startedAt - queuedAt);
  }

  recordResult(result: PipelineResult, startedAt: number, finishedAt = Date.now()): void {
    this.append(this.executionSamples, finishedAt - startedAt);
    this.outcomes.set(result.finalStatus, (this.outcomes.get(result.finalStatus) ?? 0) + 1);
    for (const stage of result.stages ?? []) {
      const samples = this.stageSamples.get(stage.stage) ?? [];
      this.append(samples, stage.duration);
      this.stageSamples.set(stage.stage, samples);
    }
  }

  recordError(startedAt: number, finishedAt = Date.now()): void {
    this.append(this.executionSamples, finishedAt - startedAt);
    this.outcomes.set('scheduler_error', (this.outcomes.get('scheduler_error') ?? 0) + 1);
  }

  snapshot(pressure: SchedulerPressureSnapshot, now = Date.now()): SchedulerThroughputSnapshot {
    this.observeOccupancy(pressure.running, pressure.maxConcurrent, now);
    const stages: Record<string, DurationSummary> = {};
    for (const [stage, samples] of [...this.stageSamples.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      stages[stage] = summarize(samples);
    }
    return {
      sampleLimit: this.sampleLimit,
      slotUtilization: this.capacitySlotMs > 0
        ? Number((this.occupiedSlotMs / this.capacitySlotMs).toFixed(4))
        : 0,
      peakParallelism: this.peakParallelism,
      queueWait: summarize(this.queueWaitSamples),
      execution: summarize(this.executionSamples),
      stages,
      outcomes: Object.fromEntries([...this.outcomes.entries()].sort(([left], [right]) => left.localeCompare(right))),
      current: {
        maxConcurrent: pressure.maxConcurrent,
        availableSlots: pressure.availableSlots,
        runnableQueued: pressure.runnableQueued,
        blockedByGlobalCapacity: pressure.blockedByGlobalCapacity,
        blockedByProjectCapacity: pressure.blockedByProjectCapacity,
        blockedByQuarantine: pressure.blockedByQuarantine,
        oldestQueuedAgeMs: Math.max(0, Math.round(pressure.oldestQueuedAgeMs)),
      },
    };
  }
}
