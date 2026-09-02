// ============================================
// OpenSwarm - Worker Agent
// Task execution agent (CLI adapter based)
// ============================================

import type { WorkerResult } from './agentPair.js';
import * as gitTracker from '../support/gitTracker.js';
import { t, getPrompts } from '../locale/index.js';
import type { WorkerContext } from '../locale/types.js';
import type { AdapterName, ProcessContext } from '../adapters/types.js';
import type { ToolDefinition } from '../adapters/tools.js';
import { getAdapter, getDefaultAdapterName, probeAdapterAvailability, spawnCli } from '../adapters/index.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import { resolveEditFormat, SEARCH_REPLACE_PROMPT, WHOLE_FILE_PROMPT, type EditFormat } from '../support/editParser.js';
import { loadSandboxBashTimeoutMs } from '../support/repoMetadata.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeConsole as console } from '../support/safeLog.js';
import type { InstructionCapsule } from './instructionCapsule.js';
import { COORDINATION_GUIDANCE_PROMPT, type CoordinationToolContext } from '../coordination/coordinationTools.js';
import {
  isRouteReasonAllowed,
  planAdapterAttempts,
  type AdapterAttemptPlan,
  type AdapterRoutePolicy,
} from '../coordination/routingPolicy.js';
import { getCoordinationStore } from '../coordination/coordinationStore.js';
import { filesOutsideWriteScope } from '../orchestration/writeScope.js';

// Types

export interface WorkerOptions {
  taskTitle: string;
  taskDescription: string;
  authoritativeOperatorFeedback?: string;
  projectPath: string;
  previousFeedback?: string;   // Previous feedback from Reviewer (for revisions)
  timeoutMs?: number;
  model?: string;              // Model ID (default: adapter default)
  maxTurns?: number;           // Max agentic turns per CLI invocation
  adapterName?: AdapterName;
  /** Reasoning effort from a jobProfile (codex-responses: low|medium|high). When set, reasoning is enabled at this effort. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  issueIdentifier?: string;    // Linear issue ID (e.g., INT-123)
  projectName?: string;        // Linear project name
  onLog?: (line: string) => void;  // Callback for stdout streaming
  /** Route worker status through onLog without printing raw console lines. */
  suppressStatusLogs?: boolean;
  processContext?: ProcessContext;
  /** 코드 컨텍스트 (impact analysis + registry briefs) */
  workerContext?: WorkerContext;
  /** no-edit 종료 가드 횟수 — 수정 필수 작업에서 모델이 edit 없이 끝내면 N회 되밂 */
  nudgeMaxOnNoEdit?: number;
  /** Verification-harness file protection — listed files reject edit/write */
  protectedFiles?: string[];
  /** Planner-declared files/modules this task may edit. */
  fileScope?: string[];
  /** Task-owned files restored from preserveWorktree WIP commits. */
  resumedTaskFiles?: string[];
  /** bash tool timeout in ms — raise for slow verification such as docker-based tests */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Set false for SWE-bench integrity. */
  webTools?: boolean;
  /** Expose repository memory search (default true). Set false for isolated/temp repo benchmarks. */
  memoryTools?: boolean;
  /** MCP tools to expose to the agentic loop (server__tool). When unset the adapter
   * self-sources from the registry (INT-1951); set to pin a specific set. (INT-1950) */
  mcpTools?: ToolDefinition[];
  /** Abort the run + in-flight adapter call (pipeline cancel / project disable). */
  signal?: AbortSignal;
  /**
   * File-edit format (INT-1676). When unset it is resolved per adapter from model
   * capability (resolveEditFormat) — weaker in-process adapters get SEARCH/REPLACE.
   * Set explicitly to pin a format (e.g. roll back a regressing model to 'json').
   */
  editFormat?: EditFormat;
  /** Run-scoped Claude Code instruction and runbook snapshot. */
  instructionCapsule?: InstructionCapsule;
  /** Identity and mailbox scope for inter-worker coordination. */
  coordinationContext?: CoordinationToolContext;
  /** Typed fallback policy; semantic task failures never trigger it. */
  adapterRouting?: AdapterRoutePolicy;
}

