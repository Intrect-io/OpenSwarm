// ============================================
// OpenSwarm - Configuration
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import YAML from 'yaml';
import type { SwarmConfig, AgentSession, LongRunningMonitorConfig, ConflictResolverConfig } from './types.js';
import { setTimeWindowConfig, DEFAULT_TIME_WINDOW } from '../support/timeWindow.js';

// ============================================
// Constants
// ============================================

const CONFIG_PATHS = [
  join(process.cwd(), 'config.yaml'),
  join(process.cwd(), 'config.yml'),
  join(process.cwd(), 'config.json'),
];

const DEFAULT_HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_GITHUB_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ============================================
// Zod Schemas
// ============================================

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
});

const LinearConfigSchema = z.object({
  apiKey: z.string().min(1, 'Linear API key is required'),
  teamId: z.string().min(1, 'Linear team ID is required'),
});

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
  reviewerTimeoutMs: z.number().positive().default(180000), // 3 min
  /** Webhook URL (notification on complete/failure) */
  webhookUrl: z.string().url().optional(),
  /** Auto Linear status update */
  autoLinearUpdate: z.boolean().default(true),
}).optional();

const ModelConfigSchema = z.object({
  /** Worker agent model */
  worker: z.string().default('claude-sonnet-4-20250514'),
  /** Reviewer agent model */
  reviewer: z.string().default('claude-sonnet-4-20250514'),
}).optional();

/** Per-role configuration schema */
const RoleConfigSchema = z.object({
  /** Whether role is enabled */
  enabled: z.boolean().default(true),
  /** Model ID */
  model: z.string(),
  /** Timeout (ms), 0 = unlimited */
  timeoutMs: z.number().min(0).default(0),
  /** Model to escalate to on repeated failure */
  escalateModel: z.string().optional(),
  /** Escalate after this iteration number (default: 3) */
  escalateAfterIteration: z.number().min(1).optional(),
});

/** Default roles configuration schema */
const DefaultRolesConfigSchema = z.object({
  worker: RoleConfigSchema.default({
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    timeoutMs: 0,
    escalateModel: 'claude-sonnet-4-20250514',
    escalateAfterIteration: 3,
  }),
  reviewer: RoleConfigSchema.default({
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
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
  /** Planner model */
  plannerModel: z.string().default('claude-sonnet-4-20250514'),
  /** Planner timeout (ms) - default 600000 (10min) */
  plannerTimeoutMs: z.number().min(60000).default(600000),
}).optional();

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
  /** Model configuration (legacy) */
  models: ModelConfigSchema,
  /** Worker timeout (ms) - 0 = unlimited (legacy) */
  workerTimeoutMs: z.number().min(0).default(0),
  /** Reviewer timeout (ms) - 0 = unlimited (legacy) */
  reviewerTimeoutMs: z.number().min(0).default(0),
  /** Max concurrent tasks */
  maxConcurrentTasks: z.number().min(1).max(10).default(1),
  /** Default role configuration */
  defaultRoles: DefaultRolesConfigSchema,
  /** Per-project agent configuration */
  projectAgents: z.array(ProjectAgentConfigSchema).optional(),
  /** Task decomposition configuration (Planner Agent) */
  decomposition: DecompositionConfigSchema,
  /** Git worktree mode: each task runs in isolated worktree */
  worktreeMode: z.boolean().default(false),
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
  checkCommand: z.string().min(1),
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
  conflictResolver: ConflictResolverConfigSchema,
}).optional();

