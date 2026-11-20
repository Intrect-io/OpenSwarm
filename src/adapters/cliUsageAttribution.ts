// ============================================
// OpenSwarm - Usage ledger attribution for delegated CLI runs
// ============================================
//
// The in-process agentic loop writes one usage-ledger line per model call
// under the run's UsageAttribution. Delegated CLIs (claude -p, codex exec) own
// their model loop, so the only usage OpenSwarm can see is what the CLI
// reports in its event stream. This module turns that report into the same
// ledger record, once per CLI run. A run that reports no usage, or that was
// started without any attribution, is still written — tagged `unattributed`
// with the reason — so delegated spend never vanishes from the ledger.
// (AGT-4444)

import { recordUsage, type UsageRecord } from '../support/usageLedger.js';
import type { CliRunOptions } from './types.js';

/** Usage a delegated CLI reported for one run. */
export interface CliRunUsage {
  /** Total prompt tokens, including cache reads and cache writes. */
  promptTokens: number;
  completionTokens: number;
  /** Prompt-cache hits, a subset of promptTokens. */
  cachedTokens: number;
  /** Reasoning tokens, a subset of completionTokens. */
  reasoningTokens: number;
  /** Metered charge in USD, or null when the CLI did not price the run. */
  costUsd: number | null;
  /** Model the CLI reported serving, when it reports exactly one. */
  servedModel?: string;
}

export interface CliUsageRecordInput {
  /** Adapter name used when no explicit attribution names one. */
  adapterName: string;
  /** Model recorded when the run options carry none (the adapter's default). */
  fallbackModel: string;
  options: Pick<CliRunOptions, 'model' | 'cwd' | 'usageAttribution' | 'processContext'>;
  usage: CliRunUsage | undefined;
  durationMs?: number;
  /** Clock seam for tests. */
  now?: Date;
}

/**
 * Build the ledger record for one delegated CLI run.
 *
 * Attribution follows the session recorder in spawnCli: an explicit
 * `usageAttribution` wins, else the run's `processContext` (which is what the
 * in-process adapters derive their attribution from). With neither, the
 * record is tagged `unattributed: 'no-attribution'`. A run whose stream
 * carried no usage is recorded with zero tokens and a null cost, tagged
 * `unattributed: 'no-usage'`, so it still counts as an unmetered call.
 */
export function buildCliUsageRecord(input: CliUsageRecordInput): UsageRecord {
  const { options, usage } = input;
  const attribution = options.usageAttribution;
  const taskId = attribution?.taskId ?? options.processContext?.taskId;
  const stage = attribution?.stage ?? options.processContext?.stage;
  const attributed = Boolean(attribution || options.processContext);
  const unattributed: UsageRecord['unattributed'] = !usage
    ? 'no-usage'
    : attributed ? undefined : 'no-attribution';
  return {
    ts: (input.now ?? new Date()).toISOString(),
    adapter: attribution?.adapter ?? input.adapterName,
    model: options.model?.trim() || input.fallbackModel,
    ...(usage?.servedModel ? { servedModel: usage.servedModel } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(stage !== undefined ? { stage } : {}),
    cwd: options.cwd,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    costUsd: usage?.costUsd ?? null,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(unattributed ? { unattributed } : {}),
  };
}

/** Write the ledger record for one delegated CLI run. Never throws. */
export function recordCliRunUsage(input: CliUsageRecordInput): UsageRecord | undefined {
  try {
    const record = buildCliUsageRecord(input);
    recordUsage(record);
    return record;
  } catch {
    // Same contract as recordUsage: a lost ledger line must not fail the run.
    return undefined;
  }
}

/** Each JSON object line of an NDJSON event stream; other lines are skipped. */
function* jsonEvents(stdout: string): Generator<Record<string, unknown>> {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event: unknown = JSON.parse(trimmed);
      if (event && typeof event === 'object') yield event as Record<string, unknown>;
    } catch {
      // Not a JSON event line.
    }
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Usage from claude's stream-json `result` event (`total_cost_usd`, `usage`).
 * The Anthropic `input_tokens` excludes cache reads and cache writes, so they
 * are added back to keep `cachedTokens` a subset of `promptTokens`. Returns
 * undefined when no result event carries usage or cost.
 */
export function extractClaudeRunUsage(stdout: string): CliRunUsage | undefined {
  let found: CliRunUsage | undefined;
  for (const event of jsonEvents(stdout)) {
    if (event.type !== 'result') continue;
    const usage = event.usage && typeof event.usage === 'object'
      ? event.usage as Record<string, unknown>
      : undefined;
    const cost = finiteNumber(event.total_cost_usd);
    if (!usage && cost === undefined) continue;
    const input = finiteNumber(usage?.input_tokens) ?? 0;
    const cacheRead = finiteNumber(usage?.cache_read_input_tokens) ?? 0;
    const cacheWrite = finiteNumber(usage?.cache_creation_input_tokens) ?? 0;
    const models = event.modelUsage && typeof event.modelUsage === 'object'
      ? Object.keys(event.modelUsage as object)
      : [];
    found = {
      promptTokens: input + cacheRead + cacheWrite,
      completionTokens: finiteNumber(usage?.output_tokens) ?? 0,
      cachedTokens: cacheRead,
      reasoningTokens: 0,
      costUsd: cost ?? null,
      ...(models.length === 1 ? { servedModel: models[0] } : {}),
    };
  }
  return found;
}

/**
 * Usage from codex `exec --json` `turn.completed` events. Each event carries
 * the usage of that turn, so a multi-turn run is summed. Codex reports no
 * price, so the cost is always null (unmetered). Returns undefined when no
 * turn reported usage.
 */
export function extractCodexRunUsage(stdout: string): CliRunUsage | undefined {
  let found: CliRunUsage | undefined;
  for (const event of jsonEvents(stdout)) {
    if (event.type !== 'turn.completed' || !event.usage || typeof event.usage !== 'object') continue;
    const usage = event.usage as Record<string, unknown>;
    found ??= { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: null };
    found.promptTokens += finiteNumber(usage.input_tokens) ?? 0;
    found.cachedTokens += finiteNumber(usage.cached_input_tokens) ?? 0;
    found.completionTokens += finiteNumber(usage.output_tokens) ?? 0;
    found.reasoningTokens += finiteNumber(usage.reasoning_output_tokens) ?? 0;
  }
  return found;
}
