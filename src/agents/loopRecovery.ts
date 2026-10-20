import type { AdviceRecord, ExecutionContract, RecoveryHooks, RecoveryStatus } from '../automation/loopRecoveryTypes.js';
import type { PipelineContext, StageResult } from './pairPipelineTypes.js';
import { recoveryHash } from '../automation/runRecoveryStore.js';
import { takeSnapshot } from '../support/gitTracker.js';
import { recoveryModelIdentity, runRecoveryAdvisor } from './recoveryAdvisor.js';
import { executionContract, failureFingerprint, observedChecks, recoveryCause, recoveryText, stageFailure } from './loopRecoveryEvidence.js';
import { broadcastEvent } from '../core/eventHub.js';
import { premiseSources } from './recoveryPremise.js';

export class RecoveryParkError extends Error {}

/** 실제 durable claim이 없는 ad-hoc/legacy 실행에는 권한·실행 원장을 발명하지 않는다. */
export class LoopRecovery {
  private readonly contract: ExecutionContract;
  private readonly contractHash: string;
  private readonly environmentHash: string;
  private readonly restored = new Map<string, StageResult>();
  private readonly models = new Map<string, string>();
  readonly costs: import('../support/costTracker.js').CostInfo[] = [];
  feedback = '';
  parkReason?: string;

  private constructor(private readonly context: PipelineContext, private readonly hooks: RecoveryHooks, private readonly deadline: number) {
    this.contract = executionContract(context);
    this.contractHash = recoveryHash(this.contract);
    this.environmentHash = recoveryHash([process.version, process.platform, process.arch,
      Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
      context.trustedVerifyInputFingerprint, context.trustedVerifyCommands, this.contract.policyHash]);
  }

  static async create(context: PipelineContext, hooks?: RecoveryHooks, startedAt = Date.now()): Promise<LoopRecovery | undefined> {
    if (!hooks) return undefined;
    const recovery = new LoopRecovery(context, hooks,
      context.config.taskBudgetMs ? startedAt + context.config.taskBudgetMs : startedAt + 30 * 60_000);
    hooks.contract(recovery.contract);
    const digest = await takeSnapshot(context.projectPath);
    if (digest) {
      const progress = hooks.status().progress;
      const advice = progress?.failureFingerprint ? hooks.advice(recoveryHash([recovery.contractHash, digest, recovery.environmentHash, progress.failureFingerprint, progress.checks])) : undefined;
      if (context.config.loopAdvisor?.mode === 'active' && hooks.canAdvise() && progress?.artifactDigest === digest
        && advice?.mode === 'active' && advice.applied && advice.decision) {
        const stage = context.config.stages.find((s) => s === progress.stage) ?? 'worker';
        recovery.apply(advice.decision, progress.cause ?? '', stage, context.config.roles?.[stage]?.model);
        if (advice.premiseVerification) recovery.feedback = `Independent premise verification (${advice.premiseVerification.disposition}); original review still blocks. ${advice.premiseVerification.reason}`;
      }
      const previous = hooks.resume(recovery.contractHash, digest, recovery.environmentHash);
      // worker가 보존되지 않았다면 뒤 단계 결과만으로 작업을 완료할 수 없다.
      if (previous.some((c) => c.stage === 'worker')) {
        // 외부 서비스와 설치된 의존성을 완전히 attestation하지 못한다. 필수 검증은 다시 실행한다.
        for (const checkpoint of previous.filter((c) => c.stage === 'worker')) recovery.restored.set(checkpoint.stage, checkpoint.result);
        context.runSnapshotHash = previous.find((c) => c.stage === 'worker')?.runSnapshotHash;
      }
    }
    return recovery;
  }

  status(): RecoveryStatus { return this.hooks.status(); }
  settle(success: boolean): void { this.hooks.settle(success); }