// Bash timeout policy (INT-2415)

/**
 * Default worker bash timeout (5min). The tools.ts DEFAULT_BASH_TIMEOUT_MS (30s)
 * is the floor for non-worker callers, but the autonomous worker runs real
 * verification (pytest / playwright / backtests / retraining) that needs minutes,
 * not seconds — a 30s cap made every such command time out, so reviewers demanded
 * "live/E2E verification" the worker could never physically complete.
 */
export const WORKER_BASH_TIMEOUT_DEFAULT_MS = 300_000;

const REPO_RULE_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const REPO_RULES_MAX_CHARS = 12_000;

/** Load binding repository instructions into the autonomous worker prompt. */
export function loadWorkerRepoRules(projectPath: string): string {
  const sections: string[] = [];
  const root = existsSync(projectPath) ? realpathSync(projectPath) : resolve(projectPath);
  for (const name of REPO_RULE_FILES) {
    const path = join(projectPath, name);
    if (!existsSync(path)) continue;
    try {
      const resolved = realpathSync(path);
      const relativePath = relative(root, resolved);
      if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
        continue;
      }
      const full = readFileSync(path, 'utf8').trim();
      if (!full) continue;
      const body = full.length > REPO_RULES_MAX_CHARS
        ? `${full.slice(0, REPO_RULES_MAX_CHARS)}\n… (truncated — read ${name} before editing)`
        : full;
      sections.push(`## Binding repository instructions (${name})\n${body}`);
    } catch {
      // Best-effort: the base prompt still tells the worker to read repo rules.
    }
  }
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

export function reconcileWorkerFiles(
  gitChangedFiles: string[],
  fileScope: string[] = [],
): { filesChanged: string[]; outsideScope: string[] } {
  const filesChanged = [...gitChangedFiles];
  return { filesChanged, outsideScope: filesOutsideWriteScope(filesChanged, fileScope) };
}

/** jobProfile effort → bash timeout. Heavier tasks get longer verification budgets. */
const EFFORT_BASH_TIMEOUT_MS: Record<'low' | 'medium' | 'high', number> = {
  low: 120_000, // 2min
  medium: 300_000, // 5min
  high: 900_000, // 15min
};

/**
 * Resolve the worker's bash tool timeout (ms). Pure + total.
 *
 * Precedence (INT-2415):
 *   1. matched jobProfile `effort` (low/medium/high) — task-shaped budget
 *   2. repo override — openswarm.json `sandbox.bashTimeoutMs`
 *   3. a 5min default (WORKER_BASH_TIMEOUT_DEFAULT_MS)
 *
 * A non-positive/NaN repo override is ignored (falls through to the default).
 */
export function resolveWorkerBashTimeoutMs(input: {
  effort?: 'low' | 'medium' | 'high';
  repoOverrideMs?: number;
}): number {
  if (input.effort) return EFFORT_BASH_TIMEOUT_MS[input.effort];
  if (typeof input.repoOverrideMs === 'number' && input.repoOverrideMs > 0) {
    return input.repoOverrideMs;
  }
  return WORKER_BASH_TIMEOUT_DEFAULT_MS;
}

/**
 * Async convenience over resolveWorkerBashTimeoutMs: reads the repo override
 * (openswarm.json `sandbox.bashTimeoutMs`) from `projectPath` itself, so callers
 * pass only the matched jobProfile effort. Best-effort I/O. (INT-2415)
 */
export async function resolveWorkerBashTimeout(
  projectPath: string,
  effort?: 'low' | 'medium' | 'high',
): Promise<number> {
  return resolveWorkerBashTimeoutMs({ effort, repoOverrideMs: await loadSandboxBashTimeoutMs(projectPath) });
}

// Prompts

/**
 * Build Worker prompt using locale templates
 */
function buildWorkerPrompt(options: WorkerOptions): string {
  return getPrompts().buildWorkerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    authoritativeOperatorFeedback: options.authoritativeOperatorFeedback,
    previousFeedback: options.previousFeedback,
    context: options.workerContext,
  });
}

