import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventHub } from '../core/eventHub.js';
import {
  getCoordinationStore, resetCoordinationStoreForTests, type CoordinationEvent,
} from './coordinationStore.js';
import {
  isActionableOrchestratorEvent, ORCHESTRATOR_SUPERVISOR_TASK_ID,
  OrchestratorSupervisor, selectOrchestratorItems,
} from './orchestratorSupervisor.js';
import { repositoryCell, resetRepositoryCellCacheForTests } from './repositoryCell.js';

const originalCoordinationFile = process.env.OPENSWARM_COORDINATION_FILE;
const dirs: string[] = [];

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osw-supervisor-'));
  dirs.push(dir);
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function linkedRepository(root: string): { main: string; sibling: string; alias: string } {
  const main = join(root, 'main');
  const sibling = join(root, 'sibling');
  const alias = join(root, 'main-alias');
  mkdirSync(main);
  git(main, 'init');
  git(main, 'config', 'user.email', 'test@example.invalid');
  git(main, 'config', 'user.name', 'OpenSwarm test');
  writeFileSync(join(main, 'README.md'), 'supervisor cell\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-m', 'seed');
  git(main, 'worktree', 'add', '-b', 'sibling', sibling);
  symlinkSync(main, alias, 'dir');
  return { main, sibling, alias };
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
  resetCoordinationStoreForTests();
  resetRepositoryCellCacheForTests();
  process.env.OPENSWARM_COORDINATION_FILE = originalCoordinationFile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OrchestratorSupervisor', () => {
  it('treats a newly opened durable thread as actionable supervision work', () => {
    expect(isActionableOrchestratorEvent(event({ kind: 'thread-update', status: 'open' }))).toBe(true);
    expect(isActionableOrchestratorEvent(event({
      kind: 'thread-update', status: 'completed', metadata: { action: 'replied' },
    }))).toBe(true);
    expect(isActionableOrchestratorEvent(event({
      kind: 'thread-update', status: 'completed', metadata: { action: 'created' },
    }))).toBe(false);
    expect(isActionableOrchestratorEvent(event({
      kind: 'thread-update', status: 'completed', metadata: { action: 'replied' }, actorRole: 'orchestrator',
    }))).toBe(true);
    expect(isActionableOrchestratorEvent(event({
      kind: 'thread-update', status: 'completed', metadata: { action: 'replied' },
      actorRole: 'orchestrator', taskId: ORCHESTRATOR_SUPERVISOR_TASK_ID,
    }))).toBe(false);
    expect(isActionableOrchestratorEvent(event({ kind: 'human-question', status: 'waiting' }))).toBe(true);
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

  it('keeps a late peer response in the supervisor view after it closes the request exchange', () => {
    const request = event({ correlationId: 'advice-1' });
    const response = event({
      id: 'event-2', seq: 2, kind: 'advice-response', status: 'completed',
      correlationId: 'advice-1', fingerprint: 'fingerprint-2',
    });

    expect(selectOrchestratorItems([request, response])).toEqual([response]);
  });

  it('excludes only this supervisor\'s events and advances one-shot terminal items by sequence', () => {
    const ownResponse = event({
      id: 'own', seq: 2, taskId: ORCHESTRATOR_SUPERVISOR_TASK_ID,
      actorRole: 'orchestrator', kind: 'advice-response', status: 'completed',
      correlationId: 'own-response', fingerprint: 'own-fingerprint',
    });
    const peerResponse = event({
      id: 'peer', seq: 3, taskId: 'peer-orchestrator', actorRole: 'orchestrator',
      kind: 'advice-response', status: 'completed', correlationId: 'peer-response',
      fingerprint: 'peer-fingerprint',
    });
    const open = event({
      id: 'open', seq: 1, correlationId: 'open-request', fingerprint: 'open-fingerprint',
    });

    expect(selectOrchestratorItems([open, ownResponse, peerResponse], 2)).toEqual([open, peerResponse]);
    expect(selectOrchestratorItems([open, ownResponse, peerResponse], 3)).toEqual([open]);
  });

  it('does not replay an older terminal outcome when a later outcome arrives after restart', async () => {
    tempState();
    const store = getCoordinationStore();
    await store.publish({
      repository: '/repo', taskId: 'worker-a', actor: 'worker-a', actorRole: 'worker',
      kind: 'advice-response', status: 'completed', correlationId: 'first-response',
      summary: 'first terminal outcome',
    });
    const firstRun = vi.fn(async () => result());
    const common = {
      config: {
        enabled: true, eventDriven: false, eventDebounceMs: 0,
        timeoutMs: 10_000, maxTurns: 5, legacy: false,
      } as const,
      getRepositories: () => ['/repo'],
      buildInstructionCapsule: () => capsule,
    };
    const first = new OrchestratorSupervisor({ ...common, run: firstRun });
    await first.requestSweep('manual');
    expect(firstRun.mock.calls[0][0].objective).toContain('first terminal outcome');
    await first.stop();

    await store.publish({
      repository: '/repo', taskId: 'worker-b', actor: 'worker-b', actorRole: 'worker',
      kind: 'delegation-result', status: 'completed', correlationId: 'second-response',
      summary: 'second terminal outcome',
    });
    const secondRun = vi.fn(async () => result());
    const second = new OrchestratorSupervisor({ ...common, run: secondRun });
    await second.requestSweep('manual');
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(secondRun.mock.calls[0][0].objective).toContain('second terminal outcome');
    expect(secondRun.mock.calls[0][0].objective).not.toContain('first terminal outcome');
    await second.stop();

    const thirdRun = vi.fn(async () => result());
    const third = new OrchestratorSupervisor({ ...common, run: thirdRun });
    await third.requestSweep('manual');
    expect(thirdRun).not.toHaveBeenCalled();
    expect(third.getLastSweep()).toMatchObject({ noAction: 1, ran: 0 });
    await third.stop();
  });

  it('reconciles a pre-start durable event once and keeps the handled cursor across restart', async () => {
    tempState();
    const firstRun = vi.fn(async () => result());
    const options = {
      config: {
        enabled: true, eventDriven: true, eventDebounceMs: 0,
        timeoutMs: 10_000, maxTurns: 5, legacy: false,
      } as const,
      getRepositories: () => ['/repo'],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
    };
    const first = new OrchestratorSupervisor({ ...options, run: firstRun });

    first.start();
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));
    await first.stop();

    const secondRun = vi.fn(async () => result());
    const second = new OrchestratorSupervisor({ ...options, run: secondRun });
    second.start();
    await vi.waitFor(() => expect(second.getLastSweep()).not.toBeNull());
    expect(secondRun).not.toHaveBeenCalled();
    expect(second.getLastSweep()).toMatchObject({ unchanged: 1, ran: 0 });
    await second.stop();
  });

  it('wakes an event-only supervisor for a response that arrives after the request run', async () => {
    tempState();
    let pending: CoordinationEvent[] = [];
    const run = vi.fn(async () => result());
    const supervisor = new OrchestratorSupervisor({
      config: {
        enabled: true, eventDriven: true, eventDebounceMs: 0,
        timeoutMs: 10_000, maxTurns: 5, legacy: false,
      },
      getRepositories: () => ['/repo'],
      getPending: () => pending,
      buildInstructionCapsule: () => capsule,
      run,
    });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.getLastSweep()).not.toBeNull());

    const response = event({
      id: 'event-2', seq: 2, kind: 'advice-response', status: 'completed',
      correlationId: 'advice-1', fingerprint: 'response-fingerprint',
    });
    pending = [response];
    getEventHub().emit('coordination:published', response);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].objective).toContain('advice-response/completed');
    await supervisor.stop();
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
    let pending: CoordinationEvent[] = [];
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
      getPending: () => pending,
      buildInstructionCapsule: () => capsule,
      run,
    });
    supervisor.start();

    getEventHub().emit('coordination:published', event({ kind: 'instruction-snapshot', status: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).not.toHaveBeenCalled();

    pending = [event()];
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

  it('deduplicates linked-worktree and symlink aliases into one supervisor cell', async () => {
    const root = tempState();
    const { main, sibling, alias } = linkedRepository(root);
    resetCoordinationStoreForTests();
    const cell = repositoryCell(main);
    await getCoordinationStore().publish({
      repository: sibling,
      repoKey: cell.repoKey,
      taskId: 'task-1',
      actor: 'worker-a',
      actorRole: 'worker',
      kind: 'advice-request',
      status: 'open',
      correlationId: 'cell-request',
      summary: 'Coordinate this repository cell',
    });
    const run = vi.fn(async () => result());
    const buildInstructionCapsule = vi.fn((repository: string) => ({
      ...capsule, repositoryRoot: repository,
    }));
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      getRepositories: () => [sibling, alias, main],
      buildInstructionCapsule,
      run,
    });

    await supervisor.requestSweep('manual');

    expect(supervisor.getLastSweep()).toMatchObject({ considered: 1, ran: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ repository: cell.repositoryPath }));
    expect(buildInstructionCapsule).toHaveBeenCalledWith(cell.repositoryPath);
    await supervisor.stop();
  });

  it('shares the supervisor lock and handled cursor across sibling worktrees', async () => {
    const root = tempState();
    const { main, sibling, alias } = linkedRepository(root);
    resetCoordinationStoreForTests();
    const cell = repositoryCell(main);
    await getCoordinationStore().publish({
      repository: sibling,
      repoKey: cell.repoKey,
      taskId: 'task-1',
      actor: 'worker-a',
      actorRole: 'worker',
      kind: 'advice-request',
      status: 'open',
      correlationId: 'shared-lock-request',
      summary: 'Run exactly one supervisor',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstRun = vi.fn(async () => { await gate; return result(); });
    const secondRun = vi.fn(async () => result());
    const common = {
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false } as const,
      buildInstructionCapsule: (repository: string) => ({ ...capsule, repositoryRoot: repository }),
      lockTimeoutMs: 0,
    };
    const first = new OrchestratorSupervisor({ ...common, getRepositories: () => [main], run: firstRun });
    const second = new OrchestratorSupervisor({ ...common, getRepositories: () => [sibling], run: secondRun });

    const owningSweep = first.requestSweep('manual');
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));
    await second.requestSweep('manual');
    expect(secondRun).not.toHaveBeenCalled();
    expect(second.getLastSweep()).toMatchObject({ locked: 1, ran: 0 });
    release();
    await owningSweep;
    await Promise.all([first.stop(), second.stop()]);

    const restartedRun = vi.fn(async () => result());
    const restarted = new OrchestratorSupervisor({
      ...common, getRepositories: () => [alias], run: restartedRun,
    });
    await restarted.requestSweep('manual');
    expect(restartedRun).not.toHaveBeenCalled();
    expect(restarted.getLastSweep()).toMatchObject({ unchanged: 1, ran: 0 });
    await restarted.stop();
  });

  it('runs on a worker question so the supervisor can resolve it before human escalation', async () => {
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

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ objective: expect.stringContaining('Which shared helper') }));
    expect(buildInstructionCapsule).toHaveBeenCalledTimes(1);
    expect(supervisor.getLastSweep()).toMatchObject({ noAction: 0, ran: 1 });
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

  it('logs a user-controlled repository path as data rather than a format string', async () => {
    const root = tempState();
    const repository = join(root, '%s-repository');
    mkdirSync(repository);
    const failure = new Error('provider unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supervisor = new OrchestratorSupervisor({
      config: { enabled: true, eventDriven: false, eventDebounceMs: 0, timeoutMs: 10_000, maxTurns: 5, legacy: false },
      getRepositories: () => [repository],
      getPending: () => [event()],
      buildInstructionCapsule: () => capsule,
      run: async () => { throw failure; },
    });

    await supervisor.requestSweep('manual');

    expect(supervisor.getLastSweep()).toMatchObject({ failed: 1, ran: 0 });
    expect(log).toHaveBeenCalledWith(
      '[Orchestrator] repository failed:', repositoryCell(repository).repositoryPath, failure,
    );
    await supervisor.stop();
  });
});