  async restore(stage: StageResult['stage']): Promise<StageResult | undefined> {
    if (!this.hooks.isCurrent() || this.context.abortSignal?.aborted) throw new Error('Recovery lease fence rejected');
    if (this.context.currentIteration !== 1) return undefined;
    const previous = this.restored.get(stage);
    if (!previous) return undefined;
    const digest = await takeSnapshot(this.context.projectPath);
    const available = digest ? this.hooks.resume(this.contractHash, digest, this.environmentHash) : [];
    if (!available.some((c) => c.stage === stage)) { this.restored.clear(); return undefined; }
    const now = Date.now();
    const result = { ...previous.result, costInfo: undefined };
    if (stage === 'worker') this.context.workerResult = result as NonNullable<PipelineContext['workerResult']>;
    if (stage === 'reviewer') this.context.reviewResult = result as NonNullable<PipelineContext['reviewResult']>;
    if (stage === 'tester') this.context.testerResult = result as NonNullable<PipelineContext['testerResult']>;
    const restored = { ...previous, result, reused: true, startedAt: now, completedAt: now, duration: 0 };
    broadcastEvent({ type: 'pipeline:recovery', data: { taskId: this.contract.issueId, stage, reused: true } });
    return restored;
  }

  start(stage: string): void {
    if (!this.hooks.isCurrent() || this.context.abortSignal?.aborted) throw new Error('Recovery lease fence rejected');
    // 실행 도중 crash는 결과가 불명확하다. 알려진 인프라 실패가 기록된 뒤에만 재사용을 허용한다.
    if (stage === 'worker') this.hooks.settle(false);
    else this.hooks.resumable(undefined);
  }

  model(stage: string): string | undefined { return this.models.get(stage); }

  async failure(stage: string, errors: string[]): Promise<void> {
    const now = Date.now();
    await this.complete({ stage: 'worker', success: false, result: { success: false, error: errors.join('\n') },
      duration: 0, startedAt: now, completedAt: now }, this.context.config.roles?.worker?.model, undefined, stage);
    if (this.parkReason) throw new RecoveryParkError(this.parkReason);
  }