/**
 * Probe what this machine can actually run, then let the shared policy order it.
 *
 * The primary is probed only when capability routing could act on the answer:
 * an availability check spawns the provider CLI, and paying for one whose
 * result nothing can use would slow every task for nothing.
 */
async function planWorkerAdapters(primary: AdapterName, policy?: AdapterRoutePolicy): Promise<AdapterAttemptPlan> {
  if (!policy) return { attempts: [primary] };
  // A policy written for a different adapter is not a policy for this run. Say
  // so: the config looks configured, the fallbacks are listed, and nothing
  // routes — which reads as "routing is broken" rather than "routing is off".
  if (policy.primary !== primary) {
    console.warn(
      `[Worker] adapterRouting.primary is '${policy.primary}' but this run uses '${primary}' — `
      + `fallbacks ${JSON.stringify(policy.fallbacks ?? [])} are inactive. Align the two to enable routing.`,
    );
    return { attempts: [primary] };
  }
  const available: Partial<Record<AdapterName, boolean>> = {};
  const candidates = new Set<AdapterName>(policy.fallbacks ?? []);
  candidates.delete(primary);
  if (isRouteReasonAllowed(policy, 'capability')) candidates.add(primary);
  for (const candidate of candidates) available[candidate] = await probeAdapterAvailability(getAdapter(candidate));
  return planAdapterAttempts({ policy, primary, available });
}

export function isProviderQuotaError(message?: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();

  const hasQuotaSignal = /\bquota\b/.test(text);
  const hasRateLimit = /\brate[-\s]?limit\b/.test(text);
  const hasTooManyRequests = /\btoo many requests\b/.test(text);
  const hasInsufficientQuota = /\binsufficient[_-]?quota\b/.test(text);
  const hasUsageLimit = /\busage\b.*\blimit\b/.test(text) || /\blimit\b.*\busage\b/.test(text);
  const hasExceededPair = /\bexceeded\b/.test(text) && /\b(quota|limit|usage)\b/.test(text);
  const has429 = /\b429\b/.test(text) && (/\brequest\b/.test(text) || /rate/.test(text));
  // "billing" alone is NOT a quota signal — a task whose title/summary mentions
  // billing/invoices/payments (e.g. a payment-feature issue) would otherwise be
  // misread as a quota failure and trigger a spurious adapter fallback. Only treat
  // billing as a quota signal when paired with an actual quota/limit word. (INT-1927)
  const hasBilling = /\bbilling\b/.test(text) && /\b(quota|limit|exceeded|insufficient|suspended)\b/.test(text);

  return (
    hasQuotaSignal ||
    hasRateLimit ||
    hasTooManyRequests ||
    hasInsufficientQuota ||
    hasUsageLimit ||
    hasExceededPair ||
    has429 ||
    hasBilling
  );
}

function isWorkerQuotaFailure(result: WorkerResult): boolean {
  return (
    isProviderQuotaError(result.error) ||
    isProviderQuotaError(result.summary) ||
    isProviderQuotaError(result.haltReason)
  );
}

function emitWorkerStatus(options: WorkerOptions, line: string): void {
  options.onLog?.(line);
  if (!options.suppressStatusLogs) console.log(line);
}

export function formatWorkerGitChangeStatus(files: string[]): string {
  if (files.length === 0) return '[Worker] No file changes detected by Git';
  const shown = files.slice(0, 4).join(', ');
  const more = files.length > 4 ? ` +${files.length - 4} more` : '';
  return `[Worker] Git detected ${files.length} changed file(s): ${shown}${more}`;
}

