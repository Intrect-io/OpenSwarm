// ============================================
// OpenSwarm - Adaptive worker fan-out gate
// ============================================

import { taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineGuardsConfig, RoleConfig, WorkerFanoutCandidateConfig } from '../core/types.js';
import { broadcastEvent } from '../core/eventHub.js';
import type { WorkerResult } from './agentPair.js';
import type { WorkerOptions } from './worker.js';
import { runWorkerFanout } from './workerFanout.js';
import { safeConsole as console } from '../support/safeLog.js';

export interface WorkerFanoutGateSignal {
  code: string;
  weight: number;
  reason: string;
}

export interface WorkerFanoutGateDecision {
  enabled: boolean;
  shouldFanOut: boolean;
  score: number;
  threshold: number;
  signals: WorkerFanoutGateSignal[];
}

export interface FanoutDraftAnalysis {
  relevantFiles: string[];
  sufficient?: boolean;
}

const DEFAULT_FANOUT_GATE_MIN_SCORE = 2;
const CORE_ORCHESTRATION_PATTERN =
  /\b(pairpipeline|pipeline|autonomousrunner|runnerexecution|worktree|scheduler|adapter|agenticloop|worker|reviewer|tester|auth|mcp|codexresponses|eventhub)\b/i;

function textMatchesCoreOrchestration(text: string): boolean {
  return CORE_ORCHESTRATION_PATTERN.test(text.replace(/[^A-Za-z0-9_/.-]+/g, ' '));
}