  async complete(result: StageResult, failedModel?: string, transportError?: unknown, label = result.stage as string): Promise<void> {
    const digest = await takeSnapshot(this.context.projectPath);
    const boundary = result.result as { executionOutcomeUnknown?: boolean; blockedOnOperator?: boolean; terminationCause?: string };
    const successful = result.success && !boundary.executionOutcomeUnknown && !boundary.blockedOnOperator;
    const nativeStall = boundary.terminationCause === 'no_progress';
    const error = nativeStall ? 'Native execution stopped after repeated unchanged tool results' : successful ? '' : stageFailure(result);
    // Native 종료 신호는 진단 자료다. 실제 단계 성공을 복구 실패로 재분류하지 않는다.
    const cause = successful ? undefined : recoveryCause(error, result.result, transportError);
    const fingerprint = cause ? failureFingerprint(cause, label, error) : undefined;
    const value = result.result as { terminationCause?: string; costInfo?: { model?: string; servedModels?: string[] } };
    const progress = this.hooks.observe({ stage: label, artifactDigest: digest || undefined,
      checks: observedChecks(result), cause, failureFingerprint: fingerprint, observedAt: Date.now(),
      terminationCause: nativeStall ? 'no_progress' : undefined,
      environmentDigest: this.environmentHash,
      observability: value.terminationCause ? 'native' : 'stage' });
    if (successful && digest && ['worker', 'reviewer', 'tester'].includes(result.stage)) {
      this.hooks.checkpoint({ stage: result.stage, result, artifactDigest: digest, environmentHash: this.environmentHash,
        contractHash: this.contractHash, runSnapshotHash: this.context.runSnapshotHash });
    }
    if (!successful) this.hooks.resumable(transportError !== undefined && ['infra', 'quota'].includes(cause!)
      && ['reviewer', 'tester'].includes(result.stage) ? result.stage : undefined);
    broadcastEvent({ type: 'pipeline:recovery', data: { taskId: this.contract.issueId, progress } });
    if (!cause || ['operator_wait', 'outcome_unknown', 'cancelled'].includes(cause)) return;
    const cfg = this.context.config.loopAdvisor;
    if (!['worker', 'reviewer', 'tester'].includes(result.stage)) return;
    if (!cfg || cfg.mode === 'off' || this.context.abortSignal?.aborted || !digest || !this.hooks.canAdvise()) return;
    if (progress.consecutiveNoProgress < (cfg.triggerAfter ?? 2) && !['no_progress', 'review_conflict'].includes(cause)) return;
    const remainingMs = this.deadline - Date.now();
    if (remainingMs <= 0) return;
    const key = recoveryHash([this.contractHash, digest, this.environmentHash, fingerprint, progress.checks]);
    const record = this.hooks.reserveAdvice(key, cfg.mode, cfg.maxCallsPerIssue24h ?? 2);
    if (!record) {
      const previous = this.hooks.advice(key);
      if (cfg.mode === 'active' && previous?.mode === 'active' && previous.evidenceKey === key && previous.applied && previous.decision) {
        this.apply(previous.decision, cause, result.stage, failedModel);
      }
      return;
    }
    const role = this.context.config.roles?.[result.stage];
    const allowedModels = [role?.escalateModel].filter((m): m is string => !!m);
    const outcome = await runRecoveryAdvisor({ cwd: this.context.projectPath,
      adapter: cfg.adapter ?? this.context.config.advisorRole?.adapter,
      model: cfg.model ?? this.context.config.advisorRole?.model,
      failedModel: value.costInfo?.model ?? failedModel,
      failedModels: value.costInfo?.servedModels,
      stage: result.stage, cause, evidence: { failure: error, artifact: digest,
        observations: JSON.stringify(progress), acceptance: JSON.stringify(this.contract.acceptance) },
      allowedModels, remainingMs, timeoutMs: cfg.timeoutMs, signal: this.context.abortSignal });
    if (outcome.costInfo) this.costs.push(outcome.costInfo);
    // 늦은 모델 응답은 lease를 재확인하기 전까지 적용하지 않는다.
    if (!this.hooks.canAdvise() || this.context.abortSignal?.aborted) return;
    const update: Pick<AdviceRecord, 'status' | 'decision' | 'reason' | 'applied' | 'costInfo' | 'premiseVerification'> = {
      status: outcome.decision ? 'completed' : 'unavailable', decision: outcome.decision,
      reason: outcome.reason, applied: false, costInfo: outcome.costInfo,
    };
    if (cfg.mode === 'active' && outcome.decision) {
      const advice = outcome.decision;
      if (advice.action === 'verify_claim' && result.stage === 'reviewer' && ['review_conflict', 'quality'].includes(cause)) {
        update.premiseVerification = await this.verifyPremise(key, digest, error, failedModel, value.costInfo?.servedModels, outcome.costInfo?.servedModels);
        update.reason = update.premiseVerification ? 'Original review remains blocking; independent premise result is evidence for the next required review'
          : 'Independent configured premise verifier unavailable; original review remains blocking';
        update.applied = !!update.premiseVerification;
      } else {
        update.applied = this.apply(advice, cause, result.stage, failedModel);
        if (!update.applied) update.reason = 'Advisor action rejected by deterministic recovery policy';
      }
    }
    if (!this.hooks.finishAdvice(record.id, update)) throw new Error('Recovery lease fence rejected');
    broadcastEvent({ type: 'pipeline:recovery', data: { taskId: this.contract.issueId, ...this.status() } });
  }

