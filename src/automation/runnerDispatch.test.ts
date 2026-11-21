// Created: 2026-11-22
// Purpose: pin the DispatchHost contract — the parallel heartbeat, pair-mode execution and the
//          execution context reach the runner through a late-bound host (AGT-4867 slice G)
// Dependencies: runnerDispatch, autonomousRunner
// Test Status: passing

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';
import { executeTaskPairMode, getExecCtx, heartbeatParallel, type DispatchHost } from './runnerDispatch.js';

// runnerState fixes its state-file paths when the module is first imported, so point them at a
// scratch directory before any import runs; the runner must never read or write ~/.claude here.
const { stateRoot } = vi.hoisted(() => {
  const stateRoot = `${process.env.TMPDIR ?? '/tmp'}/openswarm-dispatch-state-${process.pid}`;
  for (const [key, file] of [
    ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
    ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
    ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
  ]) process.env[key] = `${stateRoot}/${file}`;
  return { stateRoot };
});
afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));

const baseConfig = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: true,
  dryRun: true,
  automationLedgerMode: 'off',
  ...over,
});

const makeTask = (id: string): TaskItem => ({
  id,
  source: 'linear',
  title: `Task ${id}`,
  priority: 3,
  projectPath: '/repo',
  issueId: id,
  issueIdentifier: id.toUpperCase(),
  linearState: 'Todo',
  createdAt: Date.now(),
}) as TaskItem;

function fakeHost(over: Partial<DispatchHost> = {}): DispatchHost {
  const host: DispatchHost = {
    rampOwner: {},
    stopping: false,
    config: baseConfig({ maxConcurrentTasks: 4, dispatchRampClaims: 4 }),
    engine: { heartbeatMultiple: vi.fn(async () => ({ action: 'skip', reason: 'none', tasks: [] })) } as unknown as DispatchHost['engine'],
    scheduler: {
      getAvailableSlots: vi.fn(() => 2),
      getStats: vi.fn(() => ({ running: 0 })),
      enqueue: vi.fn(() => true),
    } as unknown as DispatchHost['scheduler'],
    durableRuns: { isPrimary: false, getRun: vi.fn(), activeWorkerIdentifiers: vi.fn(() => []) } as unknown as DispatchHost['durableRuns'],
    pauses: { blocks: vi.fn(() => false), guardSerial: vi.fn() } as unknown as DispatchHost['pauses'],
    idle: { markProgress: vi.fn() },
    enabledProjects: new Set(['/repo']),
    projectPathCache: new Map(),
    unresolvableIssueIds: new Set(),
    failedTaskCounts: new Map(),
    lastFetchedTasks: [],
    rateLimitUntil: 0,
    syslog: () => {},
    syslogSkipSummary: () => {},
    shouldFilterByEnabled: () => false,
    isProjectEnabled: () => true,
    canQueueProjectCandidate: () => true,
    enqueueCandidate: vi.fn(() => true),
    resolveRunnableCandidates: vi.fn(async (decisionTasks) => decisionTasks.map(({ task }) => ({ task, projectPath: '/repo' }))),
    detectSafeCandidateIds: vi.fn(async (candidates) => new Set(candidates.map((c) => c.task.id))),
    runAvailableTasks: vi.fn(async () => {}),
    attachPriorFeedback: vi.fn(),
    resolveProjectPath: vi.fn(async () => '/repo'),
    scheduleNextHeartbeat: vi.fn(),
    executeDurably: vi.fn(),
    formatTaskContext: (task) => task.id,
    drainDurableOutbox: vi.fn(async () => {}),
    getRolesForProject: () => undefined,
  };
  return Object.assign(host, over);
}

