// ============================================
// OpenSwarm - Configuration
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import YAML from 'yaml';
import type { SwarmConfig, AgentSession, LongRunningMonitorConfig, ConflictResolverConfig, McpConfig } from './types.js';
import { setTimeWindowConfig, DEFAULT_TIME_WINDOW } from '../support/timeWindow.js';
import { c, status } from '../support/colors.js';

// Constants

const CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'config.json'] as const;

// Directories searched for config, in priority order.
// 1. $OPENSWARM_CONFIG — explicit file path (highest priority, handled separately).
// 2. process.cwd() — project-local overrides. Generic filenames here (config.json/
//    yaml) are commonly owned by the repo's own app, so cwd candidates must pass
//    looksLikeOpenSwarmConfig before they shadow the user-level configs. (INT-2762)
// 3. ~/.config/openswarm — XDG-style user config (preferred daemon location).
// 4. ~/.openswarm — legacy home fallback.
function getConfigSearchDirs(): string[] {
  const home = homedir();
  return [
    process.cwd(),
    join(home, '.config', 'openswarm'),
    join(home, '.openswarm'),
  ];
}

function getConfigSearchPaths(): string[] {
  const paths: string[] = [];
  for (const dir of getConfigSearchDirs()) {
    for (const name of CONFIG_FILENAMES) {
      paths.push(join(dir, name));
    }
  }
  return paths;
}

const DEFAULT_HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_GITHUB_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const AdapterNameSchema = z.enum(['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'claude', 'cc-router', 'cursor']);

// Zod Schemas

const AgentSessionSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  projectPath: z.string().min(1, 'Project path is required'),
  heartbeatInterval: z.number().positive().optional(),
  linearLabel: z.string().optional(),
  enabled: z.boolean().default(true),
  paused: z.boolean().default(false),
});

const DiscordConfigSchema = z.object({
  token: z.string().min(1, 'Discord token is required'),
  channelId: z.string().min(1, 'Discord channel ID is required'),
  webhookUrl: z.string().optional(),
}).optional();

const LinearConfigSchema = z.object({
  apiKey: z.string().min(1, 'Linear API key is required'),
  teamId: z.string().min(1, 'Linear team ID is required'),
}).optional();

const GitHubConfigSchema = z.object({
  repos: z.array(z.string()).default([]),
  checkInterval: z.number().positive().default(DEFAULT_GITHUB_CHECK_INTERVAL),
}).optional();

const TimeRangeSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
});

const TimeWindowConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedWindows: z.array(TimeRangeSchema).default([]),
  blockedWindows: z.array(TimeRangeSchema).default([]),
  restrictedDays: z.array(z.number().min(0).max(6)).optional(),
  timezone: z.string().default('Asia/Seoul'),
}).optional();

const PairModeConfigSchema = z.object({
  /** Enable pair mode */
  enabled: z.boolean().default(false),
  /** Worker max attempts */
  maxAttempts: z.number().min(1).max(10).default(3),
  /** Worker timeout (ms) */
  workerTimeoutMs: z.number().positive().default(300000), // 5 min
  /** Reviewer timeout (ms) */
  reviewerTimeoutMs: z.number().positive().default(300000), // 5 min
  /** Webhook URL (notification on complete/failure). Empty string allowed so an
   *  unset `${PAIR_WEBHOOK_URL:-}` substitution validates (matches the other
   *  optional webhookUrl fields, which don't enforce .url()). */
  webhookUrl: z.string().url().or(z.literal('')).optional(),
  /** Auto Linear status update */
  autoLinearUpdate: z.boolean().default(true),
}).optional();

const ModelConfigSchema = z.object({
  /** Worker agent model — lightweight tier (see DefaultRolesConfigSchema). */
  worker: z.string().default('z-ai/glm-4.7-flash'),
  /** Reviewer agent model — frontier quality gate. */
  reviewer: z.string().default('openai/gpt-5'),
}).optional();

/** Per-role configuration schema */
const RoleConfigSchema = z.object({
  /** Whether role is enabled */
  enabled: z.boolean().default(true),
  /** CLI adapter */
  adapter: AdapterNameSchema.optional(),
  /** Model ID. Omit → resolved dynamically from the role's adapter (getDefaultModel). */
  model: z.string().optional(),
  /** Timeout (ms), 0 = unlimited */
  timeoutMs: z.number().min(0).default(0),
  /** Model to escalate to on repeated failure */
  escalateModel: z.string().optional(),
  /** Escalate after this iteration number (default: 3) */
  escalateAfterIteration: z.number().min(1).optional(),
  /** Max agentic turns per CLI invocation */
  maxTurns: z.number().min(1).optional(),
  /** Adaptive worker fan-out gate and candidate execution. */
  fanout: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(['report', 'execute']).optional(),
    minScore: z.number().min(1).max(10).optional(),
    concurrency: z.number().int().min(1).max(3).optional(),
    keepSandboxes: z.boolean().optional(),
    linkSharedPaths: z.boolean().optional(),
    candidates: z.array(z.object({
      id: z.string().min(1),
      adapter: AdapterNameSchema.optional(),
      model: z.string().optional(),
      reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
      maxTurns: z.number().min(1).optional(),
      nudgeMaxOnNoEdit: z.number().min(0).optional(),
      webTools: z.boolean().optional(),
      memoryTools: z.boolean().optional(),
    })).optional(),
  }).optional(),
});

