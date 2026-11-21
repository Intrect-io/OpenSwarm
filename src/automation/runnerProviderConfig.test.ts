// Created: 2026-11-22
// Purpose: pin the ProviderConfigHost contract — the provider lanes reach the runner through a late-bound
//          host, the host is safe to build from the constructor, and a refused switch changes nothing (AGT-4867 slice F)
// Dependencies: runnerProviderConfig, autonomousRunner
// Test Status: passing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cron } from 'croner';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { AdapterName } from '../adapters/types.js';
import {
  applyProviderConfig,
  getAdapterSummary,
  providerSwitchViolation,
  startPeriodicReviews,
  switchProvider,
  type PeriodicReviewConfig,
  type ProviderConfigHost,
} from './runnerProviderConfig.js';

const { writeProviderOverrideMock, runPeriodicReviewMock } = vi.hoisted(() => ({
  writeProviderOverrideMock: vi.fn(),
  runPeriodicReviewMock: vi.fn(async () => null),
}));

// writeProviderOverride writes to ~/.config/openswarm/ unconditionally; never from a unit test.
vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: writeProviderOverrideMock }));
// The real resolver does OAuth + live-catalog work.
vi.mock('../agents/stageModelResolver.js', () => ({
  resolveAdapterDefaultModel: vi.fn(async (adapter: string) => `${adapter}-default`),
}));
vi.mock('../adapters/modelCatalog.js', () => ({ readCachedCatalog: () => null, writeCachedCatalog: () => {} }));
vi.mock('../coordination/periodicReview.js', () => ({ runPeriodicReview: runPeriodicReviewMock }));

const baseConfig = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
  automationLedgerMode: 'off',
  ...over,
});

function fakeHost(config: AutonomousConfig, durableRuns: ProviderConfigHost['durableRuns']): ProviderConfigHost {
  return {
    config,
    durableRuns,
    defaultModelCache: new Map(),
    lastFetchedTasks: [],
    periodicReviewJobs: [],
    orchestratorSupervisor: null,
    rateLimitUntil: 0,
    getBackgroundServiceProjects: () => [],
    scheduleNextHeartbeat: () => {},
    applyProviderConfig: () => {},
    runPeriodicReviewAcrossProjects: async () => {},
  };
}

