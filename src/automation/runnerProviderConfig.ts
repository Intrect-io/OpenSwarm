// Created: 2026-11-22
// Purpose: the runner's provider and background-service configuration — periodic review crons, the
//          orchestrator supervisor start, the dashboard adapter summary, provider model remapping and the
//          live provider switch — moved out of autonomousRunner.ts as host-taking functions (AGT-4867 slice F)
// Dependencies: adapters (modelCompat, unattendedPolicy, reviewerIndependence), agents/stageModelResolver,
//               coordination (orchestratorConfig, orchestratorSupervisor, periodicReview), core/providerOverride,
//               agents/instructionCapsule, runnerExecution (task source)
// Test Status: autonomousRunner.coverage/enable tests, web.provider/service tests (runner surface),
//              runnerProviderConfig.test.ts (host contract, construction safety, late binding)

import { Cron } from 'croner';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { resolveOrchestratorConfig } from '../coordination/orchestratorConfig.js';
import { OrchestratorSupervisor } from '../coordination/orchestratorSupervisor.js';
import { buildInstructionCapsule } from '../agents/instructionCapsule.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import { providerSwitchViolation as delegatedAdapterViolation } from '../adapters/unattendedPolicy.js';
import { providerSwitchFamilyViolation } from '../adapters/reviewerIndependence.js';
import { mapModelForProvider as mapModelForAdapter } from '../adapters/modelCompat.js';
import type { ModelRole } from '../adapters/modelCompat.js';
import type { AdapterName } from '../adapters/types.js';
import { getTaskSource } from './runnerExecution.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { AutonomousConfig } from './runnerTypes.js';

export type PeriodicReviewConfig = NonNullable<AutonomousConfig['periodicReviews']>[number];

/**
 * What the provider/background-service lanes need from the runner. The runner builds it
 * lazily (applyProviderConfig runs from its constructor) and every member is read at call
 * time: state through getters/setters, and every method through the runner itself, so a
 * test (or a later reassignment) of a runner member — `scheduleNextHeartbeat`,
 * `applyProviderConfig`, `getBackgroundServiceProjects`, `durableRuns.listRuns`, ... — is
 * honoured exactly as when this code lived on the class. Building the host touches no
 * member; only `config` is read while the constructor is still running.
 */
export interface ProviderConfigHost {
  readonly config: AutonomousConfig;
  readonly durableRuns: Pick<DurableRunCoordinator, 'listRuns' | 'markReady'>;
  /** Adapter default-model cache for the dashboard PAIR bar (INT-2393). */
  readonly defaultModelCache: Map<string, Promise<string | undefined>>;
  readonly lastFetchedTasks: TaskItem[];
  periodicReviewJobs: Cron[];
  orchestratorSupervisor: OrchestratorSupervisor | null;
  rateLimitUntil: number;
  getBackgroundServiceProjects(): string[];
  scheduleNextHeartbeat(): void;
  applyProviderConfig(adapter: AdapterName, overrideRoleAdapters?: boolean): void;
  runPeriodicReviewAcrossProjects(review: PeriodicReviewConfig): Promise<void>;
}

export function startPeriodicReviews(host: ProviderConfigHost): void {
  for (const job of host.periodicReviewJobs) job.stop();
  host.periodicReviewJobs = [];
  for (const review of host.config.periodicReviews ?? []) {
    const cron = new Cron(review.schedule, () => {
      void host.runPeriodicReviewAcrossProjects(review).catch((error) =>
        console.error(`[PeriodicReview] ${review.profile} failed:`, error));
    });
    host.periodicReviewJobs.push(cron);
  }
}

export async function runPeriodicReviewAcrossProjects(host: ProviderConfigHost, review: PeriodicReviewConfig): Promise<void> {
  const { runPeriodicReview } = await import('../coordination/periodicReview.js');
  const projects = host.getBackgroundServiceProjects();
  for (const repository of projects) {
    await runPeriodicReview({
      repository,
      taskId: `periodic:${review.profile}`,
      profile: review.profile,
      adapter: review.adapter,
    });
  }
}

