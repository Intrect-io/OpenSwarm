import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import { SchedulerThroughputTracker } from './schedulerThroughput.js';

function result(): PipelineResult {
  return {
    success: true,
    sessionId: 'session',
    finalStatus: 'approved',
    totalDuration: 200,
    iterations: 1,
    stages: [
      { stage: 'worker', success: true, result: {} as never, duration: 120, startedAt: 0, completedAt: 120 },
      { stage: 'reviewer', success: true, result: {} as never, duration: 80, startedAt: 120, completedAt: 200 },
    ],
  };
}

describe('SchedulerThroughputTracker', () => {
  it('measures time-weighted occupancy, queue wait, execution and pipeline stages', () => {
    const tracker = new SchedulerThroughputTracker(2, 0, 8);
    tracker.observeOccupancy(1, 2, 100);
    tracker.recordQueueStart(20, 100);
    tracker.observeOccupancy(2, 2, 200);
    tracker.recordQueueStart(140, 200);
    tracker.recordResult(result(), 100, 300);

    const snapshot = tracker.snapshot({
      running: 1,
      maxConcurrent: 2,
      availableSlots: 1,
      runnableQueued: 2,
      blockedByGlobalCapacity: 0,
      blockedByProjectCapacity: 1,
      blockedByQuarantine: 0,
      deferredByRetryAt: 0,
      oldestQueuedAgeMs: 90,
    }, 300);

    expect(snapshot.slotUtilization).toBe(0.5);
    expect(snapshot.peakParallelism).toBe(2);
    expect(snapshot.queueWait).toMatchObject({ count: 2, averageMs: 70, p95Ms: 80 });
    expect(snapshot.execution).toMatchObject({ count: 1, averageMs: 200 });
    expect(snapshot.stages).toMatchObject({
      worker: { count: 1, averageMs: 120 },
      reviewer: { count: 1, averageMs: 80 },
    });
    expect(snapshot.outcomes).toEqual({ approved: 1 });
    expect(snapshot.current).toMatchObject({ runnableQueued: 2, blockedByProjectCapacity: 1 });
  });

  it('keeps only the configured rolling sample window', () => {
    const tracker = new SchedulerThroughputTracker(1, 0, 2);
    tracker.recordQueueStart(0, 10);
    tracker.recordQueueStart(0, 20);
    tracker.recordQueueStart(0, 30);
    tracker.recordError(0, 40);

    const snapshot = tracker.snapshot({
      running: 0,
      maxConcurrent: 1,
      availableSlots: 1,
      runnableQueued: 0,
      blockedByGlobalCapacity: 0,
      blockedByProjectCapacity: 0,
      blockedByQuarantine: 0,
      deferredByRetryAt: 0,
      oldestQueuedAgeMs: 0,
    }, 40);

    expect(snapshot.queueWait).toMatchObject({ count: 2, averageMs: 25, p50Ms: 20, p95Ms: 30 });
    expect(snapshot.outcomes).toEqual({ scheduler_error: 1 });
  });
});
