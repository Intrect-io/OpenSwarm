import { afterEach, describe, it, expect, vi } from 'vitest';
import type { LinearIssueInfo, SwarmConfig } from '../core/types.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { ITaskSource } from '../automation/taskSource.js';
import type { ExecutionContext } from '../automation/runnerExecution.js';
import type { ExecutionDurabilityHooks } from '../automation/durableRunCoordinator.js';
import type { EffectClaim, EffectInput } from '../automation/runLedger.js';
import type { RepoMetadata } from '../support/repoMetadata.js';
import {
  configureHumanSurfaceReadOnly,
  isHumanSurfaceReadOnlyEnabled,
} from '../mcp/humanSurfacePolicy.js';
import {
  buildConflictFreeWaves,
  buildWorkAdmission,
  formatWorkSummary,
  runWorkCommand,
  summarizeSettled,
  WORK_EXIT_FAILED,
  WORK_EXIT_INTERRUPTED,
  WORK_EXIT_NOT_RUN,
  WORK_EXIT_OK,
  type WorkCommandDeps,
  type WorkCoordinator,
} from './workCommand.js';

afterEach(() => configureHumanSurfaceReadOnly(false));

function issue(overrides: Partial<LinearIssueInfo> = {}): LinearIssueInfo {
  return {
    id: `uuid-${overrides.identifier ?? 'INT-1'}`,
    identifier: 'INT-1',
    title: 'Fix the thing',
    state: 'Todo',
    priority: 2,
    labels: [],
    comments: [],
    project: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    success: true,
    sessionId: 'sess-1',
    stages: [],
    finalStatus: 'approved',
    totalDuration: 1000,
    iterations: 1,
    ...overrides,
  };
}

const fakeSource = { kind: 'linear' } as unknown as ITaskSource;

const noopHooks: ExecutionDurabilityHooks = {
  onWorktree: async () => true,
  onStage: async () => true,
  beforePublish: async () => true,
  onPublication: async () => true,
};

/** Coordinator fake: runs the executor inline, queues success effects, drains them. */
function fakeCoordinator(): WorkCoordinator & { effects: EffectInput[]; closed: () => boolean } {
  const effects: EffectInput[] = [];
  let closed = false;
  return {
    effects,
    closed: () => closed,
    async execute(task: TaskItem, _projectPath, executor, options) {
      const result = await executor(noopHooks, new AbortController().signal);
      if (result.success && options?.successEffect) {
        effects.push(options.successEffect(result, {
          issueId: task.issueId ?? task.id,
          ownerInstanceId: 'test',
          leaseToken: 'lease',
          leaseEpoch: 1,
          attemptNo: 1,
          leaseExpiresAt: Date.now() + 60_000,
        }));
      }
      return result;
    },
    async drainOutbox(deliver) {
      // Mirrors the real ledger: delivered effects leave the outbox, so a
      // second pass applies zero (the command's drain loop relies on this).
      const pending = effects.splice(0, effects.length);
      for (const [index, effect] of pending.entries()) {
        await deliver({
          ...effect,
          id: index + 1,
          issueId: 'x',
          attemptNo: 1,
          ownerInstanceId: 'test',
          deliveryToken: 'token',
          leaseExpiresAt: Date.now() + 60_000,
        } as unknown as EffectClaim);
      }
      return { applied: pending.length, retried: 0, dead: 0 };
    },
    close: () => {
      closed = true;
    },
  };
}