export function startOrchestrator(host: ProviderConfigHost): void {
  const config = resolveOrchestratorConfig(host.config);
  if (!config?.enabled) return;

  const trackerSource = getTaskSource();
  const getCachedIssue = (issueIdOrIdentifier: string) => {
    const requested = issueIdOrIdentifier.toLowerCase();
    const task = host.lastFetchedTasks.find((candidate) =>
      candidate.issueId?.toLowerCase() === requested
      || candidate.issueIdentifier?.toLowerCase() === requested
      || candidate.id.toLowerCase() === requested);
    const issueId = task?.issueId ?? task?.id;
    if (!task || !issueId) return undefined;
    return {
      issueId,
      identifier: task.issueIdentifier ?? issueId,
      title: task.title,
      state: task.linearState,
      priority: task.priority,
      blockedBy: task.blockedBy,
    };
  };
  const tracker = trackerSource ? {
    getCachedIssue,
    resolveIssue: async (issueIdOrIdentifier: string) => {
      const cached = getCachedIssue(issueIdOrIdentifier);
      if (cached) return { issueId: cached.issueId, identifier: cached.identifier, source: 'cache' as const };
      if (!trackerSource.resolveIssue) return null;
      const resolved = await trackerSource.resolveIssue(issueIdOrIdentifier);
      if (!resolved.ok) throw new Error(`Tracker issue lookup failed: ${resolved.error}`);
      return resolved.issue ? {
        issueId: resolved.issue.id,
        identifier: resolved.issue.identifier,
        source: 'tracker' as const,
      } : null;
    },
    addComment: (issueId: string, body: string, idempotencyKey: string) =>
      trackerSource.addComment(issueId, body, idempotencyKey),
  } : undefined;

  const supervisor = new OrchestratorSupervisor({
    config,
    policy: host.config.mcpPolicies?.orchestrator,
    getRepositories: () => host.getBackgroundServiceProjects(),
    buildInstructionCapsule,
    tracker,
  });
  try {
    supervisor.start();
    host.orchestratorSupervisor = supervisor;
    console.log(
      `[Orchestrator] supervisor enabled (${config.eventDriven ? 'events' : 'cron-only'}`
      + `${config.schedule ? `, ${config.schedule}` : ''}; ${config.adapter ?? 'daemon-default'}/${config.model ?? 'adapter-default'})`,
    );
  } catch (error) {
    // A bad optional schedule must not tear down the worker heartbeat after it
    // has already started. No listener was registered if Cron construction failed.
    console.error('[Orchestrator] supervisor disabled: invalid lifecycle configuration:', error);
    void supervisor.stop();
  }
}

export async function getAdapterSummary(host: ProviderConfigHost) {
  const defaultAdapter = host.config.defaultAdapter ?? 'codex';
  const defaultRoles = host.config.defaultRoles;
  const workerAdapter = defaultRoles?.worker?.adapter ?? defaultAdapter;
  const reviewerAdapter = defaultRoles?.reviewer?.adapter ?? defaultAdapter;

  return {
    defaultAdapter,
    worker: {
      adapter: workerAdapter,
      // Resolve the adapter's real default when config omits the model, so the
      // dashboard's PAIR bar shows what's running instead of "-". (INT-2393)
      model: defaultRoles?.worker?.model ?? host.config.workerModel
        ?? await resolveAdapterDefaultModel(workerAdapter, host.defaultModelCache),
      enabled: defaultRoles?.worker?.enabled !== false,
    },
    reviewer: {
      adapter: reviewerAdapter,
      model: defaultRoles?.reviewer?.model ?? host.config.reviewerModel
        ?? await resolveAdapterDefaultModel(reviewerAdapter, host.defaultModelCache),
      enabled: defaultRoles?.reviewer?.enabled !== false,
    },
    tester: defaultRoles?.tester ? {
      adapter: defaultRoles.tester.adapter ?? defaultAdapter,
      model: defaultRoles.tester.model,
      enabled: defaultRoles.tester.enabled !== false,
    } : undefined,
    documenter: defaultRoles?.documenter ? {
      adapter: defaultRoles.documenter.adapter ?? defaultAdapter,
      model: defaultRoles.documenter.model,
      enabled: defaultRoles.documenter.enabled !== false,
    } : undefined,
  };
}