/** Default roles configuration schema */
const DefaultRolesConfigSchema = z.object({
  // Worker = lightweight tier. Benchmark (benchmarks/modelSelect.ts, L0–L3 coding
  // tasks) ranked z-ai/glm-4.7-flash #1: 100% pass, $0.0021/pass (cheapest), and
  // 2759 tok/s under ZDR via DeepInfra — ~5× faster than the next candidate. It is
  // a non-thinking model, so it wastes no reasoning tokens on mechanical edits.
  // On repeated failure it escalates to the frontier (gpt-5).
  worker: RoleConfigSchema.default({
    enabled: true,
    model: 'z-ai/glm-4.7-flash',
    timeoutMs: 0,
    escalateModel: 'openai/gpt-5',
    // Escalate on the 2nd attempt, not the 3rd. With maxIterations=3, a threshold
    // of 3 only kicks in on the final pass — too late to help. Retrying the exact
    // same model after a failure rarely changes the outcome; switch models sooner.
    escalateAfterIteration: 2,
  }),
  // Reviewer = frontier tier, never cheaped out. A weak reviewer that wrongly
  // approves (bug slips through) or wrongly rejects (worker loops) costs MORE than
  // the model price difference. The quality gate stays on gpt-5.
  reviewer: RoleConfigSchema.default({
    enabled: true,
    model: 'openai/gpt-5',
    timeoutMs: 0,
  }),
  tester: RoleConfigSchema.optional(),
  documenter: RoleConfigSchema.optional(),
  auditor: RoleConfigSchema.optional(),
  'skill-documenter': RoleConfigSchema.optional(),
}).optional();

/** Per-project role override schema */
const ProjectRolesOverrideSchema = z.object({
  worker: RoleConfigSchema.partial().optional(),
  reviewer: RoleConfigSchema.partial().optional(),
  tester: RoleConfigSchema.partial().optional(),
  documenter: RoleConfigSchema.partial().optional(),
  auditor: RoleConfigSchema.partial().optional(),
  'skill-documenter': RoleConfigSchema.partial().optional(),
}).optional();

/** Per-project agent configuration schema */
const ProjectAgentConfigSchema = z.object({
  /** Project path */
  projectPath: z.string().min(1),
  /** Linear project ID */
  linearProjectId: z.string().optional(),
  /** Per-role configuration override */
  roles: ProjectRolesOverrideSchema,
});

/** Task decomposition (Planner) configuration schema */
const DecompositionConfigSchema = z.object({
  /** Enable decomposition */
  enabled: z.boolean().default(false),
  /** Decomposition threshold (minutes) - tasks exceeding this estimate are decomposed */
  thresholdMinutes: z.number().min(10).max(120).default(30),
  /** Max decomposition depth (default: 2) - prevents infinite nesting */
  maxDepth: z.number().min(1).max(5).default(2).optional(),
  /** Max children per task (default: 5) - prevents issue explosion */
  maxChildrenPerTask: z.number().min(1).max(20).default(5).optional(),
  /** Daily issue creation limit (default: 20) - prevents runaway creation */
  dailyLimit: z.number().min(1).max(100).default(20).optional(),
  /** Auto-move to backlog if too complex or failing (default: true) */
  autoBacklog: z.boolean().default(true).optional(),
  /**
   * Planner model — frontier tier. Decomposition is high-leverage: a bad split
   * pollutes every downstream worker, so we never cheap out here.
   */
  plannerModel: z.string().default('openai/gpt-5'),
  /** Planner timeout (ms) - default 600000 (10min) */
  plannerTimeoutMs: z.number().min(60000).default(600000),
}).optional();

const BacklogGroomingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cadenceHours: z.number().min(1).max(168).default(24).optional(),
  mode: z.enum(['comment', 'apply']).default('comment').optional(),
  plannerModel: z.string().optional(),
  plannerTimeoutMs: z.number().min(60000).default(600000).optional(),
  maxIssues: z.number().min(1).max(250).default(80).optional(),
}).optional();