const RawConfigSchema = z.object({
  language: z.enum(['en', 'ko']).default('en'),
  discord: DiscordConfigSchema,
  linear: LinearConfigSchema,
  github: GitHubConfigSchema,
  timeWindow: TimeWindowConfigSchema,
  pairMode: PairModeConfigSchema,
  autonomous: AutonomousConfigSchema,
  prProcessor: PRProcessorConfigSchema,
  monitors: z.array(LongRunningMonitorConfigSchema).optional(),
  agents: z.array(AgentSessionSchema).min(1, 'At least one agent is required'),
  defaultHeartbeatInterval: z.number().positive().default(DEFAULT_HEARTBEAT_INTERVAL),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

// ============================================
// Environment Variable Substitution
// ============================================

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
function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// ============================================
// Config Loading
// ============================================

/**
 * Find configuration file
 */
function findConfigFile(): string | null {
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
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
    language: raw.language,
    discordToken: raw.discord.token,
    discordChannelId: raw.discord.channelId,
    discordWebhookUrl: raw.discord.webhookUrl,
    linearApiKey: raw.linear.apiKey,
    linearTeamId: raw.linear.teamId,
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
      models: raw.autonomous.models ? {
        worker: raw.autonomous.models.worker,
        reviewer: raw.autonomous.models.reviewer,
      } : undefined,
      workerTimeoutMs: raw.autonomous.workerTimeoutMs,
      reviewerTimeoutMs: raw.autonomous.reviewerTimeoutMs,
      maxConcurrentTasks: raw.autonomous.maxConcurrentTasks,
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
      worktreeMode: raw.autonomous.worktreeMode,
    } : undefined,
    prProcessor: raw.prProcessor ? {
      enabled: raw.prProcessor.enabled,
      schedule: raw.prProcessor.schedule,
      cooldownHours: raw.prProcessor.cooldownHours,
      maxIterations: raw.prProcessor.maxIterations,
      conflictResolver: raw.prProcessor.conflictResolver as ConflictResolverConfig | undefined,
    } : undefined,
    monitors: raw.monitors as LongRunningMonitorConfig[] | undefined,
  };
}

/**
 * Load config (env var substitution + Zod validation)
 */
export function loadConfig(customPath?: string): SwarmConfig {
  // 1. Find config file
  const configPath = customPath ?? findConfigFile();

  if (!configPath) {
    throw new Error(
      `Config file not found. Create one of: ${CONFIG_PATHS.join(', ')}`
    );
  }

  console.log(`Loading config from: ${configPath}`);

  // 2. Parse file
  let rawData: unknown;
  try {
    rawData = parseConfigFile(configPath);
  } catch (err) {
    throw new Error(`Failed to parse config file: ${err}`);
  }

  // 3. Substitute environment variables
  const substituted = substituteEnvVarsDeep(rawData);

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
    console.log(`[Config] TimeWindow config loaded (enabled: ${config.timeWindow.enabled})`);
  } else {
    setTimeWindowConfig(DEFAULT_TIME_WINDOW);
    console.log(`[Config] Using default TimeWindow config`);
  }

  return config;
}

/**
 * Validate config (supplementary checks beyond Zod validation)
 */
export function validateConfig(config: SwarmConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Verify agent project paths exist
  for (const agent of config.agents) {
    if (!existsSync(agent.projectPath)) {
      errors.push(`Agent "${agent.name}" project path does not exist: ${agent.projectPath}`);
    }
  }

  // Verify GitHub repo format
  if (config.githubRepos) {
    for (const repo of config.githubRepos) {
      if (!repo.includes('/')) {
        errors.push(`Invalid GitHub repo format: ${repo} (expected: owner/repo)`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
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

discord:
  token: \${DISCORD_TOKEN}
  channelId: \${DISCORD_CHANNEL_ID}
  webhookUrl: \${DISCORD_WEBHOOK_URL:-}  # optional

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

# Default heartbeat interval (ms)
defaultHeartbeatInterval: 1800000

# Worker/Reviewer pair mode configuration
pairMode:
  enabled: false              # Enable pair mode
  maxAttempts: 3              # Worker max attempts
  workerTimeoutMs: 300000     # Worker timeout (5 min)
  reviewerTimeoutMs: 180000   # Reviewer timeout (3 min)
  webhookUrl: \${PAIR_WEBHOOK_URL:-}  # Completion/failure notification (optional)
  autoLinearUpdate: true      # Auto Linear status update
`;
}