/** Test-run quarantine is not a worker-owned source edit. */
export function isEphemeralWorkerArtifact(file: string): boolean {
  return file === '.venv'
    || file === '.venv-verify'
    || file === '.venv.bak'
    || file === 'pytest-local'
    || file.startsWith('.venv/')
    || file.startsWith('.venv-verify/')
    || file.startsWith('.venv.bak/')
    || file.startsWith('pytest-local/')
    || /(?:^|\/)pytest-of-[^/]+\//.test(file)
    || /^pytest-of-[^/]+$/.test(file)
    || /^\.openswarm-trash\/[^/]*-(?:pytest|verify)(?:-|\/|$)/.test(file)
    || file === '.vega/google_heartbeat_sync.lock'
    || /^\.openswarm\/(?:repo-snapshot\.json|repo\.graphql)$/.test(file)
    || /^\.test-tmp(?:-[^/]+)?(?:\/|$)/.test(file)
    || /^\.trash(?:\/|$)/.test(file)
    || /^\.pytest-lathe(?:\/|$)/.test(file)
    // pytest fixtures in VEGA-style repositories use tempfile prefixes such
    // as int3301_<random> and tmp<random>; they are harness scratch, never a
    // task-owned source directory.
    || /^int\d+_[a-z0-9_]{8,}(?:\/|$)/i.test(file)
    || /^tmp[a-z0-9]{8,}(?:\/|$)/i.test(file);
}

// Worker Execution

