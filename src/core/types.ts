// ============================================
// OpenSwarm - Type Definitions
// ============================================

import type { NotificationsConfig } from '../notify/notifier.js';

/**
 * Agent session configuration
 */
export type AgentSession = {
  /** Session name */
  name: string;
  /** Project path */
  projectPath: string;
  /** Heartbeat interval (ms) */
  heartbeatInterval: number;
  /** Linear project/team label */
  linearLabel?: string;
  /** Whether enabled */
  enabled: boolean;
  /** Whether paused */
  paused: boolean;
};

/**
 * Agent status
 */
export type AgentStatus = {
  name: string;
  /** Currently active Linear issue */
  currentIssue?: {
    id: string;
    identifier: string;
    title: string;
  };
  /** Last heartbeat time */
  lastHeartbeat?: number;
  /** Last report content */
  lastReport?: string;
  /** State */
  state: 'idle' | 'working' | 'blocked' | 'paused';
};

/**
 * Linear project info
 */
export type LinearProjectInfo = {
  id: string;
  name: string;
  icon?: string;
  color?: string;
};

/**
 * Linear issue summary info
 */
export type LinearIssueInfo = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  /** Linear workflow-state type, populated by explicit single-issue lookups. */
  stateType?: string;
  priority: number;
  labels: string[];
  comments: LinearComment[];
  /** Linear project info */
  project?: LinearProjectInfo;
  /** Issue UUIDs that block this issue (from structured relations + "블로커:" prose). */
  blockedBy?: string[];
  /** ISO timestamp of issue creation — duplicate grooming orders peers by real age. (INT-3387) */
  createdAt?: string;
};

/**
 * Linear comment
 */
export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  user?: string;
};

/**
 * Discord event (for reporting)
 */
export type SwarmEvent = {
  type: 'issue_started' | 'issue_completed' | 'issue_blocked' | 'build_failed' | 'test_failed' | 'commit' | 'error' | 'ci_failed' | 'ci_recovered' | 'github_notification' | 'pr_improved' | 'pr_failed' | 'pr_conflict_detected' | 'pr_conflict_resolving' | 'pr_conflict_resolved' | 'pr_conflict_failed';
  session: string;
  message: string;
  issueId?: string;
  timestamp: number;
  url?: string;
};

/**
 * A single MCP server entry: stdio (`command`/`args`/`env`) or remote
 * (`url`/`headers`). Mirrors the ~/.openswarm/mcp.json shape. (INT-1949)
 */
export type McpServerConfig = {
  /** Reference a built-in preset (e.g. `linear`) instead of command/url. (INT-1952) */
  preset?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: 'stdio' | 'http' | 'sse';
};

/** MCP servers declared in config.yaml (merged into the mcp.json registry). */
export type McpConfig = {
  servers: Record<string, McpServerConfig>;
};

/**
 * Global configuration
 */
export type SwarmConfig = {
  /** Default CLI adapter */
  adapter?: 'codex' | 'codex-responses' | 'gpt' | 'local' | 'lmstudio' | 'openrouter' | 'atlascloud' | 'claude' | 'cc-router' | 'cursor';
  /** UI language: 'en' | 'ko' (default: 'en') */
  language: 'en' | 'ko';
  /** Discord bot token */
  discordToken: string;
  /** Discord channel ID (for reporting) */
  discordChannelId: string;
  /** Discord Webhook URL (optional) */
  discordWebhookUrl?: string;
  /** Outbound notification channel (Discord/Slack/Telegram/webhook) — INT-1576 */
  notifications?: NotificationsConfig;
  /** Linear API key */
  linearApiKey: string;
  /** Linear team ID */
  linearTeamId: string;
  /** Agent session list */
  agents: AgentSession[];
  /** Anonymous usage telemetry (opt-out). undefined = default on. (INT-1992) */
  telemetry?: { enabled: boolean };
  /** Default heartbeat interval (ms) */
  defaultHeartbeatInterval: number;
  /** GitHub repo list (for CI monitoring) */
  githubRepos?: string[];
  /** GitHub CI check interval (ms) */
  githubCheckInterval?: number;
  /** Time window config (agent autonomous work restriction) */
  timeWindow?: TimeWindowConfig;
  /** Worker/Reviewer pair mode config */
  pairMode?: PairModeConfig;
  /** Autonomous execution mode config */
  autonomous?: AutonomousStartupConfig;
  /** PR auto-improvement config */
  prProcessor?: PRProcessorConfig;
  /** CI failure investigation worker config */
  ciWorker?: CIWorkerConfig;
  /** Long-running task monitor configuration */
  monitors?: LongRunningMonitorConfig[];
  /** Daily status report scheduler config */
  dailyReporter?: DailyReporterConfig;
  /** MCP servers declared in config (merged into ~/.openswarm/mcp.json registry) — INT-1949 */
  mcp?: McpConfig;
};