/**
 * Explicit project-level supervisor. These defaults are deliberately frontier
 * tier: this role arbitrates several concurrent workers and is invoked only for
 * actionable board state, not for every ordinary implementation turn.
 */
const OrchestratorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().min(1).optional(),
  eventDriven: z.boolean().default(true),
  eventDebounceMs: z.number().int().min(0).max(60_000).default(1_000),
  adapter: AdapterNameSchema.default('codex-responses'),
  model: z.string().min(1).default('gpt-5.6-sol'),
  reasoningEffort: z.enum(['low', 'medium', 'high']).default('high'),
  timeoutMs: z.number().int().min(1_000).max(60 * 60_000).default(600_000),
  maxTurns: z.number().int().min(1).max(50).default(12),
}).optional();

const PipelineStageSchema = z.enum(['worker', 'reviewer', 'tester', 'documenter', 'auditor', 'skill-documenter']);

const JobProfileSchema = z.object({
  name: z.string().min(1),
  minMinutes: z.number().min(0).optional(),
  maxMinutes: z.number().min(0).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  // partialRecord, not record: a profile overrides only the stages it names
  // (e.g. worker+reviewer). In Zod v4 `z.record(enum, …)` requires every enum
  // key, which rejected valid partial profiles and crashed daemon startup.
  roles: z.partialRecord(PipelineStageSchema, z.string()).optional(),
});

const PipelineGuardsConfigSchema = z.object({
  qualityGate: z.boolean().optional(),
  fakeDataGuard: z.boolean().optional(),
  conventionalCommits: z.boolean().optional(),
  branchValidation: z.boolean().optional(),
  uncertaintyDetection: z.boolean().optional(),
  haltToLinear: z.boolean().optional(),
  registryCheck: z.boolean().optional(),
  bsDetector: z.boolean().optional(),
  dependencyAntiPatternCheck: z.boolean().optional(),
  contractEvidenceCheck: z.boolean().optional(),
  verifiedMetricEvidenceCheck: z.boolean().optional(),
  deadModuleCheck: z.boolean().optional(),
  reformatCheck: z.boolean().optional(),
}).optional();

const VerifyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  blockOnNewFailures: z.boolean().default(true),
  maxCommands: z.number().int().min(1).max(20).default(4),
}).default({ enabled: true, blockOnNewFailures: true, maxCommands: 4 });

const SecurityAuditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxThreads: z.number().int().min(1).max(16).default(2),
  maxRamMb: z.number().int().min(512).max(65536).default(4096),
}).default({ enabled: true, maxThreads: 2, maxRamMb: 4096 });

