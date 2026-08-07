// ============================================
// OpenSwarm - Autonomous Runner Types
// ============================================

import type { DecisionResult, TaskItem } from '../orchestration/decisionEngine.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import type { BacklogGroomingConfig, DefaultRolesConfig, ProjectAgentConfig, JobProfile, VerifyConfig } from '../core/types.js';

export interface AutonomousConfig {
  defaultAdapter?: 'codex' | 'codex-responses' | 'gpt' | 'local' | 'lmstudio' | 'openrouter' | 'atlascloud' | 'claude';
  linearTeamId: string;
  allowedProjects: string[];
  heartbeatSchedule: string;
  autoExecute: boolean;
  discordChannelId?: string;
  maxConsecutiveTasks: number;
  cooldownSeconds: number;
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
  /** Max objective self-repair attempts (lint/bs/test) before giving up (default: 3) */
  maxReflections?: number;
  /** Cooldown between task completions in ms (default: 1800000 = 30min) */
  interTaskCooldownMs?: number;
  jobProfiles?: JobProfile[];
  /** Durable execution ledger rollout mode. Production default: primary. */
  automationLedgerMode?: 'off' | 'shadow' | 'primary';
  /** Override ~/.openswarm/automation.db (primarily tests/operations). */
  automationDbPath?: string;
  /** Fenced execution lease duration; renewed at one third of this interval. */
  automationLeaseMs?: number;
  /** Grace period for real executor exit during service shutdown. */
  shutdownGraceMs?: number;
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