/**
 * PR auto-improvement config
 */
export type PRProcessorConfig = {
  /** Enabled */
  enabled: boolean;
  /** Check schedule (cron) */
  schedule: string;
  /** Cooldown after processing (hours) */
  cooldownHours: number;
  /** Worker-Reviewer max iteration count */
  maxIterations: number;
  /** Max retry attempts per PR (default: 3) */
  maxRetries?: number;
  /** CI completion timeout (ms) (default: 600000 = 10min) */
  ciTimeoutMs?: number;
  /** CI polling interval (ms) (default: 30000 = 30s) */
  ciPollIntervalMs?: number;
  /** Conflict resolver config */
  conflictResolver?: ConflictResolverConfig;
  /** Custom repo → local path mappings */
  repoMappings?: Record<string, string>;
};

/**
 * Conflict resolver config
 */
export type ConflictResolverConfig = {
  /** Enable conflict auto-resolution */
  enabled: boolean;
  /** Ownership mode: 'auto' = bot PRs only, 'all' = all PRs */
  ownershipMode: 'auto' | 'all';
  /** Max resolution attempts per PR (default: 3) */
  maxResolutionAttempts: number;
  /** Check stacked PRs after resolving one (default: true) */
  cascadeCheck: boolean;
  /** Worker model for conflict resolution */
  workerModel?: string;
  /** Worker timeout (ms) */
  workerTimeoutMs?: number;
};

/**
 * CI failure investigation worker config
 */
export type CIWorkerConfig = {
  /** Enabled */
  enabled: boolean;
  /** Check interval in ms (default: 300000 = 5 minutes) */
  checkIntervalMs?: number;
  /** Auto-retry flaky tests */
  autoRetry?: boolean;
  /** Create Linear issues for failures */
  createIssues?: boolean;
  /** Max age of failures to consider (days) (default: 30) */
  maxAgeDays?: number;
};

/**
 * Service state
 */
export type ServiceState = {
  running: boolean;
  startedAt?: number;
  agents: Map<string, AgentStatus>;
  timers: Map<string, NodeJS.Timeout>;
};

/**
 * Time range
 */
export type TimeRange = {
  start: string; // "HH:MM" (24-hour format)
  end: string;
};

/**
 * Time window configuration
 */
export type TimeWindowConfig = {
  /** Whether time restriction is enabled */
  enabled: boolean;
  /** Allowed work time ranges */
  allowedWindows: TimeRange[];
  /** Blocked time ranges (e.g. market hours) */
  blockedWindows: TimeRange[];
  /** Restricted days of week (0=Sun, 1=Mon, ..., 6=Sat) */
  restrictedDays?: number[];
  /** Timezone */
  timezone?: string;
};

/**
 * Worker/Reviewer pair mode configuration
 */
export type PairModeConfig = {
  /** Enable pair mode */
  enabled: boolean;
  /** Worker max attempts */
  maxAttempts: number;
  /** Worker timeout (ms) */
  workerTimeoutMs: number;
  /** Reviewer timeout (ms) */
  reviewerTimeoutMs: number;
  /** Webhook URL (notification on complete/failure) */
  webhookUrl?: string;
  /** Auto Linear status update */
  autoLinearUpdate: boolean;
};