describe('ProviderConfigHost contract (AGT-4867 slice F)', () => {
  beforeEach(() => writeProviderOverrideMock.mockClear());

  it('switchProvider remaps through the host, releases only quota retries and persists the choice', () => {
    const markReady = vi.fn(() => true);
    const listRuns = vi.fn(() => [
      { issueId: 'quota-1', lastErrorCode: 'rate_limited' },
      { issueId: 'infra-1', lastErrorCode: 'infra_error' },
    ]);
    const host = fakeHost(baseConfig({ defaultAdapter: 'codex' }), { listRuns, markReady } as unknown as ProviderConfigHost['durableRuns']);
    host.rateLimitUntil = Date.now() + 60_000;
    const apply = vi.fn();
    const heartbeat = vi.fn();
    host.applyProviderConfig = apply;
    host.scheduleNextHeartbeat = heartbeat;

    switchProvider(host, 'claude');

    expect(apply).toHaveBeenCalledWith('claude');
    expect(host.rateLimitUntil).toBe(0);
    expect(listRuns).toHaveBeenCalledWith(['RETRY_AT']);
    expect(markReady).toHaveBeenCalledTimes(1);
    expect(markReady).toHaveBeenCalledWith('quota-1');
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
  });

  it('switchProvider to the same adapter keeps the quota hold and does not re-fire the heartbeat', () => {
    const listRuns = vi.fn(() => []);
    const host = fakeHost(baseConfig({ defaultAdapter: 'codex' }), { listRuns, markReady: vi.fn() } as unknown as ProviderConfigHost['durableRuns']);
    const hold = Date.now() + 60_000;
    host.rateLimitUntil = hold;
    const heartbeat = vi.fn();
    host.scheduleNextHeartbeat = heartbeat;

    switchProvider(host, 'codex');

    expect(host.rateLimitUntil).toBe(hold);
    expect(listRuns).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('applyProviderConfig reads only config, so it is safe on a host built mid-construction', () => {
    const config = baseConfig({
      defaultAdapter: 'openrouter',
      workerModel: 'gpt-5.5-codex',
      defaultRoles: {
        worker: { enabled: true, model: 'gpt-5.5-codex' },
        reviewer: { enabled: true, adapter: 'claude', model: 'claude-opus-4-1' },
      },
    });
    const touched: string[] = [];
    // Every member but config throws on access, as an uninitialized runner field would.
    const host = new Proxy({ config } as ProviderConfigHost, {
      get(target, key) {
        if (key === 'config') return target.config;
        touched.push(String(key));
        throw new Error(`host.${String(key)} read during construction`);
      },
    });

    expect(() => applyProviderConfig(host, 'codex', false)).not.toThrow();
    expect(touched).toEqual([]);
    expect(config.defaultAdapter).toBe('codex');
    expect(config.defaultRoles?.worker.adapter).toBe('codex');
    expect(config.defaultRoles?.reviewer).toMatchObject({ adapter: 'claude', model: 'claude-opus-4-1' });
  });

  it('a refused switch check never reaches applyProviderConfig and changes no role adapter', () => {
    const config = baseConfig({
      defaultAdapter: 'codex',
      defaultRoles: { worker: { enabled: true, model: 'gpt-5.5-codex' }, reviewer: { enabled: true, model: 'gpt-5.5-codex' } },
    });
    const host = fakeHost(config, {} as ProviderConfigHost['durableRuns']);
    const apply = vi.fn();
    host.applyProviderConfig = apply;
    const before = structuredClone(config.defaultRoles);

    expect(providerSwitchViolation(host, 'claude')).toContain("'claude'");
    expect(apply).not.toHaveBeenCalled();
    expect(config.defaultAdapter).toBe('codex');
    expect(config.defaultRoles).toEqual(before);
    expect(writeProviderOverrideMock).not.toHaveBeenCalled();
  });

  it('providerSwitchViolation reads allowDelegatedAdapters from the current host config', () => {
    const host = fakeHost(baseConfig(), {} as ProviderConfigHost['durableRuns']);
    expect(providerSwitchViolation(host, 'claude')).toContain("'claude'");
    host.config.allowDelegatedAdapters = true;
    expect(providerSwitchViolation(host, 'claude')).toBeNull();
  });

  it('startPeriodicReviews stops the previous jobs and fires reviews through the host', () => {
    const host = fakeHost(baseConfig({ periodicReviews: [{ profile: 'hygiene', schedule: '0 0 1 1 *' }] }), {} as ProviderConfigHost['durableRuns']);
    const previous = { stop: vi.fn() } as unknown as Cron;
    host.periodicReviewJobs = [previous];

    startPeriodicReviews(host);
    try {
      expect(previous.stop).toHaveBeenCalledTimes(1);
      expect(host.periodicReviewJobs).toHaveLength(1);
      expect(host.periodicReviewJobs[0]).not.toBe(previous);
    } finally {
      for (const job of host.periodicReviewJobs) job.stop();
    }
  });

  it('getAdapterSummary resolves an omitted model with the host cache', async () => {
    const host = fakeHost(baseConfig({ defaultAdapter: 'codex', reviewerModel: 'explicit-reviewer' }), {} as ProviderConfigHost['durableRuns']);
    const summary = await getAdapterSummary(host);
    expect(summary.defaultAdapter).toBe('codex');
    expect(summary.worker).toMatchObject({ adapter: 'codex', model: 'codex-default', enabled: true });
    expect(summary.reviewer).toMatchObject({ adapter: 'codex', model: 'explicit-reviewer' });
  });
});

describe('the runner builds its provider host lazily and late-bound (AGT-4867 slice F)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-provider-host-'));
    for (const [key, file] of [
      ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
      ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
      ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
    ] as const) vi.stubEnv(key, join(root, file));
    writeProviderOverrideMock.mockClear();
    runPeriodicReviewMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  type Internal = {
    config: AutonomousConfig;
    durableRuns: DurableRunCoordinator;
    rateLimitUntil: number;
    providerConfigHostCache: ProviderConfigHost | undefined;
    providerConfigHost(): ProviderConfigHost;
    applyProviderConfig(adapter: AdapterName, overrideRoleAdapters?: boolean): void;
    scheduleNextHeartbeat(): void;
    getBackgroundServiceProjects(): string[];
    runPeriodicReviewAcrossProjects(review: PeriodicReviewConfig): Promise<void>;
    providerSwitchViolation(adapter: AdapterName): string | null;
    switchProvider(adapter: AdapterName): void;
  };

  async function makeRunner(over: Partial<AutonomousConfig> = {}): Promise<Internal> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    return new AutonomousRunner(baseConfig(over)) as unknown as Internal;
  }

  it('is built from the constructor before durableRuns exists, and its getters see the later members', async () => {
    const runner = await makeRunner({
      defaultAdapter: 'codex',
      defaultRoles: {
        worker: { enabled: true, model: 'gpt-5.5-codex' },
        reviewer: { enabled: true, adapter: 'claude', model: 'claude-opus-4-1' },
      },
    });
    // The constructor's startup normalization ran through the host and cached it.
    const host = runner.providerConfigHostCache;
    expect(host).toBeDefined();
    expect(runner.providerConfigHost()).toBe(host);
    // Startup never overrides an explicit role adapter; a role without one takes the default.
    expect(runner.config.defaultRoles?.worker.adapter).toBe('codex');
    expect(runner.config.defaultRoles?.reviewer.adapter).toBe('claude');
    expect(runner.config.defaultRoles?.reviewer.model).toBe('claude-opus-4-1');
    // durableRuns did not exist when the host was built; the getter reads it now.
    expect(host!.durableRuns).toBe(runner.durableRuns);
    expect(host!.config).toBe(runner.config);
  });

  it('honours runner members reassigned after the host is built', async () => {
    const runner = await makeRunner({ defaultAdapter: 'codex' });
    const apply = vi.fn();
    const heartbeat = vi.fn();
    runner.applyProviderConfig = apply;
    runner.scheduleNextHeartbeat = heartbeat;
    const listRuns = vi.fn(() => [{ issueId: 'quota-1', lastErrorCode: 'rate_limited' }]);
    const markReady = vi.fn(() => true);
    runner.durableRuns = { listRuns, markReady } as unknown as DurableRunCoordinator;
    runner.rateLimitUntil = Date.now() + 60_000;

    runner.switchProvider('claude');

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toBe('claude');
    expect(markReady).toHaveBeenCalledWith('quota-1');
    expect(runner.rateLimitUntil).toBe(0);
    expect(heartbeat).toHaveBeenCalledTimes(1);

    runner.getBackgroundServiceProjects = () => ['/a', '/b'];
    await runner.runPeriodicReviewAcrossProjects({ profile: 'security', schedule: '0 0 1 1 *' });
    expect(runPeriodicReviewMock).toHaveBeenCalledTimes(2);
    expect(runPeriodicReviewMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ repository: '/a', taskId: 'periodic:security' }));
    expect(runPeriodicReviewMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ repository: '/b' }));
  });

  it('a switch refused by providerSwitchViolation leaves the role adapters unchanged', async () => {
    const runner = await makeRunner({
      defaultAdapter: 'codex',
      workerModel: 'gpt-5.5-codex',
      defaultRoles: {
        worker: { enabled: true, model: 'gpt-5.5-codex' },
        reviewer: { enabled: true, model: 'gpt-5.5-codex' },
      },
    });
    const before = structuredClone({ roles: runner.config.defaultRoles, workerModel: runner.config.workerModel });
    const switchSpy = vi.spyOn(runner, 'switchProvider');

    // The dashboard toggle's flow (web.ts): ask first, switch only when nothing refuses.
    const refused = runner.providerSwitchViolation('claude');
    if (!refused) runner.switchProvider('claude');

    expect(refused).toContain("'claude'");
    expect(switchSpy).not.toHaveBeenCalled();
    expect(runner.config.defaultAdapter).toBe('codex');
    expect(runner.config.defaultRoles?.worker.adapter).toBe('codex');
    expect(runner.config.defaultRoles?.reviewer.adapter).toBe('codex');
    expect({ roles: runner.config.defaultRoles, workerModel: runner.config.workerModel }).toEqual(before);
    expect(writeProviderOverrideMock).not.toHaveBeenCalled();
  });
});
