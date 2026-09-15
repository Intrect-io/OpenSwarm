// ============================================
// OpenSwarm - Configuration
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type { SwarmConfig, AgentSession, LongRunningMonitorConfig, ConflictResolverConfig, McpConfig } from './types.js';
import { setTimeWindowConfig, DEFAULT_TIME_WINDOW } from '../support/timeWindow.js';
import { c, status } from '../support/colors.js';
import { enableHumanSurfaceReadOnly } from '../mcp/humanSurfacePolicy.js';
import { wireSandboxExecutorIfEnabled } from '../sandboxExecutor/runtime.js';

export { validateConfig } from './configValidation.js';
import { RawConfigSchema, DEFAULT_HEARTBEAT_INTERVAL } from './configSchema.js';
import type { RawConfig } from './configSchema.js';
export type { RawConfig } from './configSchema.js';

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
    // Hand-picked mapping: a key added to the schema alone never reaches a
    // caller. That is how AGT-4122 shipped, and how this key first shipped
    // dead. (AGT-4292)
    reviewAdapter: raw.reviewAdapter,
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
    humanSurfaceReadOnly: {
      enabled: raw.humanSurfaceReadOnly.enabled,
      ...(raw.humanSurfaceReadOnly.sandboxExecutor ? {
        sandboxExecutor: { ...raw.humanSurfaceReadOnly.sandboxExecutor },
      } : {}),
    },
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
      stalledInProgressHours: raw.autonomous.stalledInProgressHours,
      maxConcurrentPerProject: raw.autonomous.maxConcurrentPerProject,
      automationLedgerMode: raw.autonomous.automationLedgerMode,
      automationDbPath: raw.autonomous.automationDbPath ? expandPath(raw.autonomous.automationDbPath) : undefined,
      retrospectiveProjectId: raw.autonomous.retrospectiveProjectId,
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
      unknownScopeAdmission: raw.autonomous.unknownScopeAdmission,
      infraFailureCircuit: raw.autonomous.infraFailureCircuit,
      guards: raw.autonomous.guards,
      verify: raw.autonomous.verify,
      securityAudit: raw.autonomous.securityAudit,
      maxReflections: raw.autonomous.maxReflections,
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

export interface LoadConfigOptions {
  /**
   * Suppress the informational / warning lines `loadConfig` normally prints.
   * Callers that own stdout for a machine-readable document (e.g.
   * `openswarm review --json`) must pass this, otherwise MCP discovery and
   * adapter resolution leak config chatter in front of the JSON and break
   * `… | jq` (AGT-4298). Side effects (human-surface / sandbox wiring) still run.
   */
  quiet?: boolean;
}

/**
 * Load config (env var substitution + Zod validation)
 */
export function loadConfig(customPath?: string, options: LoadConfigOptions = {}): SwarmConfig {
  const quiet = options.quiet === true;
  const log = quiet ? () => undefined : console.log.bind(console);

  // 1. Find config file
  const configPath = customPath ?? findConfigFile();

  if (!configPath) {
    const searched = getConfigSearchPaths().map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `Config file not found. Searched:\n${searched}\n` +
      `Create one of the above, or set $OPENSWARM_CONFIG to an explicit file path.`
    );
  }

  log(`${status.info('Config')} ${c.dim('loading from')} ${c.cyan(configPath)}`);

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
    log(status.warn('[Config] Discord credentials not set — disabling Discord integration'));
    delete substituted.discord;
  }
  const linearBlock = substituted.linear as Record<string, unknown> | undefined;
  if (linearBlock && (!linearBlock.apiKey || !linearBlock.teamId)) {
    log(status.warn('[Config] Linear credentials not set — disabling Linear integration'));
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

  // Enabling is process-lifetime monotonic. Utility callers also load config
  // (MCP discovery, telemetry, provider lookup); a later lookup resolving a
  // different/default file must never silently downgrade an active boundary.
  // Disabling therefore requires a process restart with enabled:false.
  if (config.humanSurfaceReadOnly?.enabled === true) enableHumanSurfaceReadOnly();
  wireSandboxExecutorIfEnabled(config.humanSurfaceReadOnly?.sandboxExecutor);

  // 6. Apply time window config
  if (config.timeWindow) {
    setTimeWindowConfig(config.timeWindow);
    log(`${status.info('[Config] TimeWindow')} ${c.dim('loaded')} ${c.yellow(`enabled: ${config.timeWindow.enabled}`)}`);
  } else {
    setTimeWindowConfig(DEFAULT_TIME_WINDOW);
    log(`${status.info('[Config] TimeWindow')} ${c.dim('using default config')}`);
  }

  return config;
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

# Fail closed on writes to human-facing collaboration surfaces. Delegated CLIs
# and diagnostics remain disabled. Native bash requires the separately deployed
# network-none companion and exact health/contract attestation; any failure
# leaves bash hidden. Verify-security uses the same companion whenever
# sandboxExecutor.enabled is true, even if this flag is off. (AGT-4172)
humanSurfaceReadOnly:
  enabled: false
  sandboxExecutor:
    enabled: false
    socketPath: /run/openswarm-sandbox/executor.sock
    allowedRoots: [/work]
    connectTimeoutMs: 1000
    maxRequestBytes: 65536
    maxOutputBytes: 524288
    maxTimeoutMs: 900000
    maxConcurrent: 8

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