/**
 * Model configuration
 */
export type ModelConfig = {
  /** Worker agent model */
  worker: string;
  /** Reviewer agent model */
  reviewer: string;
};

/**
 * Per-role configuration
 */
export type AgentAdapterName = 'codex' | 'codex-responses' | 'gpt' | 'local' | 'lmstudio' | 'openrouter' | 'atlascloud' | 'claude' | 'cc-router' | 'cursor';

export type WorkerFanoutCandidateConfig = {
  /** Stable display/id for logs and scoring. */
  id: string;
  /** Candidate adapter override. Omit to inherit the worker role adapter. */
  adapter?: AgentAdapterName;
  /** Candidate model override. Omit to inherit the resolved worker model. */
  model?: string;
  /** Candidate reasoning effort override. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Candidate max agentic turns override. */
  maxTurns?: number;
  /** Candidate no-edit guard override. */
  nudgeMaxOnNoEdit?: number;
  /** Candidate web tool exposure override. */
  webTools?: boolean;
  /** Candidate memory tool exposure override. */
  memoryTools?: boolean;
};

export type RoleConfig = {
  /** Whether role is enabled */
  enabled: boolean;
  /** CLI adapter name */
  adapter?: AgentAdapterName;
  /** Model ID. Omit → resolved dynamically from the role's adapter (getDefaultModel). */
  model?: string;
  /** Timeout (ms), 0 = unlimited */
  timeoutMs: number;
  /** Model to escalate to on repeated failure */
  escalateModel?: string;
  /** Escalate after this iteration number (default: 3) */
  escalateAfterIteration?: number;
  /** Max agentic turns per CLI invocation */
  maxTurns?: number;
  /**
   * Adaptive worker fan-out gate and optional candidate execution.
   */
  fanout?: {
    /** Enable gate evaluation (default true when omitted). */
    enabled?: boolean;
    /** Report only or execute candidate workers (default report). */
    mode?: 'report' | 'execute';
    /** Minimum signal score required to recommend fan-out (default 2). */
    minScore?: number;
    /** Max candidate workers in flight (default candidates length, capped at 3). */
    concurrency?: number;
    /** Keep temporary candidate repos for debugging. */
    keepSandboxes?: boolean;
    /** Shared paths default to sandbox-local copies; true symlinks them, false disables them. */
    linkSharedPaths?: boolean;
    /** Candidate lanes. Omit for primary + Spark diversity defaults. */
    candidates?: WorkerFanoutCandidateConfig[];
  };
};

/**
 * Pipeline stage
 */
export type PipelineStage = 'worker' | 'reviewer' | 'tester' | 'documenter' | 'auditor' | 'skill-documenter';

export type JobProfile = {
  name: string;
  minMinutes?: number;
  maxMinutes?: number;
  priority?: number;
  /** Reasoning effort for matched tasks (codex-responses: low|medium|high). */
  effort?: 'low' | 'medium' | 'high';
  roles?: Partial<Record<PipelineStage, string>>;
};

/**
 * Per-project agent configuration
 */
export type ProjectAgentConfig = {
  /** Project path */
  projectPath: string;
  /** Linear project ID (optional) */
  linearProjectId?: string;
  /** Per-role configuration override */
  roles?: {
    worker?: Partial<RoleConfig>;
    reviewer?: Partial<RoleConfig>;
    tester?: Partial<RoleConfig>;
    documenter?: Partial<RoleConfig>;
    auditor?: Partial<RoleConfig>;
    'skill-documenter'?: Partial<RoleConfig>;
  };
};

/**
 * Default roles configuration
 */
export type DefaultRolesConfig = {
  worker: RoleConfig;
  reviewer: RoleConfig;
  tester?: RoleConfig;
  documenter?: RoleConfig;
  auditor?: RoleConfig;
  'skill-documenter'?: RoleConfig;
};

/**
 * Task decomposition (Planner) configuration
 */