function baseDeps(overrides: Partial<WorkCommandDeps> = {}): WorkCommandDeps & {
  logs: string[];
  outs: string[];
  coordinator: ReturnType<typeof fakeCoordinator>;
  exec: ReturnType<typeof vi.fn>;
} {
  const logs: string[] = [];
  const outs: string[] = [];
  const coordinator = fakeCoordinator();
  const exec = vi.fn(async (
    _ctx: ExecutionContext,
    _task: TaskItem,
    _projectPath: string,
    _signal?: AbortSignal,
  ) => pipelineResult());
  const deps: WorkCommandDeps = {
    loadConfig: () => ({ autonomous: { maxConcurrentTasks: 4 } }) as unknown as SwarmConfig,
    ensureTaskSource: async () => fakeSource,
    registerTaskSource: vi.fn(),
    isValidProjectPath: async () => true,
    isGitRepo: () => true,
    loadRepoMetadata: async () => null,
    getIssue: async (id) => issue({ identifier: id, id: `uuid-${id}` }),
    resolveTaskFileScope: vi.fn(async (task) => {
      task.fileScope ??= [`src/${task.issueIdentifier ?? task.id}.ts`];
      return task.fileScope;
    }),
    hasRecoverableWorktree: async () => false,
    createCoordinator: () => coordinator,
    executePipeline: exec,
    deliverEffect: vi.fn(async () => undefined),
    installSigintHandler: () => () => undefined,
    isTTY: true,
    confirm: async () => true,
    log: (line) => logs.push(line),
    out: (line) => outs.push(line),
    ...overrides,
  } as WorkCommandDeps;
  return Object.assign(deps, { logs, outs, coordinator, exec });
}

