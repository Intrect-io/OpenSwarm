import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { EmbedBuilder } from 'discord.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { ITaskSource } from '../automation/taskSource.js';
import type { EffectClaim, EffectInput } from '../automation/runLedger.js';
import { resetTaskStateStoreForTests } from '../taskState/store.js';
import { setTaskSource } from '../automation/runnerExecution.js';
import {
  isCancellationEffectPayload,
  isCompletionEffectPayload,
  type CancellationEffectPayload,
  type CompletionEffectPayload,
} from '../automation/trackerEffects.js';
import {
  applyAdapterOverride,
  buildWorkCancellationEffect,
  buildWorkCompletionEffect,
  buildWorkExecutionContext,
  deliverWorkCompletionEffect,
  describeNotification,
  resolveRolesForProject,
  rolesSourceFromConfig,
} from './workExecution.js';

// Local-state writes (markTaskBacklog/markTaskDone projections) must never
// touch the real ~/.openswarm/task-state.json from a unit test.
const stateDir = mkdtempSync(join(tmpdir(), 'openswarm-work-exec-test-'));
process.env.OPENSWARM_TASK_STATE_FILE = join(stateDir, 'task-state.json');

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'uuid-1',
    source: 'linear',
    title: 'Fix the thing',
    priority: 2,
    issueId: 'uuid-1',
    issueIdentifier: 'INT-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    success: true,
    sessionId: 'sess-1',
    stages: [],
    finalStatus: 'approved',
    totalDuration: 65_000,
    iterations: 2,
    ...overrides,
  };
}

function mockSource(overrides: Partial<Record<keyof ITaskSource, unknown>> = {}): ITaskSource {
  return {
    kind: 'linear',
    fetchTasks: vi.fn(async () => []),
    createTask: vi.fn(),
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => undefined),
    getExecutionComments: vi.fn(async () => []),
    createSubIssue: vi.fn(),
    logPairStart: vi.fn(async () => undefined),
    logPairComplete: vi.fn(async () => undefined),
    logBlocked: vi.fn(async () => undefined),
    logStuck: vi.fn(async () => undefined),
    unstick: vi.fn(async () => undefined),
    logHalt: vi.fn(async () => undefined),
    markAsDecomposed: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ITaskSource;
}

function claimOf(effect: EffectInput): EffectClaim {
  return {
    ...effect,
    id: 1,
    issueId: 'uuid-1',
    attemptNo: 1,
    status: 'pending',
    attempts: 1,
    ownerInstanceId: 'test-owner',
    deliveryToken: 'token',
    leaseExpiresAt: Date.now() + 60_000,
  } as unknown as EffectClaim;
}

beforeEach(() => {
  resetTaskStateStoreForTests();
});