export type DecompositionConfig = {
  /** Enable decomposition */
  enabled: boolean;
  /** Decomposition threshold (minutes) - tasks exceeding this estimate are decomposed */
  thresholdMinutes: number;
  /** Max decomposition depth (default: 2) - prevents infinite nesting */
  maxDepth?: number;
  /** Max children per task (default: 5) - prevents issue explosion */
  maxChildrenPerTask?: number;
  /** Daily issue creation limit (default: 20) - prevents runaway creation */
  dailyLimit?: number;
  /** Auto-move to backlog if too complex or failing (default: true) */
  autoBacklog?: boolean;
  /** Planner model */
  plannerModel: string;
  /** Planner timeout (ms) - default 600000 (10min) */
  plannerTimeoutMs: number;
};

export type BacklogGroomingConfig = {
  enabled: boolean;
  cadenceHours?: number;
  mode?: 'comment' | 'apply';
  plannerModel?: string;
  plannerTimeoutMs?: number;
  maxIssues?: number;
};

/**
 * Autonomous execution mode configuration
 */
// Long-Running Monitor Types

/** Completion check strategy */
export type CompletionCheck =
  | { type: 'exit-code'; successExitCode?: number }
  | { type: 'output-regex'; successPattern: string; failurePattern?: string }
  | { type: 'http-status'; expectedStatus?: number };

/** Monitor configuration (registered via config.yaml or API) */
export type LongRunningMonitorConfig = {
  id: string;
  name: string;
  /**
   * Argv-style command for status check. Executed via `execFile` without a
   * shell — no pipes, redirects, or substitutions. If you need shell
   * semantics, invoke a script you control: `["/opt/myprobe.sh", "arg"]`.
   */
  checkCommand: string[];
  completionCheck: CompletionCheck;
  /** Linear issue ID (comments on state change) */
  issueId?: string;
  /** Check every Nth heartbeat (default 1 = every time) */
  checkInterval?: number;
  /** Timeout duration in hours (default 48) */
  maxDurationHours?: number;
  /** Discord notification (default true) */
  notify?: boolean;
  metadata?: Record<string, unknown>;
};

/** Monitor runtime state */
export type MonitorState = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

/** Runtime monitor (config + state) */
export type LongRunningMonitor = LongRunningMonitorConfig & {
  state: MonitorState;
  registeredAt: number;
  lastCheckedAt?: number;
  checkCount: number;
  heartbeatsSinceRegister: number;
  lastOutput?: string;
  lastExitCode?: number;
};

/**
 * Pipeline guards configuration
 */
export interface PipelineGuardsConfig {
  qualityGate: boolean;
  fakeDataGuard: boolean;
  conventionalCommits: boolean;
  branchValidation: boolean;
  uncertaintyDetection: boolean;
  haltToLinear: boolean;
  registryCheck: boolean;
  bsDetector: boolean;
  /** Block dependency/import failure fixes that spoof package identity (INT-2388 #1). */
  dependencyAntiPatternCheck?: boolean;
  /** Block self-referential contract tests without producer/consumer evidence (INT-2388 #2). */
  contractEvidenceCheck?: boolean;
  /** Block verified-evidence deletion and metric changes without before/after evidence (INT-2388 #4). */
  verifiedMetricEvidenceCheck?: boolean;
  /** Flag newly-added source modules that nothing imports/calls (INT-2388 #5). */
  deadModuleCheck?: boolean;
  /** Flag reformat-only files and oversized diffs — scope creep (INT-2388 #6). */
  reformatCheck?: boolean;
  /**
   * When the reviewer approves, file its recommendedActions as follow-up
   * sub-issues (INT-1611 / INT-1704). Optional, default OFF. (INT-1704)
   */
  autoFileFollowups?: boolean;
}

export type VerifyConfig = {
  enabled: boolean;
  blockOnNewFailures: boolean;
  maxCommands: number;
};

export type SecurityAuditConfig = {
  enabled: boolean;
  maxThreads: number;
  /** Memory target passed to each CodeQL run, in MB. Best-effort: CodeQL's own
   *  help says a large database may still break the threshold, so the
   *  concurrency gate — not this — is what actually bounds total usage. */
  maxRamMb: number;
};

