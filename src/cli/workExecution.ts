// ============================================
// OpenSwarm - `openswarm work` execution wiring (INT-3387)
// ============================================
//
// Builds the daemon-shaped ExecutionContext for a standalone CLI run and
// re-exports the shared tracker-effect contract. Two hard command contracts
// live here: `worktreeMode` is always on (every issue gets an isolated
// worktree + PR), and `enableDecomposition` is always off (the user picked
// concrete issues — never split them into sub-issues).

import type { EmbedBuilder } from 'discord.js';
import type {
  AgentAdapterName,
  AutonomousStartupConfig,
  DefaultRolesConfig,
  ProjectAgentConfig,
} from '../core/types.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ExecutionContext } from '../automation/runnerExecution.js';
import type { ExecutionDurabilityHooks } from '../automation/durableRunCoordinator.js';
import type { EffectClaim } from '../automation/runLedger.js';
import type { ITaskSource } from '../automation/taskSource.js';
import {
  buildCancellationEffect,
  buildCompletionEffect,
  deliverTrackerEffect,
} from '../automation/trackerEffects.js';

// The completion/cancellation outbox contract is shared with the daemon
// (src/automation/trackerEffects.ts): marker `complete:{issueId}:attempt:{n}`,
// kind `tracker.complete`. Re-exported under the command's names so the CLI
// surface reads locally while the wire format stays single-sourced.
export const buildWorkCompletionEffect = buildCompletionEffect;
export const buildWorkCancellationEffect = buildCancellationEffect;

/** Deliver one claimed outbox effect using the shared daemon delivery path. */
export async function deliverWorkCompletionEffect(
  effect: EffectClaim,
  source: ITaskSource | null,
): Promise<void> {
  return deliverTrackerEffect(effect, source);
}

/**
 * The role-resolution inputs `AutonomousRunner.getRolesForProject` reads off
 * its runner config, normalized so a pure function can mirror its behavior.
 */
export interface RolesConfigSource {
  defaultRoles?: DefaultRolesConfig;
  projectAgents?: ProjectAgentConfig[];
  workerModel?: string;
  reviewerModel?: string;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
}

/** Map the persisted config.yaml `autonomous` block onto the runner-config shape. */
export function rolesSourceFromConfig(autonomous: AutonomousStartupConfig | undefined): RolesConfigSource {
  return {
    defaultRoles: autonomous?.defaultRoles,
    projectAgents: autonomous?.projectAgents,
    workerModel: autonomous?.models?.worker,
    reviewerModel: autonomous?.models?.reviewer,
    workerTimeoutMs: autonomous?.workerTimeoutMs,
    reviewerTimeoutMs: autonomous?.reviewerTimeoutMs,
  };
}

/**
 * Pure port of AutonomousRunner.getRolesForProject (defaultRoles/projectAgents
 * merge + legacy workerModel fallback). Behavior equivalence is asserted by
 * workExecution.test.ts against the daemon's documented cases.
 */
export function resolveRolesForProject(
  cfg: RolesConfigSource,
  projectPath: string,
): DefaultRolesConfig | undefined {
  // Find per-project configuration
  const projectConfig = cfg.projectAgents?.find(
    (pa) => projectPath.includes(pa.projectPath.replace('~', '')),
  );

  if (!projectConfig?.roles && !cfg.defaultRoles) {
    // Convert from legacy configuration
    return {
      worker: {
        enabled: true,
        model: cfg.workerModel, // unset → role adapter's getDefaultModel()
        timeoutMs: cfg.workerTimeoutMs ?? 0,
      },
      reviewer: {
        enabled: true,
        model: cfg.reviewerModel, // unset → role adapter's getDefaultModel()
        timeoutMs: cfg.reviewerTimeoutMs ?? 0,
      },
    };
  }

  // Apply per-project overrides
  const base = cfg.defaultRoles || {
    // No model → each role's adapter resolves its own default (getDefaultModel).
    worker: { enabled: true, timeoutMs: 0 },
    reviewer: { enabled: true, timeoutMs: 0 },
  };

  if (!projectConfig?.roles) {
    return base;
  }

  // Merge overrides
  return {
    worker: { ...base.worker, ...projectConfig.roles.worker },
    reviewer: { ...base.reviewer, ...projectConfig.roles.reviewer },
    tester: projectConfig.roles.tester
      ? { ...base.tester, ...projectConfig.roles.tester }
      : base.tester,
    documenter: projectConfig.roles.documenter
      ? { ...base.documenter, ...projectConfig.roles.documenter }
      : base.documenter,
  } as DefaultRolesConfig;
}

/** `--adapter` overrides the worker/reviewer adapters; other roles keep theirs. */
export function applyAdapterOverride(
  roles: DefaultRolesConfig | undefined,
  adapter: AgentAdapterName | undefined,
): DefaultRolesConfig | undefined {
  if (!adapter || !roles) return roles;
  return {
    ...roles,
    worker: { ...roles.worker, adapter },
    reviewer: { ...roles.reviewer, adapter },
  };
}

/** Flatten a notifier message (string or Discord embed) into one loggable line. */
export function describeNotification(message: string | EmbedBuilder): string {
  if (typeof message === 'string') return message;
  const data = message.data ?? {};
  const fields = (data.fields ?? [])
    .map((field) => `${field.name}: ${field.value}`)
    .join(' · ');
  return [data.title, data.description, fields].filter(Boolean).join(' — ') || '[notification]';
}

export interface WorkExecutionContextOptions {
  /** The loaded config.yaml `autonomous` block (may be absent entirely). */
  autonomous?: AutonomousStartupConfig;
  repoPath: string;
  /** The other selected issues, for same-project duplicate grooming in draft. */
  peerIssues?: TaskItem[];
  /** Fenced durable-run callbacks from DurableRunCoordinator.execute. */
  durability?: ExecutionDurabilityHooks;
  /** `--adapter` override for the worker/reviewer roles. */
  adapter?: AgentAdapterName;
  /** Progress sink (default stderr) — replaces the daemon's Discord notifier. */
  log?: (line: string) => void;
}

/** Build the ExecutionContext `executePipeline` needs for a standalone CLI run. */
export function buildWorkExecutionContext(opts: WorkExecutionContextOptions): ExecutionContext {
  const autonomous = opts.autonomous;
  const log = opts.log ?? ((line: string) => console.error(line));
  const rolesSource = rolesSourceFromConfig(autonomous);
  return {
    allowedProjects: [opts.repoPath],
    plannerModel: autonomous?.decomposition?.plannerModel,
    plannerTimeoutMs: autonomous?.decomposition?.plannerTimeoutMs,
    pairMaxAttempts: autonomous?.maxAttempts ?? 3,
    // Command contract: the user picked these exact issues — never decompose.
    enableDecomposition: false,
    jobProfiles: autonomous?.jobProfiles,
    getRolesForProject: (projectPath) =>
      applyAdapterOverride(resolveRolesForProject(rolesSource, projectPath), opts.adapter),
    reportToDiscord: async (message) => {
      log(describeNotification(message));
    },
    // Command contract: isolated worktree per issue + auto PR — always on.
    worktreeMode: true,
    guards: autonomous?.guards,
    verify: autonomous?.verify,
    maxReflections: autonomous?.maxReflections,
    durability: opts.durability,
    peerIssues: opts.peerIssues,
  };
}
