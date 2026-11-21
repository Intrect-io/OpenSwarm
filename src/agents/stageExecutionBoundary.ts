/** The native execution boundary takes precedence over the model's success claim and holds at every required stage. */
export interface ExecutionBoundarySignals {
  executionOutcomeUnknown?: boolean;
  blockedOnOperator?: boolean;
  operatorQuestionCorrelationIds?: string[];
}

export interface StageBoundaryResults {
  workerResult?: ExecutionBoundarySignals & { haltReason?: string };
  testerResult?: ExecutionBoundarySignals;
  reviewResult?: ExecutionBoundarySignals;
}

export function pipelineExecutionBoundary(result: StageBoundaryResults): (ExecutionBoundarySignals & { stage: string; reason: string }) | undefined {
  const stages = [
    { stage: 'worker', value: result.workerResult },
    { stage: 'tester', value: result.testerResult },
    { stage: 'reviewer', value: result.reviewResult },
  ];
  const found = stages.find(({ value }) => value?.executionOutcomeUnknown)
    ?? stages.find(({ value }) => value?.blockedOnOperator);
  if (!found?.value) return undefined;
  const reason = found.stage === 'worker' && result.workerResult?.haltReason
    ? result.workerResult.haltReason
    : found.value.executionOutcomeUnknown
      ? `OUTCOME_UNKNOWN_DO_NOT_RETRY: ${found.stage} sandbox command outcome requires operator inspection before resuming`
      : `${found.stage} is blocked on an operator decision`;
  return { stage: found.stage, reason, executionOutcomeUnknown: found.value.executionOutcomeUnknown,
    blockedOnOperator: found.value.blockedOnOperator, operatorQuestionCorrelationIds: found.value.operatorQuestionCorrelationIds };
}
