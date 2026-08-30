// ============================================
// OpenSwarm - Autonomous Runner Types
// ============================================

import type { DecisionResult, TaskItem } from '../orchestration/decisionEngine.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import type { BacklogGroomingConfig, DefaultRolesConfig, ProjectAgentConfig, JobProfile, OrchestratorConfig, SecurityAuditConfig, VerifyConfig } from '../core/types.js';
import type { RoleMcpPolicy } from '../coordination/mcpPolicy.js';

export interface AutonomousConfig {
  defaultAdapter?: 'codex' | 'codex-responses' | 'gpt' | 'local' | 'lmstudio' | 'openrouter' | 'atlascloud' | 'claude' | 'cc-router' | 'cursor';
  linearTeamId: string;
  allowedProjects: string[];
  heartbeatSchedule: string;
  autoExecute: boolean;
  discordChannelId?: string;
  dryRun: boolean;
  /** Treat Linear Backlog as a work queue (legacy). Default false = Backlog parked (R5). */
  includeBacklog?: boolean;
  pairMode?: boolean;
  pairMaxAttempts?: number;
  workerModel?: string;
  reviewerModel?: string;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  triggerNow?: boolean;
  /**
   * When false the runner starts without its heartbeat cron: no backlog is
   * fetched and no issue is ever picked on its own. Everything else (durable
   * recovery, worktree pruning, the scheduler, explicit enqueueIssues() calls
   * from the CLI/dashboard) still works. Default true. (INT-3388)
   */
  autonomousHeartbeat?: boolean;
  maxConcurrentTasks?: number;
  /** Move unowned In Progress issues back to Backlog after this many idle hours. */
  stalledInProgressHours?: number;
  /** Optional hard cap; omitted uses work-conserving weighted project fairness. */
  maxConcurrentPerProject?: number;
  defaultRoles?: DefaultRolesConfig;
  projectAgents?: ProjectAgentConfig[];
  enableDecomposition?: boolean;
  decompositionThresholdMinutes?: number;
  plannerModel?: string;
  plannerTimeoutMs?: number;
  decomposition?: import('../core/types.js').DecompositionConfig;
  backlogGrooming?: BacklogGroomingConfig;
  worktreeMode?: boolean;
  /** Allow concurrent tasks on the same repo (requires worktreeMode). Default true. (INT-1975) */
  allowSameProjectConcurrent?: boolean;
  guards?: Partial<import('../core/types.js').PipelineGuardsConfig>;
  verify?: VerifyConfig;
  securityAudit?: SecurityAuditConfig;
  /** Max objective self-repair attempts (lint/bs/test) before giving up (default: 3) */
  maxReflections?: number;
  jobProfiles?: JobProfile[];
  /** Durable execution ledger rollout mode. Production default: primary. */
  automationLedgerMode?: 'off' | 'shadow' | 'primary';
  /** Override ~/.openswarm/automation.db (primarily tests/operations). */
  automationDbPath?: string;
  /** Fenced execution lease duration; renewed at one third of this interval. */
  automationLeaseMs?: number;
  /** Grace period for real executor exit during service shutdown. */
  shutdownGraceMs?: number;
  /** Project-scoped coordination issue ID used as the durable Linear agent board. */
  coordinationBoardIssueId?: string;
  /** Role-scoped MCP policies; orchestrator defaults to no tools. */
  mcpPolicies?: Partial<Record<'orchestrator' | 'worker' | 'reviewer', RoleMcpPolicy>>;
  /** Typed execution adapter routing policy. */
  adapterRouting?: { primary?: import('../adapters/types.js').AdapterName; fallbacks?: Array<'cc-router' | 'cursor' | 'codex' | 'codex-responses'>; allowReasons?: Array<'quota' | 'infra' | 'capability'> };
  /** Periodic read-only repository review jobs. */
  periodicReviews?: Array<{ profile: 'permissions' | 'hygiene' | 'security' | 'review'; schedule: string; adapter?: 'codex' | 'cc-router' | 'cursor' }>;
  /** Explicit high-capability project supervisor. */
  orchestrator?: OrchestratorConfig;
  /** Cron schedule for the MCP-connected orchestrator sweep. Omit to disable. */
  /** @deprecated Use `orchestrator.schedule`. */
  orchestratorSchedule?: string;
}

export interface RunnerState {
  isRunning: boolean;
  lastHeartbeat: number;
  lastDecision?: DecisionResult;
  lastExecution?: ExecutorResult;
  pendingApproval?: TaskItem;
  consecutiveErrors: number;
  startedAt?: number;
}