describe('resolveRolesForProject mirrors AutonomousRunner.getRolesForProject (INT-3387)', () => {
  it('falls back to the legacy worker/reviewer model config when nothing else is set', () => {
    const roles = resolveRolesForProject(
      { workerModel: 'legacy-worker', reviewerModel: 'legacy-reviewer', workerTimeoutMs: 111 },
      '/Users/u/dev/Repo',
    );
    expect(roles).toEqual({
      worker: { enabled: true, model: 'legacy-worker', timeoutMs: 111 },
      reviewer: { enabled: true, model: 'legacy-reviewer', timeoutMs: 0 },
    });
  });

  it('returns defaultRoles untouched when no projectAgents entry matches', () => {
    const defaultRoles = {
      worker: { enabled: true, model: 'base-w', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'base-r', timeoutMs: 0 },
    };
    expect(resolveRolesForProject({ defaultRoles }, '/Users/u/dev/Repo')).toEqual(defaultRoles);
  });

  it('matches projectAgents by tilde-stripped path substring and merges role overrides', () => {
    const roles = resolveRolesForProject({
      defaultRoles: {
        worker: { enabled: true, model: 'base-w', timeoutMs: 5 },
        reviewer: { enabled: true, model: 'base-r', timeoutMs: 0 },
        tester: { enabled: false, timeoutMs: 0 },
      },
      projectAgents: [{
        projectPath: '~/dev/Repo',
        roles: {
          worker: { model: 'proj-w' },
          tester: { enabled: true },
        },
      }],
    }, '/Users/u/dev/Repo');
    expect(roles).toEqual({
      worker: { enabled: true, model: 'proj-w', timeoutMs: 5 },
      reviewer: { enabled: true, model: 'base-r', timeoutMs: 0 },
      tester: { enabled: true, timeoutMs: 0 },
      documenter: undefined,
    });
  });

  it('uses the built-in modelless base when projectAgents overrides exist without defaultRoles', () => {
    const roles = resolveRolesForProject({
      projectAgents: [{ projectPath: '/dev/Repo', roles: { worker: { model: 'proj-w' } } }],
    }, '/Users/u/dev/Repo');
    expect(roles?.worker).toEqual({ enabled: true, timeoutMs: 0, model: 'proj-w' });
    expect(roles?.reviewer).toEqual({ enabled: true, timeoutMs: 0 });
  });

  it('a matching projectAgents entry without roles yields the base roles', () => {
    const defaultRoles = {
      worker: { enabled: true, model: 'base-w', timeoutMs: 0 },
      reviewer: { enabled: true, timeoutMs: 0 },
    };
    expect(resolveRolesForProject(
      { defaultRoles, projectAgents: [{ projectPath: '/dev/Repo' }] },
      '/Users/u/dev/Repo',
    )).toEqual(defaultRoles);
  });
});

describe('rolesSourceFromConfig', () => {
  it('maps the config.yaml autonomous block onto the runner-config shape', () => {
    expect(rolesSourceFromConfig({
      enabled: true,
      pairMode: true,
      schedule: '* * * * *',
      maxAttempts: 3,
      allowedProjects: [],
      models: { worker: 'w-model', reviewer: 'r-model' },
      workerTimeoutMs: 1,
      reviewerTimeoutMs: 2,
    })).toEqual({
      defaultRoles: undefined,
      projectAgents: undefined,
      workerModel: 'w-model',
      reviewerModel: 'r-model',
      workerTimeoutMs: 1,
      reviewerTimeoutMs: 2,
    });
    expect(rolesSourceFromConfig(undefined)).toEqual({
      defaultRoles: undefined,
      projectAgents: undefined,
      workerModel: undefined,
      reviewerModel: undefined,
      workerTimeoutMs: undefined,
      reviewerTimeoutMs: undefined,
    });
  });
});

describe('applyAdapterOverride', () => {
  const roles = {
    worker: { enabled: true, adapter: 'codex' as const, timeoutMs: 0 },
    reviewer: { enabled: true, timeoutMs: 0 },
    tester: { enabled: true, adapter: 'codex' as const, timeoutMs: 0 },
  };

  it('overrides worker and reviewer adapters only', () => {
    const overridden = applyAdapterOverride(roles, 'claude');
    expect(overridden?.worker.adapter).toBe('claude');
    expect(overridden?.reviewer.adapter).toBe('claude');
    expect(overridden?.tester?.adapter).toBe('codex');
  });

  it('is a no-op without an adapter or without roles', () => {
    expect(applyAdapterOverride(roles, undefined)).toBe(roles);
    expect(applyAdapterOverride(undefined, 'claude')).toBeUndefined();
  });
});

describe('describeNotification', () => {
  it('passes strings through', () => {
    expect(describeNotification('hello')).toBe('hello');
  });

  it('flattens an embed into title/description/fields', () => {
    const embed = new EmbedBuilder()
      .setTitle('Pipeline start')
      .setDescription('desc')
      .addFields({ name: 'Task', value: 'T' }, { name: 'Issue', value: 'INT-1' });
    expect(describeNotification(embed)).toBe('Pipeline start — desc — Task: T · Issue: INT-1');
  });

  it('falls back to a placeholder for an empty embed', () => {
    expect(describeNotification(new EmbedBuilder())).toBe('[notification]');
  });
});