/**
 * Run Worker agent
 * Integrates Git-based file change tracking (Aider style)
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const prompt = buildWorkerPrompt(options);
  const cwd = expandPath(options.projectPath);
  const primaryAdapterName = options.adapterName ?? getDefaultAdapterName();
  const routingPlan = await planWorkerAdapters(primaryAdapterName, options.adapterRouting);
  const adaptersToTry = [...routingPlan.attempts];

  const routeAllowed = (reason: 'quota' | 'infra' | 'capability'): boolean =>
    isRouteReasonAllowed(options.adapterRouting, reason);
  // Recording the route is observability. It runs inside the adapter loop's try
  // block, so letting a board write throw here would surface as an adapter
  // failure and route the worker again for a reason that has nothing to do with
  // the provider.
  const recordRoute = async (from: AdapterName, to: AdapterName, reason: string): Promise<void> => {
    if (!options.coordinationContext) return;
    try {
      await getCoordinationStore().publish({
        repository: options.coordinationContext.repository,
        taskId: options.coordinationContext.taskId,
        actor: 'adapter-router',
        actorRole: 'daemon',
        recipient: options.coordinationContext.actor,
        recipientName: options.coordinationContext.actorName,
        recipientRole: options.coordinationContext.actorRole,
        kind: 'adapter-route',
        status: 'completed',
        summary: `${from} → ${to}: ${reason}`,
        metadata: { from, to, reason },
      });
    } catch (error) {
      console.warn('[Worker] adapter-route not recorded:', error instanceof Error ? error.message : error);
    }
  };

  // A primary the machine cannot run — cursor-agent not installed, cc-router
  // not serving — is neither a quota nor an infra failure: the tool is simply
  // absent, and every attempt on it would fail the same way.
  if (routingPlan.skipped) {
    const line = `[Worker] capability on ${routingPlan.skipped.adapter} (adapter unavailable), routing to ${adaptersToTry[0]}`;
    await recordRoute(routingPlan.skipped.adapter, adaptersToTry[0], routingPlan.skipped.reason);
    console.log(line);
    options.onLog?.(line);
  }

  // Git snapshot (pre-work state)
  let snapshotHash = '';
  const isGitRepo = await gitTracker.isGitRepo(cwd);
  if (isGitRepo) {
    snapshotHash = await gitTracker.takeSnapshot(cwd);
    emitWorkerStatus(options, `[Worker] Git snapshot: ${snapshotHash.slice(0, 8)}`);
  }

  const runAttempt = async (
    adapterName: AdapterName,
    isFallbackAttempt: boolean
  ): Promise<WorkerResult> => {
    const adapter = getAdapter(adapterName);
    // Keep user model on primary attempt; when switching adapters, let provider
    // default resolve the model to avoid provider/model mismatch.
    const model = isFallbackAttempt ? undefined : options.model;

    // Edit format matched to THIS adapter's capability (INT-1676): a primary
    // openrouter/local attempt edits via SEARCH/REPLACE, while a claude/codex
    // fallback uses JSON tools — the format follows the adapter. The matching S/R
    // or whole-file instruction is appended to the worker's system prompt so the
    // model emits the format the agentic loop expects.
    const editFormat = options.editFormat ?? resolveEditFormat(adapterName);
    const callSignHeader = options.coordinationContext?.actorName
      ? `\n\n## Your identity\nYou are **${options.coordinationContext.actorName}**. Other agents address you by that call sign, and you address them by theirs.\n`
      : '';
    // Gated on coordinationContext itself (not actorName): that's the same
    // condition agenticLoop.ts uses to decide whether coordination tools are
    // even exposed to this run (AGT-4054).
    const coordinationGuidance = options.coordinationContext
      ? COORDINATION_GUIDANCE_PROMPT + getPrompts().coordinationConsultationPrompt
      : '';
    let systemPrompt = getPrompts().systemPrompt + callSignHeader + coordinationGuidance
      + (options.instructionCapsule?.text ?? loadWorkerRepoRules(cwd));
    if (editFormat === 'search-replace') systemPrompt += SEARCH_REPLACE_PROMPT;
    else if (editFormat === 'whole-file') systemPrompt += WHOLE_FILE_PROMPT;

    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs,
      model,
      maxTurns: options.maxTurns,
      onLog: options.onLog,
      processContext: options.processContext,
      systemPrompt,
      editFormat,
      // Worker is a mechanical execution role — file edits, not deep reasoning.
      // Disable reasoning tokens to cut cost/latency (no-op on non-thinking models).
      // BUT when a jobProfile sets an effort (e.g. heavy tasks), reason at that effort.
      disableReasoning: !options.reasoningEffort,
      reasoningEffort: options.reasoningEffort,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      mcpTools: options.mcpTools,
      signal: options.signal,
      coordinationContext: options.coordinationContext,
    });

    // Parse result via adapter
    const parsedResult = adapter.parseWorkerOutput(raw);

    // A blocking ask_human is neither success nor failure: the operator owns
    // the next step. Mark it before the git-diff heuristics below — a run that
    // edited two files and then hit the question must still stop and wait, not
    // be promoted to success or retried into the same unanswered question.
    if (raw.blockedOnOperator) {
      parsedResult.success = false;
      parsedResult.blockedOnOperator = true;
      parsedResult.operatorQuestionCorrelationIds = raw.operatorQuestionCorrelationIds;
      parsedResult.haltReason = parsedResult.haltReason
        ?? 'Blocked on an operator decision (ask_human posted to Discord)';
    }
    if (raw.executionOutcomeUnknown) {
      parsedResult.success = false;
      parsedResult.executionOutcomeUnknown = true;
      parsedResult.haltReason = 'OUTCOME_UNKNOWN_DO_NOT_RETRY: inspect the quarantined worktree before resuming';
    }

    // Backfill usage measured by the adapter's own loop (codex-responses/gpt/
    // openrouter/local) so per-stage cost logs work on every provider; adapters
    // that extract their own costInfo (claude) keep theirs. (INT-2508)
    if (raw.costInfo && !parsedResult.costInfo) {
      parsedResult.costInfo = raw.costInfo;
    }

    // Git diff is the source of truth for "did real work happen" — independent of
    // whether the model emitted a well-formed JSON success block. LLMs are weak at
    // structured output, so we never let a missing/malformed JSON block alone mark
    // a task as failed when the working tree actually changed (VEGA-style: real
    // signal over self-report).
    if (isGitRepo && snapshotHash) {
      const freshChangedFiles = (await gitTracker.getChangedFilesSinceSnapshot(cwd, snapshotHash))
        .filter((file) => file !== '.openswarm-preserved' && !isEphemeralWorkerArtifact(file));
      // Preserved worktree state predates this invocation and may include
      // test-run byproducts from an older worker. Apply the same quarantine to
      // both sources before presenting the authoritative change set to guards,
      // tester, or publication. Otherwise a resumed task can repeatedly claim
      // `.venv`/pytest scratch files as source edits even though fresh diffs
      // correctly filter them.
      const resumedTaskFiles = (options.resumedTaskFiles ?? [])
        .filter((file) => file !== '.openswarm-preserved' && !isEphemeralWorkerArtifact(file));
      const gitChangedFiles = [...new Set([...resumedTaskFiles, ...freshChangedFiles])];

      // Scope is an execution-time write boundary. Enforce it against edits made
      // by THIS invocation. Task-owned WIP was already preserved after a prior
      // invocation; rejecting the same committed files on every retry creates a
      // permanent loop that can never reach reviewer. Keep those files in the
      // authoritative result, but let reviewer judge the resumed branch.
      const { outsideScope } = reconcileWorkerFiles(freshChangedFiles, options.fileScope);
      const filesChanged = gitChangedFiles;
      parsedResult.filesChanged = filesChanged;

      if (gitChangedFiles.length > 0) {
        emitWorkerStatus(options, formatWorkerGitChangeStatus(gitChangedFiles));

        // Git is authoritative. Model-reported paths may be hallucinated or may
        // name another task's sibling worktree (INT-2609); never merge them back.
        if (outsideScope.length > 0) {
          parsedResult.success = false;
          parsedResult.error = `worker-scope: changed files outside declared fileScope: ${outsideScope.join(', ')}`;
        }

        // Real file changes + no explicit error signal → treat as success even if
        // the model never produced a JSON block. Only an explicit error/halt in the
        // output should keep success=false here.
        if (!parsedResult.success && !parsedResult.error && !parsedResult.haltReason) {
          emitWorkerStatus(options, '[Worker] Promoting to success: git changes present, no error signal');
          parsedResult.success = true;
          if (!parsedResult.summary || parsedResult.summary === t('common.fallback.noSummary')) {
            parsedResult.summary = `Modified ${gitChangedFiles.length} file(s): ${gitChangedFiles.slice(0, 5).join(', ')}`;
          }
        }
      } else if (parsedResult.filesChanged.length === 0) {
        emitWorkerStatus(options, formatWorkerGitChangeStatus([]));
      }

      if (parsedResult.success && parsedResult.filesChanged.length === 0) {
        const noChangesReason = parsedResult.noChangesReason?.trim();
        if (noChangesReason) {
          // Say it in the log: publication will refuse the empty branch and
          // the run parks on this sentence, so it must be findable there.
          emitWorkerStatus(options, `[Worker] Finished without edits: ${noChangesReason.slice(0, 500)}`);
        } else {
          parsedResult.success = false;
          parsedResult.error = 'Worker reported success with no changed files and no explicit noChangesReason.';
        }
      }
    }

    // The agent introduces itself with a `Codename:` line (AGT-4019); the name
    // is its display identity on the coordination board.
    const codenameMatch = (parsedResult.output || '').match(/^\s*Codename:\s*(.{1,60}?)\s*$/mi);
    if (codenameMatch) {
      // A structured (JSON) codename wins over the plain-text introduction line.
      parsedResult.codename = parsedResult.codename ?? codenameMatch[1];
      // The introduction line is the agent's name, not part of what it said.
      if (parsedResult.summary) {
        parsedResult.summary = parsedResult.summary.replace(/^\s*Codename:.*$/mi, '').trim() || parsedResult.summary;
      }
    }

    return parsedResult;
  };

  let fallbackReason = 'policy';
  for (let i = 0; i < adaptersToTry.length; i += 1) {
    const adapterName = adaptersToTry[i];
    const isFallbackAttempt = i > 0;

    try {
      if (isFallbackAttempt) {
        const prev = adaptersToTry[i - 1];
        const logLine = `[Worker] ${fallbackReason} on ${prev}, fallback to ${adapterName}`;
        await recordRoute(prev, adapterName, fallbackReason);
        console.log(logLine);
        options.onLog?.(logLine);
      }

      const result = await runAttempt(adapterName, isFallbackAttempt);
      if (!isFallbackAttempt && isWorkerQuotaFailure(result) && adaptersToTry.length > 1 && routeAllowed('quota')) {
        fallbackReason = 'quota';
        continue;
      }
      if (isFallbackAttempt && result.error) {
        result.error = `[${adapterName}] ${result.error}`;
      }
      return result;
    } catch (error) {
      // A 429/usage-limit must STOP the run and propagate so the scheduler can
      // pause — never fall back to another adapter (it shares the same quota
      // window) and never get swallowed as a generic worker failure. (INT-1906)
      if (error instanceof RateLimitError) {
        if (!isFallbackAttempt && adaptersToTry.length > 1 && routeAllowed('quota')) { fallbackReason = 'quota'; continue; }
        throw error;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] Execution failed (${adapterName}): ${errMsg}`);
      // Match the exact base-adapter message — a bare 'code' substring also hit
      // "codex timeout ..." and mislabeled timeouts as auth failures.
      if (error instanceof Error && error.message.includes('CLI failed with code')) {
        console.error('[Worker] CLI exited with non-zero code — check adapter auth and permissions');
      }

      if (!isFallbackAttempt && isProviderQuotaError(errMsg) && adaptersToTry.length > 1 && routeAllowed('quota')) {
        fallbackReason = 'quota';
        continue;
      }

      // CLI/infra failure (non-zero exit, auth, spawn, timeout): the worker never
      // got to actually run, so this is NOT a task failure. Propagate so the
      // pipeline marks it 'infra_error' → backoff retry instead of a STUCK-counting
      // failure. (INT-2010)
      if (isInfraError(error)) {
        if (!isFallbackAttempt && adaptersToTry.length > 1 && routeAllowed('infra')) { fallbackReason = 'infra'; continue; }
        throw error;
      }

      return {
        success: false,
        summary: isFallbackAttempt ? `[${adapterName}] Worker execution failed` : 'Worker execution failed',
        filesChanged: [],
        commands: [],
        output: '',
        error: isFallbackAttempt ? `[${adapterName}] ${errMsg}` : errMsg,
      };
    }
  }

  return {
    success: false,
    summary: 'Worker execution failed',
    filesChanged: [],
    commands: [],
    output: '',
    error: 'Worker execution failed for all configured providers',
  };
}

// Formatting

/**
 * Format Worker result as a Discord message
 */