  private apply(advice: NonNullable<AdviceRecord['decision']>, cause: string, stage: StageResult['stage'], failedModel?: string): boolean {
    if (advice.action === 'revise_strategy' && ['quality', 'no_progress'].includes(cause)) {
      this.feedback = `Automated recovery advice (not operator approval): ${advice.diagnosis}\nCondition: ${advice.condition}\nRequired verification: ${advice.verification}`;
    } else if (advice.action === 'switch_model' && advice.model && this.context.config.roles?.[stage]?.escalateModel === advice.model && advice.model !== failedModel) {
      this.models.set(stage, advice.model);
      if (stage === 'worker') this.context.workerEscalation = { model: advice.model };
    } else if (advice.action === 'ask_operator' || advice.action === 'stop') {
      this.parkReason = recoveryText(`${advice.diagnosis}\n${advice.condition}`);
    } else if (!(['wait', 'retry_stage'].includes(advice.action) && ['infra', 'quota'].includes(cause))) return false;
    // 대기와 재시도는 기존 coordinator의 backoff/예산을 사용한다.
    return true;
  }

  private async verifyPremise(key: string, digest: string, claim: string, failedModel?: string, failedModels?: string[], advisorModels?: string[]): Promise<AdviceRecord['premiseVerification']> {
    const cfg = this.context.config.loopAdvisor!;
    // 첫 Advisor의 권고를 같은 모델로 재확인하지 않는다. 설정된 tier가 없으면 원래 검토를 유지한다.
    if (!advisorModels?.length) return undefined;
    const excluded = [failedModel, ...(failedModels ?? []), ...advisorModels].filter((m): m is string => !!m);
    const candidates = [this.context.config.roles?.reviewer, this.context.config.advisorRole];
    const tier = candidates.find((role) => role?.escalateModel && !excluded.map(recoveryModelIdentity).includes(recoveryModelIdentity(role.escalateModel)));
    if (!tier?.escalateModel) return undefined;
    const sources = await premiseSources(this.context.projectPath, this.context.workerResult?.filesChanged ?? []);
    if (!Object.keys(sources).some((k) => k.startsWith('source:'))) return undefined;
    const reservation = this.hooks.reserveAdvice(`${key}:premise`, 'active', cfg.maxCallsPerIssue24h ?? 2);
    if (!reservation) return undefined;
    const outcome = await runRecoveryAdvisor({ cwd: this.context.projectPath, stage: 'reviewer', cause: 'review_conflict',
      adapter: tier.adapter ?? cfg.adapter ?? this.context.config.advisorRole?.adapter, model: tier.escalateModel,
      failedModel, failedModels: excluded, allowedModels: [], remainingMs: this.deadline - Date.now(), timeoutMs: cfg.timeoutMs,
      signal: this.context.abortSignal, purpose: 'premise_verification', evidence: { claim, artifact: digest, ...sources } });
    if (outcome.costInfo) this.costs.push(outcome.costInfo);
    if (!this.hooks.isCurrent() || this.context.abortSignal?.aborted) return undefined;
    const advice = outcome.decision;
    const valid = advice?.action === 'verify_claim' && advice.premiseDisposition
      && advice.evidence.some((k) => k.startsWith('source:')) && digest === await takeSnapshot(this.context.projectPath);
    const disposition = Object.keys(sources).some((k) => k.startsWith('truncated:') || k.startsWith('unavailable:')) ? 'unknown' : advice?.premiseDisposition;
    const verification = valid ? { disposition: disposition!, evidence: advice.evidence, reason: advice.diagnosis } : undefined;
    if (!this.hooks.finishAdvice(reservation.id, { status: verification ? 'completed' : 'unavailable',
      decision: verification ? { ...advice!, premiseDisposition: verification.disposition } : undefined,
      applied: false, costInfo: outcome.costInfo, premiseVerification: verification,
      reason: outcome.reason ?? 'Premise observation only; original review is preserved' })) throw new Error('Recovery lease fence rejected');
    if (verification) this.feedback = `Independent premise verification (${verification.disposition}); original review still blocks. ${verification.reason}\nEvidence: ${verification.evidence.join(', ')}`;
    return verification;
  }
}