const AutonomousConfigSchema = z.object({
  /** Auto-enable on service start */
  enabled: z.boolean().default(false),
  /** Worker/Reviewer pair mode */
  pairMode: z.boolean().default(true),
  /** Execution schedule (cron expression) */
  schedule: z.string().default('*/30 * * * *'),
  /** Pair mode max attempts */
  maxAttempts: z.number().min(1).max(10).default(3),
  /** Allowed project paths */
  allowedProjects: z.array(z.string()).default(['~/dev']),
  /** Treat Linear Backlog as a work queue (legacy). Default false = Backlog parked. */
  includeBacklog: z.boolean().optional(),
  /** Model configuration (legacy) */
  models: ModelConfigSchema,
  /** Worker timeout (ms). 0/unset = use the pipeline's per-stage ceiling
   *  (stageTimeoutMs) — it is NO LONGER "unlimited": an unbounded stage could hang
   *  the whole daemon. Set a positive value to override. (INT-2521) */
  workerTimeoutMs: z.number().min(0).default(0),
  /** Reviewer timeout (ms). 0/unset = pipeline per-stage ceiling (not unlimited). */
  reviewerTimeoutMs: z.number().min(0).default(0),
  /** Max concurrent tasks. The daemon fills every available slot, up to 32. */
  maxConcurrentTasks: z.number().int().min(1).max(32).default(32),
  /** Max concurrent tasks from the same project when same-project parallelism is enabled. */
  maxConcurrentPerProject: z.number().int().min(1).max(32).optional(),
  /** SQLite execution-truth rollout. primary is fail-closed; shadow only observes. */
  automationLedgerMode: z.enum(['off', 'shadow', 'primary']).default('primary'),
  automationDbPath: z.string().min(1).optional(),
  automationLeaseMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(10 * 60_000),
  shutdownGraceMs: z.number().int().min(0).max(5 * 60_000).default(30_000),
  /** Default role configuration */
  defaultRoles: DefaultRolesConfigSchema,
  /** Per-project agent configuration */
  projectAgents: z.array(ProjectAgentConfigSchema).optional(),
  /** Task decomposition configuration (Planner Agent) */
  decomposition: DecompositionConfigSchema,
  /** Whole-backlog grooming planner configuration */
  backlogGrooming: BacklogGroomingConfigSchema,
  /** Git worktree mode: each task runs in isolated worktree */
  worktreeMode: z.boolean().default(false),
  /** Allow concurrent tasks on the same repo (requires worktreeMode). (INT-1975) */
  allowSameProjectConcurrent: z.boolean().default(true),
  /** Dynamic job profiles for model selection */
  jobProfiles: z.array(JobProfileSchema).optional(),
  /** Pipeline quality guards (bad-edit lint gate, BS detector, etc.) */
  guards: PipelineGuardsConfigSchema,
  /** Deterministic baseline-diff verification (default ON). */
  verify: VerifyConfigSchema,
  /** CodeQL baseline-diff gate for autonomous code edits (default ON). */
  securityAudit: SecurityAuditConfigSchema,
  /** Max objective self-repair attempts (lint/bs/test) before giving up */
  maxReflections: z.number().min(1).max(10).default(3),
  /** Cooldown between task completions in ms (default: 1800000 = 30min) */
  interTaskCooldownMs: z.number().min(0).default(1800000),
  coordinationBoardIssueId: z.string().min(1).optional(),
  mcpPolicies: z.record(z.string(), z.object({
    servers: z.array(z.string()).default([]),
    allowTools: z.array(z.string()).optional(),
    writeTools: z.array(z.string()).optional(),
    destructiveTools: z.array(z.string()).optional(),
  })).optional(),
  adapterRouting: z.object({
    // Must be expressible for anything `adapter:` can select as the worker's
    // primary — a policy whose primary the schema rejects cannot match the
    // running adapter, which silently disables routing (README documents the
    // equality requirement).
    primary: z.enum(['codex', 'codex-responses', 'cc-router', 'cursor', 'gpt', 'openrouter', 'atlascloud', 'lmstudio', 'local', 'claude']).default('codex'),
    fallbacks: z.array(z.enum(['cc-router', 'cursor', 'codex', 'codex-responses'])).default(['cc-router', 'cursor']),
    allowReasons: z.array(z.enum(['quota', 'infra', 'capability'])).default(['quota', 'infra', 'capability']),
  }).optional(),
  periodicReviews: z.array(z.object({
    profile: z.enum(['permissions', 'hygiene', 'security', 'review']),
    schedule: z.string().min(1),
    adapter: z.enum(['codex', 'cc-router', 'cursor']).optional(),
  })).optional(),
  /** High-capability project-level supervisor. */
  orchestrator: OrchestratorConfigSchema,
  /** Cron schedule for the MCP-connected orchestrator sweep. Omit to disable. */
  orchestratorSchedule: z.string().min(1).optional(),
}).optional();

// Long-Running Monitor schemas
const CompletionCheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exit-code'), successExitCode: z.number().optional() }),
  z.object({ type: z.literal('output-regex'), successPattern: z.string(), failurePattern: z.string().optional() }),
  z.object({ type: z.literal('http-status'), expectedStatus: z.number().optional() }),
]);

const LongRunningMonitorConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  checkCommand: z.array(z.string().min(1)).min(1),
  completionCheck: CompletionCheckSchema,
  issueId: z.string().optional(),
  checkInterval: z.number().min(1).default(1),
  maxDurationHours: z.number().min(1).default(48),
  notify: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ConflictResolverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ownershipMode: z.enum(['auto', 'all']).default('auto'),
  maxResolutionAttempts: z.number().min(1).max(10).default(3),
  cascadeCheck: z.boolean().default(true),
  workerModel: z.string().optional(),
  workerTimeoutMs: z.number().min(0).optional(),
}).optional();

const PRProcessorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('*/15 * * * *'),
  cooldownHours: z.number().default(6),
  maxIterations: z.number().min(1).max(10).default(3),
  maxRetries: z.number().min(1).max(10).optional(),
  ciTimeoutMs: z.number().positive().optional(),
  ciPollIntervalMs: z.number().positive().optional(),
  conflictResolver: ConflictResolverConfigSchema,
  repoMappings: z.record(z.string(), z.string()).optional(),
}).optional();

const CIWorkerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMs: z.number().positive().default(300000),
  autoRetry: z.boolean().default(false),
  createIssues: z.boolean().default(true),
  maxAgeDays: z.number().positive().default(30),
}).optional();

// Outbound notification channel (INT-1576). Discord stays the default; Slack/
// Telegram/webhook are BYO. Distinct from the per-job `notify` boolean above.
const NotificationsSchema = z.object({
  channel: z.enum(['discord', 'slack', 'telegram', 'webhook', 'none']).default('discord'),
  slackWebhookUrl: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  webhookUrl: z.string().optional(),
}).optional();

