import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig, PipelineGuardsConfig, JobProfile, SecurityAuditConfig, VerifyConfig } from '../core/types.js';
import type { CostInfo } from '../support/costTracker.js';
import type { WorkerResult, ReviewResult, PairSession } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { GuardsRunResult } from './pipelineGuards.js';
import type { ReflectionState } from './reflection.js';
import type { WorkerFanoutGateDecision } from './workerFanoutGate.js';
import type { VerifyCommand } from '../verify/manifest.js';
import type { ToolDefinition } from '../adapters/tools.js';
import type { AdapterRoutePolicy } from '../coordination/routingPolicy.js';
import type { InstructionCapsule } from './instructionCapsule.js';

export interface PipelineRunMetadata {
  repository?: string;
  projectPath?: string;
  /** Canonical main-checkout path used by the coordination board. */
  coordinationRepository?: string;
  /** Opaque repository-cell identity shared by sibling worktrees. */
  repoKey?: string;
  worktree?: string;
  branch?: string;
  issueIdentifier?: string;
  title?: string;
}

export interface PipelineConfig {
  stages: PipelineStage[];
  continueOnTestFail?: boolean;
  skipDocumenterIfNoChange?: boolean;
  maxIterations?: number;
  maxReflections?: number;
  roles?: {
    worker?: RoleConfig;
    reviewer?: RoleConfig;
    tester?: RoleConfig;
    documenter?: RoleConfig;
    auditor?: RoleConfig;
    'skill-documenter'?: RoleConfig;
  };
  guards?: Partial<PipelineGuardsConfig>;
  verify?: VerifyConfig;
  securityAudit?: SecurityAuditConfig;
  jobProfiles?: JobProfile[];
  runMetadata?: PipelineRunMetadata;
  skipTesterIfNoCodeChange?: boolean;
  skipAuditorUnderFileCount?: number;
  verbose?: boolean;
  /** Task-owned files already committed in a preserved WIP chain before this run. */
  resumedTaskFiles?: string[];
  /** Claude Code instructions/runbooks captured before the run starts. */
  instructionCapsule?: InstructionCapsule;
  roleMcpTools?: { worker?: ToolDefinition[]; reviewer?: ToolDefinition[] };
  adapterRouting?: AdapterRoutePolicy;
  draftAnalysis?: {
    taskType: string;
    intentSummary: string;
    relevantFiles: string[];
    suggestedApproach: string;
    projectStats?: string;
    completionCriteria?: string[];
    sufficient?: boolean;
    impactAnalysis?: import('../knowledge/types.js').ImpactAnalysis;
    registrySnapshot?: Array<{ filePath: string; summary: string; highlights: string[] }>;
  };
}

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult | { success: false; error: string };
  duration: number;
  startedAt: number;
  completedAt: number;
}

export interface PipelineResult {
  success: boolean;
  sessionId: string;
  stages: StageResult[];
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed' | 'superseded' | 'deferred' | 'rate_limited' | 'infra_error' | 'waiting_on_operator';
  /**
   * Set only when `finalStatus === 'infra_error'` and the cause is the
   * repository itself (disk full, `.git` lock, corrupt repo — a failed
   * `git worktree add`), not an adapter timeout, tooling failure, or network
   * blip. The repository failure circuit reads this to count only the former:
   * an adapter retrying on a fixed clock is not the repository failing, and
   * lumping the two together can close a healthy repository to every other
   * task over transient LLM/network noise (AGT-4038).
   */
  repositoryInfra?: boolean;
  failureSignal?: 'gate-fail' | 'timeout' | 'stuck';
  stuckReason?: string;
  rateLimitResetsAt?: number;
  /** Earliest epoch-ms at which a transiently deferred run may be retried. */
  retryAt?: number;
  totalDuration: number;
  iterations: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  /** The last REAL reviewer revise feedback. `reviewResult` can end up holding a
   *  synthetic entry (validation nudge / HALT overwrite it), which made failed
   *  sessions persist "Unknown error"-grade detail for the retry (INT-2504). */
  lastReviewFeedback?: string;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  taskContext?: {
    issueIdentifier?: string;
    projectName?: string;
    projectPath?: string;
    taskTitle?: string;
  };
  prUrl?: string;
  totalCost?: CostInfo;
  /**
   * Cause of a failure that happened outside the staged pipeline — today the
   * publication step, which runs after every stage succeeded. `stages[]`
   * cannot carry it (there is no 'pr' stage), and without it the ledger
   * recorded these attempts with no message at all (vela AGT-3844: 48
   * attempts, half of them blank).
   */
  failureDetail?: string;
  /**
   * A deterministic failure that an operator has to resolve. The coordinator
   * parks the run as NEEDS_HUMAN under `code` instead of scheduling a retry:
   * the publication-scope fence rejecting files already committed on the
   * branch cannot be retried into success, and vela spent 23/48/15 attempts
   * on three such runs on 2026-09-02 before anyone looked.
   */
  operatorPark?: { code: string; reason: string };
}

/**
 * NEEDS_HUMAN code for a worker that delivered no edits — either with an
 * explicit `noChangesReason` (publication then has nothing to open a PR from)
 * or by repeating the empty-result contract violation until the session gave
 * up. Both mean the same thing to an operator: the agent will not produce a
 * diff for this issue as written.
 */
export const WORKER_NO_CHANGES_PARK_REASON = 'worker_no_changes';

export interface PipelineContext {
  task: TaskItem;
  projectPath: string;
  session: PairSession;
  config: PipelineConfig;
  currentIteration: number;
  taskPrefix: string;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  guardsResult?: GuardsRunResult;
  reflection: ReflectionState;
  feedbackSource?: 'objective' | 'review';
  workerFanoutDecision?: WorkerFanoutGateDecision;
  /** Feedback of the previous reviewer 'revise' — compared against the next one to detect a repeating reviewer (INT-2474). */
  lastReviseFeedback?: string;
  /** One-shot worker escalation triggered by repeated similar revise feedback: higher model and/or effort for the retry (INT-2475). */
  workerEscalation?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high' };
  /** The missing-validation-evidence gate has already nudged once this session — after that it defers to the reviewer instead of consuming more iterations (INT-2485). */
  validationNudged?: boolean;
  /** Commands captured before the worker runs, preventing self-modification of the verification gate. */
  trustedVerifyCommands?: VerifyCommand[];
  trustedVerifyPackageJsonByDirectory?: Record<string, string>;
  trustedVerifyInputFingerprint?: string;
  /** Deferred capture error so invalid manifests retain tester-stage failure semantics. */
  trustedVerifyError?: unknown;
  securityBaseline?: import('../verify/securityAudit.js').SecurityAuditResult;
  newSecurityFindings?: import('../verify/securityAudit.js').SecurityFinding[];
  /** Pair-level stagnation detector reason, preserved so the scheduler does not rerun the same loop. */
  stuckReason?: string;
}

export type PipelineEventType = 'stage:start' | 'stage:complete' | 'stage:fail' | 'iteration:start' | 'iteration:complete' | 'iteration:fail' | 'pipeline:complete' | 'pipeline:fail' | 'fanout:gate' | 'halt';
