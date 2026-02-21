// ============================================
// Claude Swarm - Cost Tracker
// Common cost extraction utilities for Claude CLI output
// ============================================

// ============================================
// Types
// ============================================

export type CostInfo = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  model?: string;
};

// ============================================
// Extraction
// ============================================

/**
 * Extract cost from Claude CLI JSON array output (--output-format json)
 * Format: [{ type: 'result', total_cost_usd, usage, duration_ms, ... }]
 */
export function extractCostFromJson(output: string): CostInfo | undefined {
  try {
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) return undefined;

    const arr = JSON.parse(match[0]);
    for (const item of arr) {
      if (item.type === 'result') {
        return extractFromResultEvent(item);
      }
    }
  } catch {
    // Parse failure
  }
  return undefined;
}

/**
 * Extract cost from Claude CLI stream-json output (--output-format stream-json)
 * Format: newline-delimited JSON, each line is { type: 'result', ... }
 */
export function extractCostFromStreamJson(output: string): CostInfo | undefined {
  try {
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          return extractFromResultEvent(event);
        }
      } catch {
        // Not a valid JSON line
      }
    }
  } catch {
    // Parse failure
  }
  return undefined;
}

/**
 * Extract CostInfo from a result event object
 */
function extractFromResultEvent(event: any): CostInfo | undefined {
  if (event.total_cost_usd == null && !event.usage) return undefined;

  return {
    costUsd: event.total_cost_usd ?? 0,
    inputTokens: event.usage?.input_tokens ?? 0,
    outputTokens: event.usage?.output_tokens ?? 0,
    cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: event.usage?.cache_creation_input_tokens ?? 0,
    durationMs: event.duration_ms ?? 0,
    model: event.model,
  };
}

// ============================================
// Aggregation
// ============================================

/**
 * Aggregate multiple CostInfo into a single total
 */
export function aggregateCosts(costs: (CostInfo | undefined)[]): CostInfo {
  const result: CostInfo = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 0,
  };

  for (const cost of costs) {
    if (!cost) continue;
    result.costUsd += cost.costUsd;
    result.inputTokens += cost.inputTokens;
    result.outputTokens += cost.outputTokens;
    result.cacheReadTokens += cost.cacheReadTokens;
    result.cacheCreationTokens += cost.cacheCreationTokens;
    result.durationMs += cost.durationMs;
  }

  return result;
}

// ============================================
// Formatting
// ============================================

/**
 * Format token count with k/M suffix
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format CostInfo as a human-readable log string
 * Example: "$0.0432 | 1.2k in / 0.8k out | 12.3s"
 */
export function formatCost(cost: CostInfo): string {
  const usd = `$${cost.costUsd.toFixed(4)}`;
  const tokens = `${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out`;
  const duration = `${(cost.durationMs / 1000).toFixed(1)}s`;
  return `${usd} | ${tokens} | ${duration}`;
}