export type AutonomousStartupConfig = {
  /** Auto-enable on service start */
  enabled: boolean;
  /** Use Worker/Reviewer pair mode */
  pairMode: boolean;
  /** Execution schedule (cron expression) */
  schedule: string;
  /** Pair mode max attempts */
  maxAttempts: number;
  /** Allowed project paths */
  allowedProjects: string[];
  /** Treat Linear Backlog as a work queue (legacy). Default false = Backlog parked (R5). */
  includeBacklog?: boolean;
  /** Model configuration (legacy) */
  models?: ModelConfig;
  /** Worker timeout (ms), 0 = unlimited (legacy) */
  workerTimeoutMs?: number;
  /** Reviewer timeout (ms), 0 = unlimited (legacy) */
  reviewerTimeoutMs?: number;
  /** Max concurrent tasks */
  maxConcurrentTasks?: number;
  /** Max concurrent tasks from the same project when same-project parallelism is enabled. */
  maxConcurrentPerProject?: number;
  /** Durable execution ledger rollout mode. */
  automationLedgerMode?: 'off' | 'shadow' | 'primary';
  automationDbPath?: string;
  automationLeaseMs?: number;
  shutdownGraceMs?: number;
  /** Default role configuration */
  defaultRoles?: DefaultRolesConfig;
  /** Per-project agent configuration */
  projectAgents?: ProjectAgentConfig[];
  /** Task decomposition config (Planner Agent) */
  decomposition?: DecompositionConfig;
  /** Whole-backlog grooming planner config */
  backlogGrooming?: BacklogGroomingConfig;
  /** Git worktree mode: work in independent worktree per issue and auto-create PR */
  worktreeMode?: boolean;
  /**
   * Allow concurrent tasks on the SAME repo. Requires worktreeMode (per-task
   * filesystem isolation); ignored otherwise to avoid corrupting a shared tree.
   * Non-conflicting issues are still gated by KG file-conflict detection and the
   * blockedBy dependency graph. Default: true. (INT-1975)
   */
  allowSameProjectConcurrent?: boolean;
  /** Pipeline guards configuration */
  guards?: Partial<PipelineGuardsConfig>;
  /** Deterministic baseline-diff verification, enabled by default. */
  verify?: VerifyConfig;
  /** CodeQL baseline-diff gate for autonomous worker edits, enabled by default. */
  securityAudit?: SecurityAuditConfig;
  /**
   * Max objective self-repair attempts (lint/bs/test failures) tolerated before
   * the bad-edit/reflection loop gives up. Independent of maxAttempts so it can
   * be lowered to cap token burn when reflection stops making progress.
   * Default: 3.
   */
  maxReflections?: number;
  /** Cooldown between task completions in ms (default: 1800000 = 30min) */
  interTaskCooldownMs?: number;
  /** Job profiles used to select models based on task traits */
  jobProfiles?: JobProfile[];
  coordinationBoardIssueId?: string;
  mcpPolicies?: Record<string, { servers: string[]; allowTools?: string[]; writeTools?: string[]; destructiveTools?: string[] }>;
  adapterRouting?: { primary?: import('../adapters/types.js').AdapterName; fallbacks?: Array<'cc-router' | 'cursor' | 'codex' | 'codex-responses'>; allowReasons?: Array<'quota' | 'infra' | 'capability'> };
  periodicReviews?: Array<{ profile: 'permissions' | 'hygiene' | 'security' | 'review'; schedule: string; adapter?: 'codex' | 'cc-router' | 'cursor' }>;
  /** Cron schedule for the MCP-connected orchestrator sweep. Omit to disable. */
  orchestratorSchedule?: string;
};

/**
 * Daily status report scheduler configuration
 */
export type DailyReporterConfig = {
  /** Enable daily status reports */
  enabled: boolean;
  /** Cron schedule (default: "0 18 * * *" for 6 PM daily) */
  schedule: string;
};