describe('runWorkCommand — review-finding gates (INT-3387)', () => {
  it('refuses a repo whose openswarm.json disables automation', async () => {
    const deps = baseDeps({
      loadRepoMetadata: async () => ({ schemaVersion: 1, automation: { enabled: false } } as unknown as RepoMetadata),
    });
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_NOT_RUN);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.logs.join('\n')).toMatch(/automation\.enabled: false/);
  });

  it('layers repo automation limits into admission', () => {
    const admission = buildWorkAdmission(8, {
      enabled: true,
      maxConcurrent: 2,
      maxAttemptsPerHour: 5,
      maxFailuresPerHour: 3,
      maxCostUsdPerDay: 10,
      circuitCooldownMinutes: 30,
    });
    expect(admission).toMatchObject({
      maxConcurrent: 2,
      maxAttemptsPerHour: 5,
      maxFailuresPerHour: 3,
      maxCostUsdPerDay: 10,
      circuitCooldownMs: 30 * 60_000,
    });
    // No policy → CLI concurrency + daemon defaults.
    expect(buildWorkAdmission(8)).toMatchObject({ maxConcurrent: 8, maxFailuresPerHour: 6 });
  });

  it("skips a direct id that belongs to a different Linear project than the repo's mapping", async () => {
    const deps = baseDeps({
      loadRepoMetadata: async () => ({ schemaVersion: 1, linear: { projectId: 'proj-1' } } as unknown as RepoMetadata),
      getIssue: async (id) => issue({
        identifier: id,
        id: `uuid-${id}`,
        project: id === 'INT-2' ? { id: 'other-proj', name: 'Other' } : { id: 'proj-1', name: 'OpenSwarm' },
      }),
    });
    const code = await runWorkCommand({ issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.exec).toHaveBeenCalledTimes(1);
    expect(deps.logs.join('\n')).toMatch(/INT-2.*different Linear project/);
  });

  it('skips an issue whose blockers are unresolved — including a blocker selected in the same batch', async () => {
    const blockerUuid = 'uuid-INT-1';
    const deps = baseDeps({
      getIssue: async (id) => {
        if (id === 'INT-1' || id === blockerUuid) return issue({ identifier: 'INT-1', id: blockerUuid, state: 'Todo' });
        return issue({ identifier: id, id: `uuid-${id}`, blockedBy: [blockerUuid] });
      },
    });
    const code = await runWorkCommand({ issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    // Only the blocker runs; the dependent is skipped with a reason.
    expect(deps.exec).toHaveBeenCalledTimes(1);
    expect(deps.logs.join('\n')).toMatch(/INT-2.*blocked by 1 unresolved/);
  });

  it('lets an issue through when its blockers are Done', async () => {
    const deps = baseDeps({
      getIssue: async (id) => {
        if (id === 'blocker-uuid') return issue({ identifier: 'INT-9', id: 'blocker-uuid', state: 'Done' });
        return issue({ identifier: id, id: `uuid-${id}`, blockedBy: ['blocker-uuid'] });
      },
    });
    const code = await runWorkCommand({ issueIds: ['INT-2'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });

  it('uses the real Linear createdAt for grooming order instead of Date.now()', async () => {
    const deps = baseDeps({
      getIssue: async (id) => issue({ identifier: id, id: `uuid-${id}`, createdAt: '2026-01-02T03:04:05.000Z' }),
    });
    await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    const task = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0][1] as TaskItem;
    expect(task.createdAt).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  });

  it('refuses a non-git directory before resolving anything', async () => {
    const deps = baseDeps({ isGitRepo: () => false });
    const getIssueSpy = vi.fn();
    deps.getIssue = getIssueSpy as unknown as WorkCommandDeps['getIssue'];
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_NOT_RUN);
    expect(getIssueSpy).not.toHaveBeenCalled();
  });
});

describe('runWorkCommand — direct issue ids (INT-3387)', () => {
  it('deploys one pipeline per issue with the work command contract in the context', async () => {
    const deps = baseDeps();
    const code = await runWorkCommand(
      { issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.exec).toHaveBeenCalledTimes(2);
    for (const call of deps.exec.mock.calls) {
      const ctx = call[0] as ExecutionContext;
      expect(ctx.worktreeMode).toBe(true);
      expect(ctx.enableDecomposition).toBe(false);
      expect(ctx.allowedProjects).toEqual(['/repo']);
      expect(ctx.durability).toBe(noopHooks);
      expect(ctx.peerIssues).toHaveLength(2);
    }
    const identifiers = deps.exec.mock.calls.map((call) => (call[1] as TaskItem).issueIdentifier);
    expect(identifiers).toEqual(['INT-1', 'INT-2']);
  });

  it('registers the task source so pipeline tracker writes work (setTaskSource)', async () => {
    const deps = baseDeps();
    await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(deps.registerTaskSource).toHaveBeenCalledWith(fakeSource);
  });

  it('fails fast when any listed issue does not resolve — nothing starts', async () => {
    const deps = baseDeps({
      getIssue: async (id) => (id === 'NONEXIST-999' ? null : issue({ identifier: id })),
    });
    const code = await runWorkCommand(
      { issueIds: ['INT-1', 'NONEXIST-999'], path: '/repo', yes: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_NOT_RUN);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.logs.join('\n')).toContain('Issue not found: NONEXIST-999');
  });

  it('skips Done/In Review issues with a reason and still runs the rest', async () => {
    const deps = baseDeps({
      getIssue: async (id) => issue({
        identifier: id,
        id: `uuid-${id}`,
        state: id === 'INT-1' ? 'Done' : 'Todo',
      }),
    });
    const code = await runWorkCommand(
      { issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.exec).toHaveBeenCalledTimes(1);
    expect(deps.logs.join('\n')).toContain('Skipping INT-1: state is Done');
  });

  it('exits 2 when every listed issue is skipped', async () => {
    const deps = baseDeps({ getIssue: async (id) => issue({ identifier: id, state: 'Done' }) });
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_NOT_RUN);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ids resolving to the same issue', async () => {
    const deps = baseDeps();
    await runWorkCommand({ issueIds: ['INT-1', 'INT-1'], path: '/repo', yes: true }, deps);
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });
});

describe('runWorkCommand — bootstrap validation', () => {
  it('activates the strict boundary from an injected config loader', async () => {
    const deps = baseDeps({
      loadConfig: () => ({
        autonomous: { maxConcurrentTasks: 1 },
        humanSurfaceReadOnly: { enabled: true },
      }) as SwarmConfig,
    });

    expect(isHumanSurfaceReadOnlyEnabled()).toBe(false);
    await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(isHumanSurfaceReadOnlyEnabled()).toBe(true);
  });

  it('exits 2 for a non-project path', async () => {
    const deps = baseDeps({ isValidProjectPath: async () => false });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/nope', yes: true }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('exits 2 with guidance when Linear is not configured', async () => {
    const deps = baseDeps({ ensureTaskSource: async () => null });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(deps.logs.join('\n')).toContain('Linear is not configured');
  });

  it('exits 2 when the config cannot be loaded', async () => {
    const deps = baseDeps({
      loadConfig: () => {
        throw new Error('bad yaml');
      },
    });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(deps.logs.join('\n')).toContain('bad yaml');
  });

  it('exits 2 when openswarm.json exists but is unreadable', async () => {
    const deps = baseDeps({
      loadRepoMetadata: async () => {
        throw new Error('corrupt metadata');
      },
    });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(deps.logs.join('\n')).toContain('corrupt metadata');
  });
});

describe('runWorkCommand — interactive picker', () => {
  it('filters the team fetch to the mapped project and runs the selection', async () => {
    const all = [
      issue({ identifier: 'INT-1', id: 'uuid-1' }),
      issue({ identifier: 'OTHER-1', id: 'uuid-o', project: { id: 'proj-x', name: 'X' } }),
    ];
    const selectIssues = vi.fn(async (candidates: LinearIssueInfo[]) => candidates);
    const deps = baseDeps({
      loadRepoMetadata: async () => ({
        schemaVersion: 1,
        linear: { projectId: '11111111-1111-4111-8111-111111111111' },
      }) as never,
      listIssues: async () => all.map((entry) => ({
        ...entry,
        project: entry.project?.id === 'proj-1'
          ? { ...entry.project, id: '11111111-1111-4111-8111-111111111111' }
          : entry.project,
      })),
      selectIssues,
    });
    const code = await runWorkCommand({ path: '/repo' }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(selectIssues).toHaveBeenCalledTimes(1);
    expect((selectIssues.mock.calls[0][0] as LinearIssueInfo[]).map((entry) => entry.identifier))
      .toEqual(['INT-1']);
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });

  it('exits 2 when the repo has no Linear project mapping', async () => {
    const deps = baseDeps({ loadRepoMetadata: async () => null });
    expect(await runWorkCommand({ path: '/repo' }, deps)).toBe(WORK_EXIT_NOT_RUN);
    expect(deps.logs.join('\n')).toContain('no Linear project mapping');
  });

  it('exits 2 quietly when the picker is aborted with Ctrl-C', async () => {
    const abort = new Error('ctrl-c');
    abort.name = 'ExitPromptError';
    const deps = baseDeps({
      loadRepoMetadata: async () => ({
        schemaVersion: 1,
        linear: { projectId: '11111111-1111-4111-8111-111111111111' },
      }) as never,
      listIssues: async () => [issue({
        project: { id: '11111111-1111-4111-8111-111111111111', name: 'OpenSwarm' },
      })],
      selectIssues: async () => {
        throw abort;
      },
    });
    expect(await runWorkCommand({ path: '/repo' }, deps)).toBe(WORK_EXIT_NOT_RUN);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('exits 2 when the picker returns an empty selection', async () => {
    const deps = baseDeps({
      loadRepoMetadata: async () => ({
        schemaVersion: 1,
        linear: { projectId: '11111111-1111-4111-8111-111111111111' },
      }) as never,
      listIssues: async () => [issue({
        project: { id: '11111111-1111-4111-8111-111111111111', name: 'OpenSwarm' },
      })],
      selectIssues: async () => [],
    });
    expect(await runWorkCommand({ path: '/repo' }, deps)).toBe(WORK_EXIT_NOT_RUN);
  });
});

describe('runWorkCommand — dry run', () => {
  it('prints the plan (branch + resume flag) and never executes', async () => {
    const deps = baseDeps({
      hasRecoverableWorktree: async (_repo, issueId) => issueId === 'uuid-INT-1',
    });
    const code = await runWorkCommand(
      { issueIds: ['INT-1', 'INT-2'], path: '/repo', dryRun: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.exec).not.toHaveBeenCalled();
    const plan = deps.outs.join('\n');
    expect(plan).toContain('INT-1');
    expect(plan).toContain('swarm/INT-1-fix-the-thing');
    expect(plan).toContain('[resume]');
    expect(plan).toContain('[fresh]');
  });

  it('emits the plan as JSON with --json', async () => {
    const deps = baseDeps();
    const code = await runWorkCommand(
      { issueIds: ['INT-1'], path: '/repo', dryRun: true, json: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_OK);
    const doc = JSON.parse(deps.outs.join('\n'));
    expect(doc.dryRun).toBe(true);
    expect(doc.plan).toEqual([expect.objectContaining({
      identifier: 'INT-1',
      branch: 'swarm/INT-1-fix-the-thing',
      resumes: false,
    })]);
  });
});

describe('runWorkCommand — confirmation gate', () => {
  it('prompts for direct-id runs and aborts on decline', async () => {
    const confirm = vi.fn(async () => false);
    const deps = baseDeps({ confirm });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo' }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('refuses headless direct-id runs without --yes', async () => {
    const deps = baseDeps({ isTTY: false });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo' }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
    expect(deps.logs.join('\n')).toContain('pass --yes');
  });

  it('treats Ctrl-C at the confirm prompt as a quiet exit 2', async () => {
    const abort = new Error('ctrl-c');
    abort.name = 'ExitPromptError';
    const deps = baseDeps({
      confirm: async () => {
        throw abort;
      },
    });
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo' }, deps))
      .toBe(WORK_EXIT_NOT_RUN);
  });
});

describe('runWorkCommand — completion delivery', () => {
  it('drains the outbox after the pool: success effects reach the deliverer', async () => {
    const deliverEffect = vi.fn(async () => undefined);
    const deps = baseDeps({ deliverEffect });
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(deliverEffect).toHaveBeenCalledTimes(1);
    const [effect, source] = deliverEffect.mock.calls[0] as unknown as [EffectClaim, ITaskSource];
    expect(effect.kind).toBe('tracker.complete');
    expect(effect.dedupeKey).toBe('complete:uuid-INT-1:attempt:1');
    expect(source).toBe(fakeSource);
    expect(deps.coordinator.closed()).toBe(true);
  });

  it('a failed drain is reported but does not change the run outcome', async () => {
    const deps = baseDeps();
    deps.coordinator.drainOutbox = async () => {
      throw new Error('linear down');
    };
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.logs.join('\n')).toContain('Completion delivery failed');
    expect(deps.coordinator.closed()).toBe(true);
  });
});

describe('runWorkCommand — abort propagation (SIGINT)', () => {
  it('first Ctrl-C aborts the pipeline signal and the run exits 130', async () => {
    let handler: (() => void) | undefined;
    const observedAborts: boolean[] = [];
    const deps = baseDeps({
      installSigintHandler: (fn) => {
        handler = fn;
        return () => undefined;
      },
    });
    deps.exec.mockImplementation(async (_ctx, _task, _path, signal?: AbortSignal) => {
      handler?.();
      observedAborts.push(!!signal?.aborted);
      return pipelineResult({ success: false, finalStatus: 'cancelled' });
    });
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_INTERRUPTED);
    expect(observedAborts).toEqual([true]);
    expect(deps.logs.join('\n')).toContain('re-run the same command to resume');
  });

  it('second Ctrl-C force-quits with 130', async () => {
    let handler: (() => void) | undefined;
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const deps = baseDeps({
      installSigintHandler: (fn) => {
        handler = fn;
        return () => undefined;
      },
      exit: exit as never,
    });
    deps.exec.mockImplementation(async () => {
      handler?.();
      expect(() => handler?.()).toThrow('exit 130');
      return pipelineResult({ success: false, finalStatus: 'cancelled' });
    });
    await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe('runWorkCommand — exit code matrix', () => {
  it('all approved → 0', async () => {
    const deps = baseDeps();
    expect(await runWorkCommand({ issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_OK);
  });

  it('any failure → 1', async () => {
    const deps = baseDeps();
    deps.exec
      .mockResolvedValueOnce(pipelineResult())
      .mockResolvedValueOnce(pipelineResult({ success: false, finalStatus: 'failed' }));
    expect(await runWorkCommand({ issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_FAILED);
  });

  it('an executor throw → 1', async () => {
    const deps = baseDeps();
    deps.exec.mockRejectedValueOnce(new Error('boom'));
    expect(await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps))
      .toBe(WORK_EXIT_FAILED);
    expect(deps.logs.join('\n')).toContain('boom');
  });

  it('superseded (owned by another process) does not count as failure → 0', async () => {
    const deps = baseDeps();
    deps.exec.mockResolvedValue(pipelineResult({ success: false, finalStatus: 'superseded' }));
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(deps.outs.join('\n')).toContain('owned by another process');
  });

  it('deferred (no current owner) remains incomplete → 1', async () => {
    const deps = baseDeps();
    deps.exec.mockResolvedValue(pipelineResult({
      success: false,
      finalStatus: 'deferred',
      retryAt: Date.now() + 30_000,
    }));
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_FAILED);
    expect(deps.outs.join('\n')).toContain('durable admission deferred until');
  });
});

describe('runWorkCommand — options plumbing', () => {
  it('runs overlapping file scopes in separate waves instead of racing two worktrees', async () => {
    let active = 0;
    let maxActive = 0;
    const deps = baseDeps({
      resolveTaskFileScope: vi.fn(async (task) => {
        task.fileScope = ['src/shared.ts'];
        return task.fileScope;
      }),
      executePipeline: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return pipelineResult();
      }),
    });

    const code = await runWorkCommand({
      issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true, concurrency: 2,
    }, deps);

    expect(code).toBe(WORK_EXIT_OK);
    expect(maxActive).toBe(1);
    expect(deps.logs.join('\n')).toContain('2 non-overlapping wave(s)');
  });

  it('defaults concurrency to min(selected, autonomous.maxConcurrentTasks ?? 4)', async () => {
    const createCoordinator = vi.fn(() => fakeCoordinator());
    const deps = baseDeps({
      createCoordinator,
      loadConfig: () => ({ autonomous: { maxConcurrentTasks: 1 } }) as unknown as SwarmConfig,
    });
    await runWorkCommand({ issueIds: ['INT-1', 'INT-2'], path: '/repo', yes: true }, deps);
    expect(createCoordinator).toHaveBeenCalledWith(expect.objectContaining({ maxActive: 1 }));
  });

  it('honors an explicit --concurrency over the config default', async () => {
    const createCoordinator = vi.fn(() => fakeCoordinator());
    const deps = baseDeps({ createCoordinator });
    await runWorkCommand(
      { issueIds: ['INT-1'], path: '/repo', yes: true, concurrency: 3 },
      deps,
    );
    expect(createCoordinator).toHaveBeenCalledWith(expect.objectContaining({ maxActive: 3 }));
  });

  it('passes the automation db override from config into the coordinator', async () => {
    const createCoordinator = vi.fn(() => fakeCoordinator());
    const deps = baseDeps({
      createCoordinator,
      loadConfig: () => ({
        autonomous: { maxConcurrentTasks: 4, automationDbPath: '/tmp/automation-test.db' },
      }) as unknown as SwarmConfig,
    });
    await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(createCoordinator).toHaveBeenCalledWith(expect.objectContaining({
      dbPath: '/tmp/automation-test.db',
    }));
  });

  it('threads --adapter into the execution context roles', async () => {
    const deps = baseDeps();
    await runWorkCommand(
      { issueIds: ['INT-1'], path: '/repo', yes: true, adapter: 'claude' },
      deps,
    );
    const ctx = deps.exec.mock.calls[0][0] as ExecutionContext;
    expect(ctx.getRolesForProject('/repo')?.worker.adapter).toBe('claude');
  });

  it('emits the final summary as parseable JSON on stdout in --json mode', async () => {
    const deps = baseDeps();
    const code = await runWorkCommand(
      { issueIds: ['INT-1'], path: '/repo', yes: true, json: true },
      deps,
    );
    expect(code).toBe(WORK_EXIT_OK);
    const doc = JSON.parse(deps.outs.join('\n'));
    expect(doc.results).toEqual([expect.objectContaining({
      identifier: 'INT-1',
      status: 'approved',
      success: true,
      worktreePreserved: false,
    })]);
    expect(doc.exitCode).toBe(WORK_EXIT_OK);
  });

  it('reroutes pipeline console.log noise to stderr while --json executes', async () => {
    const originalLog = console.log;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps = baseDeps();
      deps.exec.mockImplementation(async () => {
        // The pipeline logs to stdout; in --json mode that must land on stderr.
        console.log('pipeline noise');
        expect(console.log).not.toBe(originalLog);
        return pipelineResult();
      });
      const code = await runWorkCommand(
        { issueIds: ['INT-1'], path: '/repo', yes: true, json: true },
        deps,
      );
      expect(code).toBe(WORK_EXIT_OK);
      // stdout stayed a clean JSON document…
      expect(() => JSON.parse(deps.outs.join('\n'))).not.toThrow();
      // …the noise went to stderr, and console.log was restored afterwards.
      expect(errSpy).toHaveBeenCalledWith('pipeline noise');
      expect(console.log).toBe(originalLog);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('default log/out write to the console (stderr for diagnostics)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps = baseDeps();
      delete deps.log;
      delete deps.out;
      const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/nope' }, {
        ...deps,
        isValidProjectPath: async () => false,
      });
      expect(code).toBe(WORK_EXIT_NOT_RUN);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Not a project directory'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('default SIGINT wiring installs and removes a process listener symmetrically', async () => {
    const before = process.listenerCount('SIGINT');
    const deps = baseDeps();
    delete deps.installSigintHandler;
    const code = await runWorkCommand({ issueIds: ['INT-1'], path: '/repo', yes: true }, deps);
    expect(code).toBe(WORK_EXIT_OK);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('pure helpers', () => {
  const row = {
    task: {
      id: 'uuid-1',
      source: 'linear',
      title: 'T',
      priority: 2,
      issueId: 'uuid-1',
      issueIdentifier: 'INT-1',
      createdAt: 0,
    } as TaskItem,
    branchName: 'swarm/INT-1-t',
    resumes: false,
  };

  it('buildWorkAdmission carries the task scope into atomic cross-process admission', () => {
    expect(buildWorkAdmission(3, undefined, ['src/shared.ts'])).toEqual({
      maxConcurrent: 3,
      conflictScope: ['src/shared.ts'],
      maxFailuresPerHour: 6,
      circuitCooldownMs: 3_600_000,
    });
  });

  it('partitions overlapping and unknown task scopes into deterministic waves', () => {
    const rows = [
      { task: { ...row.task, id: 'a', fileScope: ['src/shared.ts'] } },
      { task: { ...row.task, id: 'b', fileScope: ['src/other.ts'] } },
      { task: { ...row.task, id: 'c', fileScope: ['src/shared.ts'] } },
      { task: { ...row.task, id: 'unknown', fileScope: [] } },
    ];

    expect(buildConflictFreeWaves(rows).map((wave) => wave.map(({ task }) => task.id)))
      .toEqual([['a', 'b'], ['c'], ['unknown']]);
  });

  it('summarizeSettled maps approved success to a removed worktree', () => {
    expect(summarizeSettled(row, { value: pipelineResult({ prUrl: 'https://pr/1' }) }))
      .toMatchObject({ status: 'approved', success: true, prUrl: 'https://pr/1', worktreePreserved: false });
  });

  it('summarizeSettled preserves the worktree for non-approved outcomes and errors', () => {
    expect(summarizeSettled(row, { value: pipelineResult({ success: false, finalStatus: 'rejected' }) }))
      .toMatchObject({ status: 'rejected', worktreePreserved: true });
    expect(summarizeSettled(row, { error: new Error('boom') }))
      .toMatchObject({ status: 'error', worktreePreserved: true, note: 'boom' });
  });

  it('summarizeSettled marks superseded runs as externally owned', () => {
    const summary = summarizeSettled(row, {
      value: pipelineResult({ success: false, finalStatus: 'superseded' }),
    });
    expect(summary.note).toContain('owned by another process');
    expect(summary.worktreePreserved).toBe(false);
  });

  it('summarizeSettled exposes a transient durable-admission deferral', () => {
    const retryAt = Date.parse('2026-09-01T00:00:00.000Z');
    const summary = summarizeSettled(row, {
      value: pipelineResult({ success: false, finalStatus: 'deferred', retryAt }),
    });
    expect(summary).toMatchObject({ status: 'deferred', success: false, worktreePreserved: true });
    expect(summary.note).toContain('2026-09-01T00:00:00.000Z');
  });

  it('formatWorkSummary renders one aligned row per issue', () => {
    const lines = formatWorkSummary([
      summarizeSettled(row, { value: pipelineResult({ prUrl: 'https://pr/1' }) }),
      summarizeSettled({ ...row, resumes: true }, { value: pipelineResult({ success: false, finalStatus: 'failed' }) }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('INT-1');
    expect(lines[0]).toContain('https://pr/1');
    expect(lines[0]).toContain('worktree removed');
    expect(lines[1]).toContain('worktree preserved');
    expect(lines[1]).toContain('(resumed)');
  });
});