export function formatWorkReport(result: WorkerResult, context?: {
  issueIdentifier?: string;
  projectName?: string;
  projectPath?: string;
}): string {
  const lines: string[] = [];

  // Project/issue context header
  if (context?.projectName || context?.issueIdentifier || context?.projectPath) {
    const parts: string[] = [];
    // projectName fallback: extract from projectPath if not provided
    const displayName = context.projectName
      || (context.projectPath ? context.projectPath.split('/').pop() || '' : '');
    if (displayName) parts.push(`📁 ${displayName}`);
    if (context.issueIdentifier) parts.push(`🔖 ${context.issueIdentifier}`);
    if (context.projectPath) parts.push(`\`${context.projectPath.split('/').slice(-2).join('/')}\``);
    if (parts.length > 0) {
      lines.push(parts.join(' | '));
      lines.push('');
    }
  }

  lines.push(result.success
    ? t('agents.worker.report.completed')
    : t('agents.worker.report.failed'));
  lines.push('');
  lines.push(t('agents.worker.report.summary', { text: result.summary }));

  if (result.filesChanged.length > 0) {
    const files = result.filesChanged;
    const fileList = files.length <= 15
      ? files.join(', ')
      : `${files.slice(0, 15).join(', ')} ${t('common.moreItems', { n: files.length - 15 })}`;
    lines.push(t('agents.worker.report.filesChanged', { count: files.length, list: fileList }));
  }

  if (result.commands.length > 0) {
    const cmdList = result.commands.slice(0, 5).map((c) => `\`${c}\``).join(', ');
    lines.push(t('agents.worker.report.commands', { list: cmdList }));
  }

  if (result.error) {
    lines.push(t('agents.worker.report.error', { text: result.error }));
  }

  return lines.join('\n');
}