describe('DispatchHost contract (AGT-4867 slice G)', () => {
  it('heartbeatParallel returns before the decision engine when no slot is free', async () => {
    const host = fakeHost();
    (host.scheduler.getAvailableSlots as ReturnType<typeof vi.fn>).mockReturnValue(0);

    await heartbeatParallel(host, [makeTask('a')]);

    expect(host.engine.heartbeatMultiple).not.toHaveBeenCalled();
    expect(host.runAvailableTasks).not.toHaveBeenCalled();
  });

  it('heartbeatParallel enqueues through the host, skips a paused project and then runs the queue', async () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const host = fakeHost({
      engine: { heartbeatMultiple: vi.fn(async () => ({ action: 'execute', reason: 't', tasks: tasks.map((task) => ({ task })) })) } as unknown as DispatchHost['engine'],
      resolveRunnableCandidates: vi.fn(async () => [{ task: tasks[0], projectPath: '/repo' }, { task: tasks[1], projectPath: '/paused' }]),
      pauses: { blocks: vi.fn((path: string) => path === '/paused'), guardSerial: vi.fn() } as unknown as DispatchHost['pauses'],
    });

    await heartbeatParallel(host, tasks);

    expect(host.enqueueCandidate).toHaveBeenCalledTimes(1);
    expect(host.enqueueCandidate).toHaveBeenCalledWith(tasks[0], '/repo');
    expect(host.runAvailableTasks).toHaveBeenCalledTimes(1);
  });

  it('heartbeatParallel stops without running the queue once the host reports stopping', async () => {
    let stopping = false;
    const host = fakeHost({
      engine: {
        heartbeatMultiple: vi.fn(async () => {
          stopping = true;
          return { action: 'execute', reason: 't', tasks: [{ task: makeTask('a') }] };
        }),
      } as unknown as DispatchHost['engine'],
    });
    Object.defineProperty(host, 'stopping', { get: () => stopping });

    await heartbeatParallel(host, [makeTask('a')]);

    expect(host.enqueueCandidate).not.toHaveBeenCalled();
    expect(host.runAvailableTasks).not.toHaveBeenCalled();
  });

  it('executeTaskPairMode marks an unresolvable issue and moves the heartbeat on', async () => {
    const host = fakeHost({ resolveProjectPath: vi.fn(async () => null) });

    await executeTaskPairMode(host, makeTask('lost'));

    expect(host.attachPriorFeedback).toHaveBeenCalledTimes(1);
    expect(host.unresolvableIssueIds.has('lost')).toBe(true);
    expect(host.scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
    expect(host.executeDurably).not.toHaveBeenCalled();
  });

  it('executeTaskPairMode writes a serial rate-limit hold back through the host setter', async () => {
    const resetsAt = Date.now() + 120_000;
    let written = 0;
    const result = { success: false, finalStatus: 'rate_limited', rateLimitResetsAt: resetsAt, totalDuration: 1 } as unknown as PipelineResult;
    const host = fakeHost({
      config: baseConfig({ maxConcurrentTasks: 1 }),
      pauses: {
        blocks: vi.fn(() => false),
        guardSerial: vi.fn(async (_id: string, _path: string, run: (signal: AbortSignal) => Promise<PipelineResult>) => run(new AbortController().signal)),
      } as unknown as DispatchHost['pauses'],
      executeDurably: vi.fn(async () => result),
    });
    Object.defineProperty(host, 'rateLimitUntil', { get: () => written, set: (value: number) => { written = value; } });

    await executeTaskPairMode(host, makeTask('limited'));

    expect(host.executeDurably).toHaveBeenCalledTimes(1);
    expect(written).toBeGreaterThanOrEqual(resetsAt);
    expect(host.drainDurableOutbox).not.toHaveBeenCalled();
  });

  it('getExecCtx closures read the host at call time and carry the durability hooks', () => {
    const host = fakeHost({ config: baseConfig({ draftModel: 'draft-x' }) });
    const durability = {} as Parameters<typeof getExecCtx>[1];

    const ctx = getExecCtx(host, durability);
    (host.failedTaskCounts as Map<string, number>).set('i-1', 2);
    ctx.scheduleNextHeartbeat?.();

    expect(ctx.draftModel).toBe('draft-x');
    expect(ctx.durability).toBe(durability);
    expect(ctx.getPriorFailures?.('i-1')).toBe(2);
    expect(host.scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
  });
});

describe('the runner builds its dispatch host once and late-bound (AGT-4867 slice G)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-dispatch-host-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  type Internal = {
    config: AutonomousConfig;
    engine: unknown;
    scheduler: unknown;
    rateLimitUntil: number;
    dispatchHost(): DispatchHost;
    heartbeatParallel(tasks: TaskItem[]): Promise<void>;
    executeTaskPairMode(task: TaskItem): Promise<void>;
    getExecCtx(): ReturnType<typeof getExecCtx>;
    resolveProjectPath(task: TaskItem): Promise<string | null>;
    detectSafeCandidateIds(candidates: Array<{ task: TaskItem }>): Promise<Set<string>>;
    runAvailableTasks(): Promise<void>;
    scheduleNextHeartbeat(): void;
  };

  async function makeRunner(over: Partial<AutonomousConfig> = {}): Promise<Internal> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    return new AutonomousRunner(baseConfig({ automationDbPath: join(root, 'automation.db'), ...over })) as unknown as Internal;
  }

  it('caches one host keyed on the runner and its getters see reassigned members', async () => {
    const runner = await makeRunner({ maxConcurrentTasks: 2 });
    const host = runner.dispatchHost();
    expect(runner.dispatchHost()).toBe(host);
    expect(host.rampOwner).toBe(runner);

    const engine = { heartbeatMultiple: vi.fn() };
    const scheduler = { getAvailableSlots: vi.fn(() => 0), getStats: vi.fn(() => ({ running: 0 })) };
    runner.engine = engine;
    runner.scheduler = scheduler;
    expect(host.engine).toBe(engine);
    expect(host.scheduler).toBe(scheduler);
    expect(host.config).toBe(runner.config);

    host.rateLimitUntil = 42;
    expect(runner.rateLimitUntil).toBe(42);
  });

  it('honours runner methods reassigned after the host is built', async () => {
    const runner = await makeRunner({ maxConcurrentTasks: 3, dispatchRampClaims: 3, allowedProjects: ['/repo'] });
    runner.dispatchHost(); // build before reassigning
    const task = makeTask('late');
    runner.engine = {
      heartbeatMultiple: vi.fn(async () => ({ action: 'execute', reason: 't', tasks: [{ task }], skippedCount: 0 })),
    };
    const resolve = vi.fn(async () => '/repo');
    const safe = vi.fn(async (candidates: Array<{ task: TaskItem }>) => new Set(candidates.map((c) => c.task.id)));
    const run = vi.fn(async () => {});
    runner.resolveProjectPath = resolve;
    runner.detectSafeCandidateIds = safe;
    runner.runAvailableTasks = run;

    await runner.heartbeatParallel([task]);

    expect(safe).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    const heartbeat = vi.fn();
    runner.scheduleNextHeartbeat = heartbeat;
    runner.getExecCtx().scheduleNextHeartbeat?.();
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
