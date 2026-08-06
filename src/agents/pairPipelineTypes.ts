import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig, PipelineGuardsConfig, JobProfile, VerifyConfig } from '../core/types.js';
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

export interface PipelineRunMetadata {
  repository?: string;
  projectPath?: string;
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
  jobProfiles?: JobProfile[];
  runMetadata?: PipelineRunMetadata;
  skipTesterIfNoCodeChange?: boolean;
  skipAuditorUnderFileCount?: number;
  verbose?: boolean;
  /** Task-owned files already committed in a preserved WIP chain before this run. */
  resumedTaskFiles?: string[];
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
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed' | 'superseded' | 'rate_limited' | 'infra_error';
  failureSignal?: 'gate-fail' | 'timeout' | 'stuck';
  stuckReason?: string;
  rateLimitResetsAt?: number;
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
}

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
  /** Pair-level stagnation detector reason, preserved so the scheduler does not rerun the same loop. */
  stuckReason?: string;
}

export type PipelineEventType = 'stage:start' | 'stage:complete' | 'stage:fail' | 'iteration:start' | 'iteration:complete' | 'iteration:fail' | 'pipeline:complete' | 'pipeline:fail' | 'fanout:gate' | 'halt';