export function evaluateWorkerFanoutGate(input: {
  task: TaskItem;
  draftAnalysis?: FanoutDraftAnalysis;
  iteration: number;
  feedbackSource?: 'objective' | 'review';
  effort?: 'low' | 'medium' | 'high';
  config?: RoleConfig['fanout'];
}): WorkerFanoutGateDecision {
  const enabled = input.config?.enabled ?? true;
  const threshold = input.config?.minScore ?? DEFAULT_FANOUT_GATE_MIN_SCORE;
  if (!enabled) {
    return { enabled: false, shouldFanOut: false, score: 0, threshold, signals: [] };
  }

  const signals: WorkerFanoutGateSignal[] = [];
  const add = (code: string, weight: number, reason: string) => {
    signals.push({ code, weight, reason });
  };

  if (input.iteration > 1 && input.feedbackSource === 'objective') {
    add('objective-retry', 2, 'objective guard/test feedback from a previous iteration');
  }
  if (input.iteration > 1 && input.feedbackSource === 'review') {
    add('review-retry', 2, 'reviewer or confidence feedback requested a revision');
  }
  if (input.draftAnalysis?.sufficient === false) {
    add('insufficient-draft', 1, 'draft analysis was insufficient');
  }

  const relevantFiles = input.draftAnalysis?.relevantFiles ?? input.task.fileScope ?? [];
  if (relevantFiles.length >= 4) {
    add('broad-file-scope', 1, `broad file scope (${relevantFiles.length} files)`);
  }

  const scopeText = [
    input.task.title,
    input.task.description ?? '',
    relevantFiles.join(' '),
  ].join(' ');
  if (textMatchesCoreOrchestration(scopeText)) {
    add('core-orchestration-scope', 1, 'core orchestration or agent pipeline surface');
  }

  if ((input.task.estimatedMinutes ?? 0) >= 30) {
    add('large-estimate', 1, `estimated ${input.task.estimatedMinutes} minutes`);
  }
  if (input.task.priority === 1 && (input.task.estimatedMinutes ?? 0) >= 15) {
    add('urgent-nontrivial', 1, 'urgent non-trivial task');
  }
  if (input.effort === 'high') {
    add('high-effort-profile', 1, 'matched high-effort job profile');
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  return {
    enabled,
    shouldFanOut: score >= threshold,
    score,
    threshold,
    signals,
  };
}

function buildWorkerFanoutCandidates(
  base: WorkerOptions,
  configured?: WorkerFanoutCandidateConfig[],
): WorkerFanoutCandidateConfig[] {
  if (configured && configured.length > 0) return configured;

  const primary: WorkerFanoutCandidateConfig = {
    id: 'primary',
    adapter: base.adapterName,
    model: base.model,
    reasoningEffort: base.reasoningEffort,
    maxTurns: base.maxTurns,
    nudgeMaxOnNoEdit: base.nudgeMaxOnNoEdit,
    webTools: base.webTools,
    memoryTools: base.memoryTools,
  };
  const spark: WorkerFanoutCandidateConfig = {
    id: 'spark-diversity',
    adapter: 'codex-responses',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'low',
    maxTurns: Math.min(base.maxTurns ?? 12, 12),
    nudgeMaxOnNoEdit: base.nudgeMaxOnNoEdit,
    webTools: false,
    memoryTools: false,
  };

  const seen = new Set<string>();
  return [primary, spark].filter((candidate) => {
    const key = `${candidate.adapter ?? ''}:${candidate.model ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emitWorkerFanoutGateDecision(input: {
  context: { task: TaskItem; currentIteration: number; taskPrefix: string };
  decision: WorkerFanoutGateDecision;
  verbose?: boolean;
  emit: (event: 'fanout:gate' | 'log', payload: unknown) => void;
}): void {
  const { context, decision } = input;
  const reasons = decision.signals.map((signal) => signal.reason);
  input.emit('fanout:gate', { context, decision });
  broadcastEvent({
    type: 'pipeline:fanout',
    data: {
      taskId: taskEventKey(context.task),
      iteration: context.currentIteration,
      enabled: decision.enabled,
      shouldFanOut: decision.shouldFanOut,
      score: decision.score,
      threshold: decision.threshold,
      reasons,
    },
  });

  if (!decision.enabled) return;
  if (!decision.shouldFanOut && !input.verbose) return;

  const verdict = decision.shouldFanOut ? 'recommend fan-out' : 'single worker';
  const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  const line = `[FanoutGate] ${verdict} (${decision.score}/${decision.threshold})${detail}`;
  console.log(`[${context.taskPrefix}] ${line}`);
  input.emit('log', { line });
  broadcastEvent({ type: 'log', data: { taskId: taskEventKey(context.task), stage: 'worker', line: `[${context.taskPrefix}] ${line}` } });
}

export async function runWorkerWithOptionalFanout(input: {
  projectPath: string;
  workerOptions: WorkerOptions;
  fanoutDecision?: WorkerFanoutGateDecision;
  fanoutConfig?: RoleConfig['fanout'];
  guards?: Partial<PipelineGuardsConfig>;
  onLog: (line: string) => void;
  runWorker: (options: WorkerOptions) => Promise<WorkerResult>;
}): Promise<WorkerResult> {
  const { fanoutDecision, fanoutConfig, workerOptions } = input;
  if (fanoutDecision?.shouldFanOut && fanoutConfig?.mode === 'execute') {
    const candidates = buildWorkerFanoutCandidates(workerOptions, fanoutConfig.candidates);
    // Surface execution to stdout too: onLog only reaches broadcastEvent, so
    // without this the daemon log shows the gate's "recommend fan-out" line but
    // no evidence fan-out actually ran (the exact symptom that hid this path).
    console.log(`[fanout] executing ${candidates.length} candidate(s) — gate score ${fanoutDecision.score}/${fanoutDecision.threshold}`);
    const fanoutResult = await runWorkerFanout({
      projectPath: input.projectPath,
      baseWorkerOptions: workerOptions,
      candidates,
      concurrency: fanoutConfig.concurrency ?? Math.min(candidates.length, 3),
      keepSandboxes: fanoutConfig.keepSandboxes,
      linkSharedPaths: fanoutConfig.linkSharedPaths,
      guards: input.guards,
      onLog: input.onLog,
    });

    if (fanoutResult.winner) {
      console.log(`[fanout] promoted winner ${fanoutResult.winner.id} (${fanoutResult.winner.filesChanged.length} file(s))`);
      return fanoutResult.winner.result;
    }
    console.log(`[fanout] fallback to single worker: ${fanoutResult.fallbackReason ?? 'no winner'}`);
    input.onLog(`[fanout] fallback to single worker: ${fanoutResult.fallbackReason ?? 'no winner'}`);
  }

  return input.runWorker(workerOptions);
}