// MCP server entry: stdio (`command`/`args`/`env`) or remote (`url`/`headers`).
// Mirrors the ~/.openswarm/mcp.json shape so config.yaml is a single source. (INT-1949)
const McpServerSchema = z
  .object({
    /** Reference a built-in preset (e.g. `linear`) instead of command/url. (INT-1952) */
    preset: z.string().optional(),
    /** Explicit trust-domain label; `human` makes unknown actions fail closed. */
    surface: z.enum(['human', 'devops', 'data', 'sandbox', 'unknown']).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    transport: z.enum(['stdio', 'http', 'sse']).optional(),
  })
  .refine((s) => !!s.preset || !!s.command || !!s.url, {
    message: 'MCP server needs a `preset`, a `command` (stdio), or a `url` (remote)',
  });

const McpConfigSchema = z
  .object({
    servers: z.record(z.string(), McpServerSchema).default({}),
  })
  .optional();

// Anonymous usage telemetry (opt-out). Defaults to enabled; the daemon/CLI also
// honor OPENSWARM_TELEMETRY=0 / DO_NOT_TRACK / CI env. (INT-1992)
const TelemetryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .optional();

const DailyReporterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 18 * * *'),
}).optional();

const RawConfigSchema = z.object({
  adapter: AdapterNameSchema.default('codex'),
  language: z.enum(['en', 'ko']).default('en'),
  discord: DiscordConfigSchema,
  notifications: NotificationsSchema,
  linear: LinearConfigSchema,
  github: GitHubConfigSchema,
  timeWindow: TimeWindowConfigSchema,
  pairMode: PairModeConfigSchema,
  autonomous: AutonomousConfigSchema,
  prProcessor: PRProcessorConfigSchema,
  ciWorker: CIWorkerConfigSchema,
  monitors: z.array(LongRunningMonitorConfigSchema).optional(),
  dailyReporter: DailyReporterConfigSchema,
  mcp: McpConfigSchema,
  telemetry: TelemetryConfigSchema,
  agents: z.array(AgentSessionSchema).min(1, 'At least one agent is required'),
  defaultHeartbeatInterval: z.number().positive().default(DEFAULT_HEARTBEAT_INTERVAL),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

// Environment Variable Substitution

/**
 * Environment variable pattern: ${VAR_NAME} or ${VAR_NAME:-default}
 */
const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/**
 * Substitute environment variables in string
 */
function substituteEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName, defaultValue) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // Return empty string if no env var and no default value
    console.warn(`Environment variable ${varName} is not set`);
    return '';
  });
}

/**
 * Apply environment variable substitution to all strings in an object
 */
function substituteEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Expand path (~/ handling)
 */
export function expandPath(path: string, resolveRelative = false): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (resolveRelative) {
    return resolve(path);
  }
  return path;
}

// Config Loading

/**
 * True when a project-local candidate looks like an OpenSwarm config.
 * Requires the one top-level key the schema mandates — an `agents` array —
 * so a repo's own config.json (any other app's settings) never shadows the
 * real user-level config. Unparseable files are treated as foreign. (INT-2762)
 */
function looksLikeOpenSwarmConfig(path: string): boolean {
  try {
    const parsed = parseConfigFile(path);
    return typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).agents);
  } catch {
    return false;
  }
}

/**
 * Find configuration file.
 *
 * Resolution order:
 *   1. $OPENSWARM_CONFIG env var (explicit file path override)
 *   2. ./config.{yaml,yml,json}           (project-local; must look like an OpenSwarm config)
 *   3. ~/.config/openswarm/config.{…}     (XDG user config)
 *   4. ~/.openswarm/config.{…}            (legacy home fallback)
 */
export function findConfigFile(): string | null {
  const envOverride = process.env.OPENSWARM_CONFIG;
  if (envOverride && envOverride.length > 0) {
    if (existsSync(envOverride)) {
      return envOverride;
    }
    // Surface a clear error rather than silently falling through — user asked for this file.
    throw new Error(`OPENSWARM_CONFIG points to a file that does not exist: ${envOverride}`);
  }

  const dirs = getConfigSearchDirs();
  for (let i = 0; i < dirs.length; i++) {
    const projectLocal = i === 0; // getConfigSearchDirs() lists process.cwd() first
    for (const name of CONFIG_FILENAMES) {
      const path = join(dirs[i], name);
      if (!existsSync(path)) continue;
      if (projectLocal && !looksLikeOpenSwarmConfig(path)) {
        console.log(status.warn(`[Config] Ignoring ${path} — not an OpenSwarm config (no top-level "agents" list)`));
        continue;
      }
      return path;
    }
  }
  return null;
}

/**
 * Parse configuration file
 */
