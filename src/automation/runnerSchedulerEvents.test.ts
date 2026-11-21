// Created: 2026-11-22
// Purpose: pin the SchedulerEventsHost contract — handlers write state through the host and reach
//          runner members at call time, so a member reassigned after construction is honoured
// Dependencies: runnerSchedulerEvents, autonomousRunner, runnerExecution
// Test Status: passing

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { LastFailureEntry } from './runnerState.js';
import type { SchedulerEventsHost } from './runnerSchedulerEvents.js';
import type { HostDiskGate } from '../support/hostHealth.js';
import type { ITaskSource } from './taskSource.js';

type EventsModule = typeof import('./runnerSchedulerEvents.js');
type RunnerModule = typeof import('./autonomousRunner.js');
type ExecutionModule = typeof import('./runnerExecution.js');

let root = '';
let events: EventsModule;
let runnerModule: RunnerModule;
let execution: ExecutionModule;

const task = (): TaskItem => ({
  id: 'task-1', source: 'linear', issueId: 'ISSUE-1', issueIdentifier: 'INT-1',
  title: 'Edit some files', priority: 3, createdAt: 0,
});

const result = (over: Partial<PipelineResult> = {}): PipelineResult => ({
  success: false, sessionId: 'pipeline-1', iterations: 1, totalDuration: 5, stages: [], ...over,
});

function mockTaskSource(): ITaskSource {
  return {
    kind: 'local',
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
    logPairComplete: vi.fn(async () => {}),
  } as unknown as ITaskSource;
}

/** A fake host whose handler operations are collected so a test can await them. */
function fakeHost(over: Partial<SchedulerEventsHost> = {}) {
  const operations: Promise<void>[] = [];
  const state = {
    completedTaskIds: new Set<string>(),
    failedTaskCounts: new Map<string, number>(),
    failedTaskRetryTimes: new Map<string, number>(),
    consecutiveInfraErrorCounts: new Map<string, number>(),
    lastFailureDetails: new Map<string, LastFailureEntry>(),
  };
  const setRateLimit = vi.fn<(value: number) => void>();
  let rateLimitUntil = 0;
  const host: SchedulerEventsHost = {
    scheduler: new EventEmitter() as unknown as TaskScheduler,
    durableRuns: { isPrimary: false } as unknown as DurableRunCoordinator,
    config: { linearTeamId: 'team', allowedProjects: [], heartbeatSchedule: '0 * * * *', autoExecute: false },
    ...state,
    taskStateRef: state,
    diskGate: { resourceFailure: () => ({ pause: false }) } as unknown as HostDiskGate,
    maxRetryCount: 4,
    get rateLimitUntil() { return rateLimitUntil; },
    set rateLimitUntil(value: number) { setRateLimit(value); rateLimitUntil = value; },
    formatTaskContext: (t) => t.issueIdentifier ?? '',
    trackSchedulerHandler: (_label, operation) => { operations.push(operation); },
    saveTaskState: vi.fn(),
    scheduleNextHeartbeat: vi.fn(),
    drainDurableOutbox: vi.fn(async () => {}),
    runAvailableTasks: vi.fn(async () => {}),
    ...over,
  };
  return { host, operations, setRateLimit, settle: () => Promise.all(operations) };
}

beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'openswarm-scheduler-events-'));
  for (const [key, file] of [
    ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
    ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
    ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'], ['OPENSWARM_DAILY_PACE_FILE', 'pace.json'],
  ] as const) vi.stubEnv(key, join(root, file));
  events = await import('./runnerSchedulerEvents.js');
  runnerModule = await import('./autonomousRunner.js');
  execution = await import('./runnerExecution.js');
  execution.setTaskSource(mockTaskSource());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('SchedulerEventsHost contract (AGT-4867 slice D)', () => {
  it('registers the handlers on host.scheduler in the runner order', () => {
    const { host } = fakeHost();
    events.attachSchedulerEvents(host);
    expect((host.scheduler as unknown as EventEmitter).eventNames()).toEqual([
      'started', 'completed', 'superseded', 'deferred', 'cancelled', 'decomposed',
      'waiting_on_operator', 'failed', 'error', 'slotFreed',
    ]);
  });

  it('sets the rate-limit hold through the host setter and returns before any failure accounting', async () => {
    const { host, setRateLimit, settle } = fakeHost();
    const before = Date.now();
    events.onTaskFailed(host, { task: task(), result: result({ finalStatus: 'rate_limited', rateLimitResetsAt: before + 120_000 }) });
    await settle();
    expect(setRateLimit).toHaveBeenCalledTimes(1);
    expect(host.rateLimitUntil).toBeGreaterThanOrEqual(before + 120_000);
    expect(host.saveTaskState).not.toHaveBeenCalled();
    expect(host.scheduleNextHeartbeat).not.toHaveBeenCalled();
    expect(host.failedTaskCounts.size).toBe(0);
    const history = JSON.parse(readFileSync(join(root, 'history.json'), 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ sessionId: 'pipeline-1', issueId: 'ISSUE-1', finalStatus: 'rate_limited' });
  });

  it('clears retry state on a completed success and saves and re-fires through the host', async () => {
    const { host, settle } = fakeHost();
    host.failedTaskRetryTimes.set('ISSUE-1', Date.now() + 60_000);
    host.consecutiveInfraErrorCounts.set('ISSUE-1', 2);
    host.lastFailureDetails.set('ISSUE-1', { detail: 'old', recordedAt: 0 } as unknown as LastFailureEntry);
    events.onTaskCompleted(host, { task: task(), result: result({ success: true, finalStatus: 'approved' }) });
    await settle();
    expect(host.completedTaskIds.has('ISSUE-1')).toBe(true);
    expect(host.failedTaskRetryTimes.has('ISSUE-1')).toBe(false);
    expect(host.consecutiveInfraErrorCounts.has('ISSUE-1')).toBe(false);
    expect(host.lastFailureDetails.has('ISSUE-1')).toBe(false);
    expect(host.saveTaskState).toHaveBeenCalledTimes(1);
    expect(host.scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('runs slotFreed through the host runAvailableTasks', () => {
    const { host, operations } = fakeHost();
    events.onSlotFreed(host);
    expect(host.runAvailableTasks).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(1);
  });
});

describe('the runner builds its scheduler-events host late-bound (AGT-4867 slice D)', () => {
  type Internal = {
    scheduler: TaskScheduler;
    rateLimitUntil: number;
    failedTaskRetryTimes: Map<string, number>;
    saveTaskState(): void;
    scheduleNextHeartbeat(): void;
    runAvailableTasks(): Promise<void>;
  };
  const make = () => new runnerModule.AutonomousRunner({
    linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
    autoExecute: true, dryRun: true, automationLedgerMode: 'off',
  }) as unknown as Internal;

  it('honours saveTaskState and scheduleNextHeartbeat reassigned after construction', () => {
    const runner = make();
    const save = vi.fn();
    const next = vi.fn();
    runner.saveTaskState = save;
    runner.scheduleNextHeartbeat = next;
    runner.scheduler.emit('superseded', { task: task(), result: result() });
    expect(save).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(runner.failedTaskRetryTimes.has('ISSUE-1')).toBe(true);
  });

  it('writes the rate-limit hold onto the runner and honours a reassigned runAvailableTasks', async () => {
    const runner = make();
    const before = Date.now();
    runner.scheduler.emit('failed', { task: task(), result: result({ finalStatus: 'rate_limited', rateLimitResetsAt: before + 90_000 }) });
    expect(runner.rateLimitUntil).toBeGreaterThanOrEqual(before + 90_000);

    const run = vi.fn(async () => {});
    runner.runAvailableTasks = run;
    runner.scheduler.emit('slotFreed');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
