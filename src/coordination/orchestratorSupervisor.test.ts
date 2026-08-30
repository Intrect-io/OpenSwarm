import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventHub } from '../core/eventHub.js';
import type { CoordinationEvent } from './coordinationStore.js';
import {
  isActionableOrchestratorEvent, OrchestratorSupervisor, selectOrchestratorItems,
} from './orchestratorSupervisor.js';

const originalCoordinationFile = process.env.OPENSWARM_COORDINATION_FILE;
const dirs: string[] = [];

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osw-supervisor-'));
  dirs.push(dir);
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
  return dir;
}

function event(over: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'event-1',
    seq: 1,
    timestamp: 1,
    repository: '/repo',
    taskId: 'task-1',
    actor: 'worker-a',
    actorName: 'Worker A',
    kind: 'advice-request',
    status: 'open',
    correlationId: 'thread-1',
    summary: 'Which shared helper should I use?',
    fingerprint: 'fingerprint-1',
    ...over,
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    callSign: 'Supervisor',
    output: 'done',
    toolsGranted: ['linear__get_issue'],
    toolsDenied: [],
    adapter: 'codex-responses' as const,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high' as const,
    ...over,
  };
}

const capsule = {
  text: 'rules', digest: 'digest', sources: [], errors: [], repositoryRoot: '/repo',
};

afterEach(() => {
  process.env.OPENSWARM_COORDINATION_FILE = originalCoordinationFile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OrchestratorSupervisor', () => {
  it('treats a newly opened durable thread as actionable supervision work', () => {
    expect(isActionableOrchestratorEvent(event({ kind: 'thread-update', status: 'open' }))).toBe(true);
    expect(isActionableOrchestratorEvent(event({ kind: 'thread-update', status: 'completed' }))).toBe(false);
  });

  it('includes the latest failed review in the supervisor view until its exchange advances', () => {
    const failed = event({ kind: 'review-run', status: 'failed', correlationId: 'review-1' });
    const completed = event({
      id: 'event-2',
      seq: 2,
      kind: 'review-run',
      status: 'completed',
      correlationId: 'review-1',
      fingerprint: 'fingerprint-2',
    });

    expect(selectOrchestratorItems([failed])).toEqual([failed]);
    expect(selectOrchestratorItems([failed, completed])).toEqual([]);
  });

  it('passes the explicit high-capability route into a cron/manual sweep', async () => {
    tempState();
    const run = vi.fn(async () => result());
    const supervisor = new OrchestratorSupervisor({
      config: {
        enabled: true,
        eventDriven: false,
        eventDebounceMs: 0,
        adapter: 'codex-responses',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        timeoutMs: 600_000,
        maxTurns: 12,
        legacy: false,
      },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run,
    });

    await supervisor.requestSweep('cron');

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      repository: '/repo',
      adapterName: 'codex-responses',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      timeoutMs: 600_000,
      maxTurns: 12,
      trigger: 'cron',
    }));
    expect(supervisor.getLastSweep()).toMatchObject({ ran: 1, failed: 0 });
    await supervisor.stop();
  });

  it('runs an internal-only sweep without an external MCP policy', async () => {
    tempState();
    const run = vi.fn(async () => result({ toolsGranted: [] }));
    const supervisor = new OrchestratorSupervisor({
      config: {
        enabled: true,
        eventDriven: false,
        eventDebounceMs: 0,
        adapter: 'codex-responses',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        timeoutMs: 600_000,
        maxTurns: 12,
        legacy: false,
      },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run,
    });

    await supervisor.requestSweep('manual');

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ policy: undefined }));
    expect(supervisor.getLastSweep()).toMatchObject({ ran: 1, skipped: 0 });
    await supervisor.stop();
  });

  it('reacts only to actionable board events and coalesces an unchanged generation', async () => {
    tempState();
    const run = vi.fn(async () => result());
    const supervisor = new OrchestratorSupervisor({
      config: {
        enabled: true,
        eventDriven: true,
        eventDebounceMs: 0,
        timeoutMs: 10_000,
        maxTurns: 5,
        legacy: false,
      },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run,
    });
    supervisor.start();

    getEventHub().emit('coordination:published', event({ kind: 'instruction-snapshot', status: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).not.toHaveBeenCalled();

    getEventHub().emit('coordination:published', event());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await supervisor.requestSweep('cron');
    expect(run).toHaveBeenCalledTimes(1);
    expect(supervisor.getLastSweep()).toMatchObject({ unchanged: 1, ran: 0 });
    await supervisor.stop();
  });

  it('keeps one in-process run active and drains a changed request afterward', async () => {
    tempState();
    let pending = [event()];
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (run.mock.calls.length === 1) await firstGate;
      active--;
      return result();
    });
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => pending,
      buildInstructionCapsule: () => capsule,
      run,
    });

    const first = supervisor.requestSweep('manual');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    pending = [event({ id: 'event-2', fingerprint: 'fingerprint-2', summary: 'New blocker' })];
    const second = supervisor.requestSweep('coordination-event');
    release();
    await Promise.all([first, second]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    await supervisor.stop();
  });

  it('lets only one daemon own a repository supervisor lock', async () => {
    tempState();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstRun = vi.fn(async () => { await gate; return result(); });
    const secondRun = vi.fn(async () => result());
    const common = {
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false } as const,
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      lockTimeoutMs: 0,
    };
    const first = new OrchestratorSupervisor({ ...common, run: firstRun });
    const second = new OrchestratorSupervisor({ ...common, run: secondRun });

    const owningSweep = first.requestSweep('manual');
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));
    await second.requestSweep('manual');

    expect(secondRun).not.toHaveBeenCalled();
    expect(second.getLastSweep()).toMatchObject({ locked: 1, ran: 0 });
    release();
    await owningSweep;
    await Promise.all([first.stop(), second.stop()]);
  });

  it('skips human-only or empty board state without building a capsule or calling a model', async () => {
    tempState();
    const run = vi.fn(async () => result());
    const buildInstructionCapsule = vi.fn(() => capsule);
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event({ kind: 'human-question', status: 'waiting' })],
      buildInstructionCapsule,
      run,
    });

    await supervisor.requestSweep('cron');

    expect(run).not.toHaveBeenCalled();
    expect(buildInstructionCapsule).not.toHaveBeenCalled();
    expect(supervisor.getLastSweep()).toMatchObject({ noAction: 1, ran: 0 });
    await supervisor.stop();
  });

  it('aborts and drains the active adapter run during shutdown', async () => {
    tempState();
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn(async (options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
      return result();
    });
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run: run as never,
    });

    const sweep = supervisor.requestSweep('manual');
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await supervisor.stop();
    await expect(sweep).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('counts an environment no-op separately from a provider run and retries it', async () => {
    tempState();
    const run = vi.fn(async () => result({ skippedReason: 'no-approved-mcp-tools' }));
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      policy: { servers: ['linear'] },
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run,
    });

    await supervisor.requestSweep('cron');
    expect(supervisor.getLastSweep()).toMatchObject({ ran: 0, skipped: 1 });
    await supervisor.requestSweep('cron');
    expect(run).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });
});
