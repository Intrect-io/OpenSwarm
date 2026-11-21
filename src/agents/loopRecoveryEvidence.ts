import { recoveryHash } from '../automation/runRecoveryStore.js';
import type { ExecutionContract, RecoveryCause } from '../automation/loopRecoveryTypes.js';
import type { PipelineContext, StageResult } from './pairPipelineTypes.js';
import { infraFailureFingerprint } from '../automation/infraFailureCircuit.js';
import { enforcedFileScope } from '../orchestration/writeScope.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { redactCoordinationMetadata } from '../coordination/coordinationStore.js';
import { isInfraError } from '../adapters/errorClassification.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

export function recoveryText(value: string): string {
  return String(redactCoordinationMetadata({ text: value })?.text ?? '');
}

export function executionContract(context: PipelineContext): ExecutionContract {
  const task = context.task;
  return { version: 1, issueId: taskEventKey(task),
    repository: context.config.runMetadata?.coordinationRepository ?? context.projectPath,
    taskHash: recoveryHash([task.title, task.description, task.authoritativeOperatorFeedback]),
    budgetMs: context.config.taskBudgetMs,
    policyHash: recoveryHash([context.config.stages, context.config.roles, context.config.guards,
      context.config.verify, context.config.securityAudit, context.config.workerSandbox,
      context.config.instructionCapsule, context.config.projectGoal, context.config.loopAdvisor,
      context.config.roleMcpTools, context.config.adapterRouting, context.config.jobProfiles,
      context.config.maxIterations, context.config.maxReflections]),
    acceptance: context.config.draftAnalysis?.completionCriteria ?? [],
    allowedFiles: enforcedFileScope(task) ?? [] };
}

/** Preserve the exception's transport classification first and never treat model prose as execution authority. */
export function recoveryCause(message: string, result?: StageResult['result'], transportError?: unknown): RecoveryCause {
  const worker = result as { blockedOnOperator?: boolean; executionOutcomeUnknown?: boolean; terminationCause?: string } | undefined;
  if (worker?.executionOutcomeUnknown) return 'outcome_unknown';
  if (worker?.blockedOnOperator) return 'operator_wait';
  if (worker?.terminationCause === 'no_progress') return 'no_progress';
  if (transportError instanceof RateLimitError) return 'quota';
  if (/unauthori[sz]ed|authentication|invalid api key|not installed|not found.*(?:CLI|command)/i.test(message)) return 'configuration';
  if (transportError !== undefined && isInfraError(transportError)) return 'infra';
  // Do not invent an objective verification conflict merely because the issues field is empty.
  return 'quality';
}

export function stageFailure(result: StageResult): string {
  const value = result.result as { error?: string; feedback?: string; issues?: string[]; summary?: string; failures?: string[] };
  return value.error ?? value.feedback ?? value.issues?.join('\n') ?? value.failures?.join('\n') ?? value.summary ?? `${result.stage} failed`;
}

export const failureFingerprint = (cause: RecoveryCause, stage: string, message: string): string =>
  recoveryHash([cause, stage, infraFailureFingerprint(message)]);

export function observedChecks(result: StageResult): string[] {
  const value = result.result as { executedCommands?: string[]; verificationEvidence?: Array<{ command?: unknown; status?: unknown; exitCode?: unknown }> };
  // Exclude self-reported commands. Store only stable evidence identifiers instead of raw command/body.
  return [...(value.executedCommands ?? []).map((c) => recoveryHash(c)),
    ...(value.verificationEvidence ?? []).map((e) => recoveryHash([e.command, e.status, e.exitCode]))].sort();
}
