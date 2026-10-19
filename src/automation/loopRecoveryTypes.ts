import type { RoleConfig } from '../core/types.js';
import type { StageResult } from '../agents/pairPipelineTypes.js';
import type { CostInfo } from '../support/costTracker.js';

export const RECOVERY_ADVISOR_PARK_REASON = 'recovery_advisor_park';

export interface LoopAdvisorConfig {
  mode: 'off' | 'shadow' | 'active';
  adapter?: RoleConfig['adapter'];
  model?: string;
  timeoutMs?: number;
  triggerAfter?: number;
  maxCallsPerIssue24h?: number;
}

export type RecoveryCause = 'quality' | 'infra' | 'quota' | 'configuration' | 'no_progress'
  | 'review_conflict' | 'operator_wait' | 'outcome_unknown' | 'cancelled';
export type RecoveryAction = 'retry_stage' | 'revise_strategy' | 'switch_model' | 'verify_claim'
  | 'wait' | 'ask_operator' | 'stop';

export interface ExecutionContract {
  version: 1;
  issueId: string;
  repository: string;
  taskHash: string;
  policyHash: string;
  budgetMs?: number;
  acceptance: string[];
  allowedFiles: string[];
}

export interface ProgressSnapshot {
  stage: string;
  artifactDigest?: string;
  environmentDigest?: string;
  checks: string[];
  cause?: RecoveryCause;
  failureFingerprint?: string;
  consecutiveNoProgress: number;
  observedAt: number;
  observability: 'native' | 'stage';
  terminationCause?: 'no_progress';
}

export interface AdviceDecision {
  diagnosis: string;
  evidence: string[];
  action: RecoveryAction;
  condition: string;
  verification: string;
  model?: string;
  premiseDisposition?: 'supported' | 'refuted' | 'unknown';
}

export interface AdviceRecord {
  id: string;
  evidenceKey: string;
  status: 'processing' | 'completed' | 'unavailable' | 'interrupted';
  mode: 'shadow' | 'active';
  decision?: AdviceDecision;
  reason?: string;
  applied: boolean;
  premiseVerification?: { disposition: 'supported' | 'refuted' | 'unknown'; evidence: string[]; reason: string };
  costInfo?: CostInfo;
  createdAt: number;
}

export interface RecoveryStatus {
  contract?: ExecutionContract;
  progress?: ProgressSnapshot;
  advice?: AdviceRecord;
  nextAction?: RecoveryAction;
  reason?: string;
}

export interface RecoveryCheckpoint {
  contractHash: string;
  artifactDigest: string;
  environmentHash: string;
  stage: StageResult['stage'];
  result: StageResult;
  runSnapshotHash?: string;
}

/** 동일 SQLite 연결과 현재 claim으로만 원장을 변경한다. */
export interface RecoveryHooks {
  isCurrent(): boolean;
  canAdvise(): boolean;
  contract(value: ExecutionContract): void;
  observe(value: Omit<ProgressSnapshot, 'consecutiveNoProgress'>): ProgressSnapshot;
  checkpoint(value: RecoveryCheckpoint): void;
  resume(contractHash: string, artifactDigest: string, environmentHash: string): RecoveryCheckpoint[];
  resumable(stage: string | undefined): void;
  settle(success: boolean): void;
  reserveAdvice(evidenceKey: string, mode: 'shadow' | 'active', maxCalls: number): AdviceRecord | undefined;
  finishAdvice(id: string, update: Pick<AdviceRecord, 'status' | 'decision' | 'reason' | 'applied' | 'costInfo' | 'premiseVerification'>): boolean;
  status(): RecoveryStatus;
  advice(evidenceKey: string): AdviceRecord | undefined;
}