function parseConfigFile(path: string): unknown {
  const content = readFileSync(path, 'utf-8');

  if (path.endsWith('.json')) {
    return JSON.parse(content);
  }

  // YAML parsing
  return YAML.parse(content);
}

/**
 * Transform raw config to SwarmConfig
 */
function transformConfig(raw: RawConfig): SwarmConfig {
  return {
    adapter: raw.adapter,
    language: raw.language,
    discordToken: raw.discord?.token ?? '',
    discordChannelId: raw.discord?.channelId ?? '',
    discordWebhookUrl: raw.discord?.webhookUrl,
    notifications: raw.notifications
      ? {
          channel: raw.notifications.channel,
          slackWebhookUrl: raw.notifications.slackWebhookUrl,
          telegramBotToken: raw.notifications.telegramBotToken,
          telegramChatId: raw.notifications.telegramChatId,
          webhookUrl: raw.notifications.webhookUrl,
        }
      : undefined,
    linearApiKey: raw.linear?.apiKey ?? '',
    linearTeamId: raw.linear?.teamId ?? '',
    agents: raw.agents.map(agent => ({
      ...agent,
      projectPath: expandPath(agent.projectPath),
      heartbeatInterval: agent.heartbeatInterval ?? raw.defaultHeartbeatInterval,
      linearLabel: agent.linearLabel ?? agent.name,
    })),
    defaultHeartbeatInterval: raw.defaultHeartbeatInterval,
    githubRepos: raw.github?.repos,
    githubCheckInterval: raw.github?.checkInterval,
    timeWindow: raw.timeWindow ? {
      enabled: raw.timeWindow.enabled,
      allowedWindows: raw.timeWindow.allowedWindows,
      blockedWindows: raw.timeWindow.blockedWindows,
      restrictedDays: raw.timeWindow.restrictedDays,
      timezone: raw.timeWindow.timezone,
    } : undefined,
    pairMode: raw.pairMode ? {
      enabled: raw.pairMode.enabled,
      maxAttempts: raw.pairMode.maxAttempts,
      workerTimeoutMs: raw.pairMode.workerTimeoutMs,
      reviewerTimeoutMs: raw.pairMode.reviewerTimeoutMs,
      webhookUrl: raw.pairMode.webhookUrl,
      autoLinearUpdate: raw.pairMode.autoLinearUpdate,
    } : undefined,
    autonomous: raw.autonomous ? {
      enabled: raw.autonomous.enabled,
      pairMode: raw.autonomous.pairMode,
      schedule: raw.autonomous.schedule,
      maxAttempts: raw.autonomous.maxAttempts,
      allowedProjects: raw.autonomous.allowedProjects,
      includeBacklog: raw.autonomous.includeBacklog,
      models: raw.autonomous.models ? {
        worker: raw.autonomous.models.worker,
        reviewer: raw.autonomous.models.reviewer,
      } : undefined,
      workerTimeoutMs: raw.autonomous.workerTimeoutMs,
      reviewerTimeoutMs: raw.autonomous.reviewerTimeoutMs,
      maxConcurrentTasks: raw.autonomous.maxConcurrentTasks,
      maxConcurrentPerProject: raw.autonomous.maxConcurrentPerProject,
      automationLedgerMode: raw.autonomous.automationLedgerMode,
      automationDbPath: raw.autonomous.automationDbPath ? expandPath(raw.autonomous.automationDbPath) : undefined,
      automationLeaseMs: raw.autonomous.automationLeaseMs,
      shutdownGraceMs: raw.autonomous.shutdownGraceMs,
      defaultRoles: raw.autonomous.defaultRoles,
      projectAgents: raw.autonomous.projectAgents?.map(pa => ({
        ...pa,
        projectPath: expandPath(pa.projectPath),
      })),
      decomposition: raw.autonomous.decomposition ? {
        enabled: raw.autonomous.decomposition.enabled,
        thresholdMinutes: raw.autonomous.decomposition.thresholdMinutes,
        maxDepth: raw.autonomous.decomposition.maxDepth ?? 2,
        maxChildrenPerTask: raw.autonomous.decomposition.maxChildrenPerTask ?? 5,
        dailyLimit: raw.autonomous.decomposition.dailyLimit ?? 20,
        autoBacklog: raw.autonomous.decomposition.autoBacklog ?? true,
        plannerModel: raw.autonomous.decomposition.plannerModel,
        plannerTimeoutMs: raw.autonomous.decomposition.plannerTimeoutMs,
      } : undefined,
      backlogGrooming: raw.autonomous.backlogGrooming ? {
        enabled: raw.autonomous.backlogGrooming.enabled,
        cadenceHours: raw.autonomous.backlogGrooming.cadenceHours,
        mode: raw.autonomous.backlogGrooming.mode,
        plannerModel: raw.autonomous.backlogGrooming.plannerModel,
        plannerTimeoutMs: raw.autonomous.backlogGrooming.plannerTimeoutMs,
        maxIssues: raw.autonomous.backlogGrooming.maxIssues,
      } : undefined,
      worktreeMode: raw.autonomous.worktreeMode,
      allowSameProjectConcurrent: raw.autonomous.allowSameProjectConcurrent,
      guards: raw.autonomous.guards,
      verify: raw.autonomous.verify,
      securityAudit: raw.autonomous.securityAudit,
      maxReflections: raw.autonomous.maxReflections,
      interTaskCooldownMs: raw.autonomous.interTaskCooldownMs,
      // jobProfiles was validated by the schema but dropped here, so per-task
      // model selection silently fell back to defaultRoles. Carry it through.
      jobProfiles: raw.autonomous.jobProfiles,
      coordinationBoardIssueId: raw.autonomous.coordinationBoardIssueId,
      mcpPolicies: raw.autonomous.mcpPolicies,
      adapterRouting: raw.autonomous.adapterRouting,
      periodicReviews: raw.autonomous.periodicReviews,
      orchestrator: raw.autonomous.orchestrator,
      orchestratorSchedule: raw.autonomous.orchestratorSchedule,
    } : undefined,
    prProcessor: raw.prProcessor ? {
      enabled: raw.prProcessor.enabled,
      schedule: raw.prProcessor.schedule,
      cooldownHours: raw.prProcessor.cooldownHours,
      maxIterations: raw.prProcessor.maxIterations,
      maxRetries: raw.prProcessor.maxRetries,
      ciTimeoutMs: raw.prProcessor.ciTimeoutMs,
      ciPollIntervalMs: raw.prProcessor.ciPollIntervalMs,
      conflictResolver: raw.prProcessor.conflictResolver as ConflictResolverConfig | undefined,
      repoMappings: raw.prProcessor.repoMappings,
    } : undefined,
    ciWorker: raw.ciWorker ? {
      enabled: raw.ciWorker.enabled,
      checkIntervalMs: raw.ciWorker.checkIntervalMs,
      autoRetry: raw.ciWorker.autoRetry,
      createIssues: raw.ciWorker.createIssues,
      maxAgeDays: raw.ciWorker.maxAgeDays,
    } : undefined,
    monitors: raw.monitors as LongRunningMonitorConfig[] | undefined,
    dailyReporter: raw.dailyReporter,
    mcp: raw.mcp ? { servers: raw.mcp.servers as McpConfig['servers'] } : undefined,
    telemetry: raw.telemetry ? { enabled: raw.telemetry.enabled } : undefined,
  };
}

