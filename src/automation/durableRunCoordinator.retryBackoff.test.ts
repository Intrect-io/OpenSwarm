import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator, retryAtFor } from './durableRunCoordinator.js';

const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-backoff-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string): TaskItem {
  return {
    id,
    issueId: id,
    issueIdentifier: id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 2,
    createdAt: Date.now(),
    linearState: 'Todo',
    linearProject: { id: 'project', name: 'Repo' },
  };
}

function failure(finalStatus: PipelineResult['finalStatus']): PipelineResult {
  return {
    success: false,
    sessionId: 'session-1',
    stages: [],
    finalStatus,
    totalDuration: 100,
    iterations: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A task that fails every time was re-claimed as soon as its attempt ended and kept
// a slot for good: 11 issues took 74% of 78 attempts in four hours while 80 others
// waited (AGT-4673). The wait now doubles from the fourth attempt.
describe('retry backoff for a task that keeps failing (AGT-4673)', () => {
  it('keeps the 30-minute retry for three attempts, then doubles it up to six hours', () => {
    const failed = failure('failed');
    const minutes = (attemptNo: number) => retryAtFor(failed, 0, attemptNo) / 60_000;

    expect([1, 2, 3].map(minutes)).toEqual([30, 30, 30]);
    expect([4, 5, 6].map(minutes)).toEqual([60, 120, 240]);
    expect([7, 8, 40].map(minutes)).toEqual([360, 360, 360]);
    expect(retryAtFor(failed, 5_000)).toBe(5_000 + 30 * 60_000);
    expect(retryAtFor(failure('rejected'), 0, 5) / 60_000).toBe(120);
  });

  it('ramps an infrastructure error from fifteen minutes to a two-hour cap', () => {
    const infra = failure('infra_error');
    const minutes = (attemptNo: number) => retryAtFor(infra, 0, attemptNo) / 60_000;

    expect([1, 3].map(minutes)).toEqual([15, 15]);
    expect([4, 5, 6, 9].map(minutes)).toEqual([30, 60, 120, 120]);
  });

  it('does not slow a rate limit by its attempt count', () => {
    const limited = failure('rate_limited');
    expect(retryAtFor(limited, 1_000, 12)).toBe(1_000 + 60_000);
    expect(retryAtFor({ ...limited, rateLimitResetsAt: 9_000 }, 1_000, 12)).toBe(9_000);
  });

  // retryAtFor is only half of it: the coordinator has to pass the run's own attempt
  // count, or every failure keeps the first-attempt delay.
  it("applies the ramp from the run's own attempt count when a failure is recorded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'ramp-owner',
    });
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const startedAt = Date.now();
      await coordinator.execute(task('AGT-RAMP'), '/repo', async () => failure('failed'));
      const run = coordinator.getRun('AGT-RAMP');
      waits.push(((run?.retryAt ?? 0) - startedAt) / 60_000);
      vi.setSystemTime((run?.retryAt ?? 0) + 1);
    }
    expect(waits).toEqual([30, 30, 30, 60, 120]);
    coordinator.close();
  });
});