describe('buildWorkExecutionContext (INT-3387)', () => {
  it('pins the command contract: worktreeMode on, decomposition off, repo-only scope', () => {
    const ctx = buildWorkExecutionContext({ repoPath: '/repo' });
    expect(ctx.worktreeMode).toBe(true);
    expect(ctx.enableDecomposition).toBe(false);
    expect(ctx.allowedProjects).toEqual(['/repo']);
    expect(ctx.pairMaxAttempts).toBe(3);
  });

  it('maps config.autonomous knobs (maxAttempts, planner, guards, verify, profiles)', () => {
    const ctx = buildWorkExecutionContext({
      repoPath: '/repo',
      autonomous: {
        enabled: true,
        pairMode: true,
        schedule: '* * * * *',
        maxAttempts: 5,
        allowedProjects: ['/elsewhere'],
        decomposition: {
          enabled: true,
          thresholdMinutes: 30,
          plannerModel: 'planner-m',
          plannerTimeoutMs: 1234,
        },
        guards: { qualityGate: true } as never,
        verify: { enabled: true, blockOnNewFailures: true, maxCommands: 3 },
        maxReflections: 2,
        jobProfiles: [],
      },
    });
    expect(ctx.pairMaxAttempts).toBe(5);
    expect(ctx.plannerModel).toBe('planner-m');
    expect(ctx.plannerTimeoutMs).toBe(1234);
    expect(ctx.guards).toEqual({ qualityGate: true });
    expect(ctx.verify).toEqual({ enabled: true, blockOnNewFailures: true, maxCommands: 3 });
    expect(ctx.maxReflections).toBe(2);
    expect(ctx.jobProfiles).toEqual([]);
    // Decomposition stays off even when the daemon config enables it.
    expect(ctx.enableDecomposition).toBe(false);
    // The command scopes execution to the one repo it was pointed at.
    expect(ctx.allowedProjects).toEqual(['/repo']);
  });

  it('routes notifications to the injected log and applies the adapter override to roles', async () => {
    const lines: string[] = [];
    const ctx = buildWorkExecutionContext({
      repoPath: '/repo',
      adapter: 'claude',
      log: (line) => lines.push(line),
    });
    await ctx.reportToDiscord('progress line');
    expect(lines).toEqual(['progress line']);
    const roles = ctx.getRolesForProject('/repo');
    expect(roles?.worker.adapter).toBe('claude');
    expect(roles?.reviewer.adapter).toBe('claude');
  });
});

describe('completion effect wire contract (must match the daemon outbox)', () => {
  it('builds kind tracker.complete with marker complete:{issueId}:attempt:{n}', () => {
    const result = pipelineResult({
      taskContext: { projectPath: '/repo' },
      totalCost: { costUsd: 1.5 } as never,
    });
    const effect = buildWorkCompletionEffect(task(), result, 3);
    expect(effect.kind).toBe('tracker.complete');
    expect(effect.dedupeKey).toBe('complete:uuid-1:attempt:3');
    const payload = effect.payload as CompletionEffectPayload;
    expect(payload.version).toBe(1);
    expect(payload.marker).toBe('complete:uuid-1:attempt:3');
    expect(payload.stats.idempotencyMarker).toBe('complete:uuid-1:attempt:3');
    expect(payload.stats.attempts).toBe(2);
    expect(payload.stats.duration).toBe(65);
    expect(payload.projectPath).toBe('/repo');
    expect(payload.costUsd).toBe(1.5);
    // The daemon's payload guard must accept what the CLI enqueues.
    expect(isCompletionEffectPayload(payload)).toBe(true);
  });

  it('falls back to task.id when issueId is absent', () => {
    const effect = buildWorkCompletionEffect(task({ issueId: undefined }), pipelineResult(), 1);
    expect(effect.dedupeKey).toBe('complete:uuid-1:attempt:1');
  });

  it('builds kind tracker.cancel with marker cancel:{issueId}:attempt:{n} and a frozen marker comment', () => {
    const effect = buildWorkCancellationEffect(task(), 2);
    expect(effect.kind).toBe('tracker.cancel');
    expect(effect.dedupeKey).toBe('cancel:uuid-1:attempt:2');
    const payload = effect.payload as CancellationEffectPayload;
    expect(payload.version).toBe(1);
    expect(payload.marker).toBe('cancel:uuid-1:attempt:2');
    expect(payload.comment).toContain('<!-- openswarm-effect:cancel:uuid-1:attempt:2 -->');
    expect(isCancellationEffectPayload(payload)).toBe(true);
  });
});