export function applyProviderConfig(host: ProviderConfigHost, adapter: AdapterName, overrideRoleAdapters = true): void {
  // On a provider switch, keep the model only if it clearly belongs to the new
  // provider; otherwise drop it (undefined) so the target adapter resolves its
  // own default via getDefaultModel(). Shared with the planner's model guard
  // (src/adapters/modelCompat.ts) so both stay in sync. (INT-2510)
  const mapModelForProvider = (model: string | undefined, role?: ModelRole): string | undefined =>
    mapModelForAdapter(adapter, model, role);

  host.config.defaultAdapter = adapter;

  if (host.config.defaultRoles) {
    // The role NAME travels with the model. Without it every entry here
    // mapped anonymously, so an adapter that resolves per role — cursor, whose
    // catalogue shares no id with any other provider — could not tell the
    // worker from the reviewer and gave both the same model. That is the role
    // split going missing at the one call site whose entire job is to preserve
    // it. (AGT-4273)
    const roleConfig = <T extends { adapter?: AdapterName; model?: string }>(role: T, roleName: ModelRole): T => {
      if (!overrideRoleAdapters && role.adapter) return role;
      return {
        ...role,
        adapter,
        model: mapModelForProvider(role.model, roleName),
      };
    };
    host.config.defaultRoles.worker = {
      ...roleConfig(host.config.defaultRoles.worker, 'worker'),
    };
    host.config.defaultRoles.reviewer = {
      ...roleConfig(host.config.defaultRoles.reviewer, 'reviewer'),
    };

    if (host.config.defaultRoles.tester) {
      host.config.defaultRoles.tester = {
        ...roleConfig(host.config.defaultRoles.tester, 'tester'),
      };
    }
    if (host.config.defaultRoles.documenter) {
      host.config.defaultRoles.documenter = {
        ...roleConfig(host.config.defaultRoles.documenter, 'documenter'),
      };
    }
    if (host.config.defaultRoles.auditor) {
      host.config.defaultRoles.auditor = {
        ...roleConfig(host.config.defaultRoles.auditor, 'auditor'),
      };
    }
    if (host.config.defaultRoles['skill-documenter']) {
      host.config.defaultRoles['skill-documenter'] = {
        ...roleConfig(host.config.defaultRoles['skill-documenter'], 'skill-documenter'),
      };
    }
  }

  if (host.config.workerModel) {
    host.config.workerModel = mapModelForProvider(host.config.workerModel, 'worker');
  }
  if (host.config.reviewerModel) {
    host.config.reviewerModel = mapModelForProvider(host.config.reviewerModel, 'reviewer');
  }
  // The decomposition planner is a role too. Leaving it unmapped sent the
  // config's codex id straight into `claude -p --model gpt-5.5` — a fast 404
  // that killed EVERY decomposition on the new provider. (INT-2510)
  if (host.config.plannerModel) {
    host.config.plannerModel = mapModelForProvider(host.config.plannerModel, 'planner');
  }

  // jobProfiles ALSO pin per-role models (config's light/heavy → e.g. qwen), and getModelForRole
  // gives the profile model precedence over defaultRoles. Remapping only defaultRoles left every
  // estimate-matched task on its old provider's model → "I switched to Codex but it still uses the
  // old provider". Remap the profiles too: an incompatible id becomes undefined so the adapter
  // falls back to its OWN default model.
  if (host.config.jobProfiles) {
    for (const profile of host.config.jobProfiles) {
      if (!profile.roles) continue;
      for (const role of Object.keys(profile.roles) as Array<keyof typeof profile.roles>) {
        const mapped = mapModelForProvider(profile.roles[role], role);
        if (mapped === undefined) delete profile.roles[role];
        else profile.roles[role] = mapped;
      }
    }
  }
}

/**
 * Why this runner may not be switched to `adapter`, or null. A delegated CLI owns its tool loop,
 * so the fences the daemon refused to start without (AGT-4444) would not reach it; the operator's
 * `allowDelegatedAdapters` is the only way past. Callers that take the adapter from outside the
 * process (the dashboard toggle, `openswarm provider`) ask this before `switchProvider`.
 */
export function providerSwitchViolation(host: ProviderConfigHost, adapter: AdapterName): string | null {
  return delegatedAdapterViolation(adapter, host.config.allowDelegatedAdapters) ?? providerSwitchFamilyViolation(adapter); // nor same-family review (#886)
}

export function switchProvider(host: ProviderConfigHost, adapter: AdapterName): void {
  const previousAdapter = host.config.defaultAdapter ?? 'codex';
  host.applyProviderConfig(adapter);

  // A provider quota belongs to the provider that reported it. Keeping the
  // old reset timestamp after an explicit provider switch leaves every free
  // scheduler slot idle even though the replacement provider is available.
  // Only release quota-paused runs; task/infra failures and human gates keep
  // their durable state.
  if (adapter !== previousAdapter) {
    host.rateLimitUntil = 0;
    for (const run of host.durableRuns.listRuns(['RETRY_AT'])) {
      if (run.lastErrorCode === 'rate_limited') host.durableRuns.markReady(run.issueId);
    }
    host.scheduleNextHeartbeat();
  }

  // Persist the choice so a daemon restart keeps it (in-memory switch was lost every restart).
  writeProviderOverride(adapter);
  console.log(`[AutonomousRunner] Provider switched: ${adapter.replace(/[\r\n]/g, '')}`);
}
