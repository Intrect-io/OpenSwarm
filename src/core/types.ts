// ============================================
// OpenSwarm - Type Definitions
// ============================================

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
  priority: number;
  labels: string[];
  comments: LinearComment[];
  /** Linear project info */
  project?: LinearProjectInfo;
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
 * Global configuration
 */
export type SwarmConfig = {
  /** UI language: 'en' | 'ko' (default: 'en') */
  language: 'en' | 'ko';
  /** Discord bot token */
  discordToken: string;
  /** Discord channel ID (for reporting) */
  discordChannelId: string;
  /** Discord Webhook URL (optional) */
  discordWebhookUrl?: string;
  /** Linear API key */
  linearApiKey: string;
  /** Linear team ID */
  linearTeamId: string;
  /** Agent session list */
  agents: AgentSession[];
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
  /** Long-running task monitor configuration */
  monitors?: LongRunningMonitorConfig[];
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
export type RoleConfig = {
  /** Whether role is enabled */
  enabled: boolean;
  /** Model ID */
  model: string;
  /** Timeout (ms), 0 = unlimited */
  timeoutMs: number;
  /** Model to escalate to on repeated failure */
  escalateModel?: string;
  /** Escalate after this iteration number (default: 3) */
  escalateAfterIteration?: number;
};

/**
 * Pipeline stage
 */
export type PipelineStage = 'worker' | 'reviewer' | 'tester' | 'documenter' | 'auditor' | 'skill-documenter';

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

/**
 * Autonomous execution mode configuration
 */
// ============================================
// Long-Running Monitor Types
// ============================================

/** Completion check strategy */
export type CompletionCheck =
  | { type: 'exit-code'; successExitCode?: number }
  | { type: 'output-regex'; successPattern: string; failurePattern?: string }
  | { type: 'http-status'; expectedStatus?: number };

/** Monitor configuration (registered via config.yaml or API) */
export type LongRunningMonitorConfig = {
  id: string;
  name: string;
  /** Bash command for status check */
  checkCommand: string;
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
  /** Model configuration (legacy) */
  models?: ModelConfig;
  /** Worker timeout (ms), 0 = unlimited (legacy) */
  workerTimeoutMs?: number;
  /** Reviewer timeout (ms), 0 = unlimited (legacy) */
  reviewerTimeoutMs?: number;
  /** Max concurrent tasks */
  maxConcurrentTasks?: number;
  /** Default role configuration */
  defaultRoles?: DefaultRolesConfig;
  /** Per-project agent configuration */
  projectAgents?: ProjectAgentConfig[];
  /** Task decomposition config (Planner Agent) */
  decomposition?: DecompositionConfig;
  /** Git worktree mode: work in independent worktree per issue and auto-create PR */
  worktreeMode?: boolean;
};