describe('deliverWorkCompletionEffect (idempotent delivery)', () => {
  it('logs the full completion when the marker comment is absent', async () => {
    const source = mockSource();
    const effect = buildWorkCompletionEffect(task(), pipelineResult(), 1);
    await deliverWorkCompletionEffect(claimOf(effect), source);
    expect(source.logPairComplete).toHaveBeenCalledTimes(1);
    expect(source.logPairComplete).toHaveBeenCalledWith(
      'uuid-1',
      'complete:uuid-1:attempt:1',
      expect.objectContaining({ idempotencyMarker: 'complete:uuid-1:attempt:1' }),
    );
    expect(source.updateState).not.toHaveBeenCalled();
  });

  it('reapplies only the Done transition when the marker comment already exists', async () => {
    const source = mockSource({
      getExecutionComments: vi.fn(async () => [
        { body: 'done!\n\n<!-- openswarm-effect:complete:uuid-1:attempt:1 -->', createdAt: '2026-01-01' },
      ]),
    });
    const effect = buildWorkCompletionEffect(task(), pipelineResult(), 1);
    await deliverWorkCompletionEffect(claimOf(effect), source);
    expect(source.updateState).toHaveBeenCalledWith('uuid-1', 'Done');
    expect(source.logPairComplete).not.toHaveBeenCalled();
  });

  it('throws when the tracker refuses the Done reconciliation (effect stays queued)', async () => {
    const source = mockSource({
      getExecutionComments: vi.fn(async () => [
        { body: '<!-- openswarm-effect:complete:uuid-1:attempt:1 -->', createdAt: '2026-01-01' },
      ]),
      updateState: vi.fn(async () => false),
    });
    const effect = buildWorkCompletionEffect(task(), pipelineResult(), 1);
    await expect(deliverWorkCompletionEffect(claimOf(effect), source))
      .rejects.toThrow(/refused Done reconciliation/);
  });

  it('throws without a task source (delivery must retry, not silently drop)', async () => {
    const effect = buildWorkCompletionEffect(task(), pipelineResult(), 1);
    await expect(deliverWorkCompletionEffect(claimOf(effect), null))
      .rejects.toThrow(/Task source unavailable/);
  });

  it('rejects unknown effect kinds and malformed payloads', async () => {
    await expect(deliverWorkCompletionEffect(
      claimOf({ kind: 'tracker.unknown', dedupeKey: 'k', payload: {} }),
      mockSource(),
    )).rejects.toThrow(/Unsupported automation effect/);
    await expect(deliverWorkCompletionEffect(
      claimOf({ kind: 'tracker.complete', dedupeKey: 'k', payload: { version: 2 } }),
      mockSource(),
    )).rejects.toThrow(/Unsupported automation effect/);
    await expect(deliverWorkCompletionEffect(
      claimOf({ kind: 'tracker.cancel', dedupeKey: 'k', payload: { nope: true } }),
      mockSource(),
    )).rejects.toThrow(/Invalid automation effect payload/);
  });

  it('delivers a cancellation through the registered task source with the frozen comment', async () => {
    const source = mockSource();
    setTaskSource(source); // syncCancellationState routes through the module-global source
    const effect = buildWorkCancellationEffect(task(), 1);
    await deliverWorkCompletionEffect(claimOf(effect), source);
    expect(source.updateState).toHaveBeenCalledWith('uuid-1', 'Backlog');
    expect(source.addComment).toHaveBeenCalledWith(
      'uuid-1',
      expect.stringContaining('<!-- openswarm-effect:cancel:uuid-1:attempt:1 -->'),
      'cancel:uuid-1:attempt:1',
    );
  });
});