/**
 * Load config (env var substitution + Zod validation)
 */
export function loadConfig(customPath?: string): SwarmConfig {
  // 1. Find config file
  const configPath = customPath ?? findConfigFile();

  if (!configPath) {
    const searched = getConfigSearchPaths().map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `Config file not found. Searched:\n${searched}\n` +
      `Create one of the above, or set $OPENSWARM_CONFIG to an explicit file path.`
    );
  }

  console.log(`${status.info('Config')} ${c.dim('loading from')} ${c.cyan(configPath)}`);

  // 2. Parse file
  let rawData: unknown;
  try {
    rawData = parseConfigFile(configPath);
  } catch (err) {
    throw new Error(`Failed to parse config file: ${err}`);
  }

  // 3. Substitute environment variables
  const substituted = substituteEnvVarsDeep(rawData) as Record<string, unknown>;

  // 3.5. Optional 블록 정리: 환경변수 미설정 시 빈 문자열이 들어온 블록 제거
  const discordBlock = substituted.discord as Record<string, unknown> | undefined;
  if (discordBlock && (!discordBlock.token || !discordBlock.channelId)) {
    console.log(status.warn('[Config] Discord credentials not set — disabling Discord integration'));
    delete substituted.discord;
  }
  const linearBlock = substituted.linear as Record<string, unknown> | undefined;
  if (linearBlock && (!linearBlock.apiKey || !linearBlock.teamId)) {
    console.log(status.warn('[Config] Linear credentials not set — disabling Linear integration'));
    delete substituted.linear;
  }

  // 4. Zod schema validation
  const parseResult = RawConfigSchema.safeParse(substituted);

  if (!parseResult.success) {
    const errors = parseResult.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  // 5. Transform to SwarmConfig
  const config = transformConfig(parseResult.data);

  // 6. Apply time window config
  if (config.timeWindow) {
    setTimeWindowConfig(config.timeWindow);
    console.log(`${status.info('[Config] TimeWindow')} ${c.dim('loaded')} ${c.yellow(`enabled: ${config.timeWindow.enabled}`)}`);
  } else {
    setTimeWindowConfig(DEFAULT_TIME_WINDOW);
    console.log(`${status.info('[Config] TimeWindow')} ${c.dim('using default config')}`);
  }

  return config;
}

/**
 * Validate config (supplementary checks beyond Zod validation)
 */
export function validateConfig(config: SwarmConfig): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // A missing agent project path is NOT fatal: the runner simply skips that
  // agent (see index.ts), so the daemon still serves the web/monitor API and
  // any agents whose paths do exist. Killing the whole daemon over a sample/
  // placeholder agent path (e.g. ~/dev/my-project from `openswarm init`) was
  // the cause of "started in background" but "is not running".
  for (const agent of config.agents) {
    if (!existsSync(agent.projectPath)) {
      warnings.push(`Agent "${agent.name}" project path does not exist: ${agent.projectPath} (agent disabled)`);
    }
  }

  // Verify GitHub repo format — a malformed repo string is real misconfiguration.
  if (config.githubRepos) {
    for (const repo of config.githubRepos) {
      if (!repo.includes('/')) {
        errors.push(`Invalid GitHub repo format: ${repo} (expected: owner/repo)`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Create a default agent session
 */
export function createAgentSession(
  name: string,
  projectPath: string,
  options?: Partial<AgentSession>
): AgentSession {
  return {
    name,
    projectPath: expandPath(projectPath),
    heartbeatInterval: options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
    linearLabel: options?.linearLabel ?? name,
    enabled: options?.enabled ?? true,
    paused: options?.paused ?? false,
  };
}

/**
 * Generate a sample configuration file
 */
export function generateSampleConfig(): string {
  return `# OpenSwarm Configuration
# Environment variables use \${VAR_NAME} or \${VAR_NAME:-default} format

# Default CLI adapter for worker/reviewer stages
# Options: codex, openrouter, atlascloud, lmstudio, local, gpt
# - codex:      OpenAI Codex via PKCE login (openswarm auth login --provider codex)
# - openrouter: OpenRouter API key (OPENROUTER_API_KEY env var or openswarm auth login --provider openrouter)
# - atlascloud: Atlas Cloud API key (ATLASCLOUD_API_KEY env var)
# - lmstudio:   LM Studio local server (set LMSTUDIO_BASE_URL / LMSTUDIO_MODEL)
# - local:      Ollama local models (ollama pull <model>)
# - gpt:        OpenAI Chat API via OAuth (openswarm auth login --provider gpt)
adapter: codex

discord:
  token: \${DISCORD_TOKEN}
  channelId: \${DISCORD_CHANNEL_ID}
  webhookUrl: \${DISCORD_WEBHOOK_URL:-}  # optional

# Outbound notification channel (default: discord). BYO credentials.
# channel: discord | slack | telegram | webhook | none
notifications:
  channel: discord
  # slackWebhookUrl: \${SLACK_WEBHOOK_URL:-}
  # telegramBotToken: \${TELEGRAM_BOT_TOKEN:-}
  # telegramChatId: \${TELEGRAM_CHAT_ID:-}
  # webhookUrl: \${NOTIFY_WEBHOOK_URL:-}

# Task source: when the linear block below is unset, OpenSwarm falls back to a
# local SQLite issue store (~/.openswarm/issues.db) — no external account needed.
linear:
  apiKey: \${LINEAR_API_KEY}
  teamId: \${LINEAR_TEAM_ID}

github:
  repos:
    - owner/repo1
    - owner/repo2
  checkInterval: 300000  # 5 min (ms)

# Agent list
agents:
  - name: main
    projectPath: ~/dev/my-project
    heartbeatInterval: 1800000  # 30 min (ms)
    linearLabel: main  # Label for Linear issue filtering
    enabled: true
    paused: false

  - name: backend
    projectPath: ~/dev/backend-api
    linearLabel: backend
    enabled: true

# Anonymous usage telemetry (opt-out). Helps guide development with real usage
# data: command name, version, OS — never code, prompts, paths, or personal data.
# Disable here, or via OPENSWARM_TELEMETRY=0 / DO_NOT_TRACK=1. CI is auto-excluded.
telemetry:
  enabled: true

# Default heartbeat interval (ms)
defaultHeartbeatInterval: 1800000

# Worker/Reviewer pair mode configuration
pairMode:
  enabled: false              # Enable pair mode
  maxAttempts: 3              # Worker max attempts
  workerTimeoutMs: 300000     # Worker timeout (5 min)
  reviewerTimeoutMs: 300000   # Reviewer timeout (5 min)
  webhookUrl: \${PAIR_WEBHOOK_URL:-}  # Completion/failure notification (optional)
  autoLinearUpdate: true      # Auto Linear status update
`;
}
