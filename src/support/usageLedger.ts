// ============================================
// OpenSwarm - LLM usage ledger
// ============================================
//
// Append-only record of every model API call the process makes, so spend can
// be attributed after the fact — by model, by pipeline stage, by task, by day.
// Nothing else in the daemon keeps this: the run ledger stores outcomes, the
// logs print per-run token totals, and a run that dies mid-way (infra error,
// rate limit, lease expiry) used to leave no trace of the tokens it burned.
//
// One JSON line per call under `~/.openswarm/usage/<UTC date>.jsonl`. The
// file is opened O_APPEND and each record is a single write, so concurrent
// writers on one host never interleave lines. `costUsd` is the provider's own
// metered charge when the response carried one (OpenRouter attaches it to
// every response); it is `null` — not 0 — when the provider reports no price,
// so unmetered spend is visible as a count instead of vanishing into a $0
// total. No price table lives here: it would go stale. (AGT-4178)

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface UsageRecord {
  /** ISO-8601 UTC timestamp of the response. */
  ts: string;
  /** Adapter name (openrouter, gpt, local, atlascloud, codex-responses, …). */
  adapter: string;
  model: string;
  /** Pipeline task identity (issue identifier or scheduler task id) when known. */
  taskId?: string;
  /** Pipeline stage (worker, reviewer, draft, decompose, groom, orchestrator, chat, …). */
  stage?: string;
  /** Working directory the call served; the project is derived from its basename. */
  cwd?: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt-cache hits, a subset of promptTokens. */
  cachedTokens: number;
  /** Reasoning tokens, a subset of completionTokens. */
  reasoningTokens: number;
  /** Metered charge in USD, or null when the provider did not price the call. */
  costUsd: number | null;
  /** Upstream provider charge when routed through a proxy (OpenRouter BYOK). */
  upstreamCostUsd?: number;
  durationMs?: number;
}

/** Attribution the agentic loop stamps on every record it writes. */
export interface UsageAttribution {
  adapter: string;
  taskId?: string;
  stage?: string;
}

export function usageLedgerDir(): string {
  return process.env.OPENSWARM_USAGE_DIR ?? join(homedir(), '.openswarm', 'usage');
}

/** `YYYY-MM-DD` in UTC — the ledger partitions by UTC day, matching the ISO `ts`. */
export function usageDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

let warnedWriteFailure = false;

/**
 * Append one record. Never throws: losing a ledger line must not fail the
 * model call that produced it. The first failure is logged once so a
 * misconfigured directory is noticed without flooding the daemon log.
 */
export function recordUsage(record: UsageRecord): void {
  try {
    const dir = usageLedgerDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${usageDayKey(new Date(record.ts))}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch (error) {
    if (warnedWriteFailure) return;
    warnedWriteFailure = true;
    console.warn(`[UsageLedger] write failed (further failures silent): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Test seam: reset the one-shot warning latch. */
export function resetUsageLedgerWarning(): void {
  warnedWriteFailure = false;
}

export interface UsageWindow {
  /** Inclusive lower bound (epoch ms). */
  since: number;
  /**
   * Inclusive upper bound (epoch ms); defaults to now. Inclusive because a
   * caller reading "up to now" right after a call must see the record that
   * was written in this same millisecond.
   */
  until?: number;
}

/**
 * Read every record whose `ts` falls inside the window. Only the day files
 * that can overlap the window are opened, and a corrupt line (a crash mid
 * write is the realistic cause) is skipped rather than poisoning the whole
 * day.
 */
export function readUsage(window: UsageWindow, dir: string = usageLedgerDir()): UsageRecord[] {
  const until = window.until ?? Date.now();
  if (!existsSync(dir)) return [];
  const first = usageDayKey(new Date(window.since));
  const last = usageDayKey(new Date(until));
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .filter((name) => {
      const day = name.slice(0, 10);
      return day >= first && day <= last;
    })
    .sort();
  const records: UsageRecord[] = [];
  for (const name of files) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUsageRecord(parsed)) continue;
      const at = Date.parse(parsed.ts);
      if (Number.isNaN(at) || at < window.since || at > until) continue;
      records.push(parsed);
    }
  }
  return records;
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.ts === 'string'
    && typeof v.adapter === 'string'
    && typeof v.model === 'string'
    && typeof v.promptTokens === 'number'
    && typeof v.completionTokens === 'number'
    && (typeof v.costUsd === 'number' || v.costUsd === null);
}

export const USAGE_GROUP_KEYS = ['model', 'stage', 'task', 'project', 'adapter', 'day'] as const;
export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

export interface UsageAggregateRow {
  key: string;
  calls: number;
  /** Calls whose provider reported a price; `costUsd` sums only these. */
  meteredCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface UsageAggregate {
  by: UsageGroupKey;
  rows: UsageAggregateRow[];
  total: UsageAggregateRow;
}

function groupKeyOf(record: UsageRecord, by: UsageGroupKey): string {
  switch (by) {
    case 'model': return record.model;
    case 'adapter': return record.adapter;
    case 'stage': return record.stage ?? '(unattributed)';
    case 'task': return record.taskId ?? '(unattributed)';
    case 'project': return record.cwd ? basename(record.cwd) : '(unknown)';
    case 'day': return record.ts.slice(0, 10);
  }
}

function emptyRow(key: string): UsageAggregateRow {
  return { key, calls: 0, meteredCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

function addTo(row: UsageAggregateRow, record: UsageRecord): void {
  row.calls += 1;
  row.promptTokens += record.promptTokens;
  row.completionTokens += record.completionTokens;
  row.cachedTokens += record.cachedTokens ?? 0;
  row.reasoningTokens += record.reasoningTokens ?? 0;
  if (record.costUsd !== null) {
    row.meteredCalls += 1;
    row.costUsd += record.costUsd;
  }
}

/** Group and sum. Rows are ordered by cost, then by prompt tokens for unmetered ties. */
export function aggregateUsage(records: readonly UsageRecord[], by: UsageGroupKey): UsageAggregate {
  const rows = new Map<string, UsageAggregateRow>();
  const total = emptyRow('total');
  for (const record of records) {
    const key = groupKeyOf(record, by);
    let row = rows.get(key);
    if (!row) {
      row = emptyRow(key);
      rows.set(key, row);
    }
    addTo(row, record);
    addTo(total, record);
  }
  const ordered = [...rows.values()].sort((a, b) => (b.costUsd - a.costUsd) || (b.promptTokens - a.promptTokens));
  return { by, rows: ordered, total };
}

/**
 * Parse a window spec: a duration (`90m`, `24h`, `7d`) measured back from
 * `now`, or an ISO date/time. Returns null for anything else.
 */
export function parseUsageSince(spec: string, now: number = Date.now()): number | null {
  const duration = /^(\d+)([mhd])$/.exec(spec.trim());
  if (duration) {
    const n = Number(duration[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as 'm' | 'h' | 'd'];
    return now - n * unit;
  }
  const at = Date.parse(spec);
  return Number.isNaN(at) ? null : at;
}

export interface UsageQuery {
  /** Window spec accepted by parseUsageSince. */
  since: string;
  /** One of USAGE_GROUP_KEYS. */
  by: string;
  now?: number;
}

export type UsageQueryResult =
  | { ok: true; since: number; until: number; by: UsageGroupKey; aggregate: UsageAggregate; dir: string }
  | { ok: false; error: string };

export function isUsageGroupKey(value: string): value is UsageGroupKey {
  return (USAGE_GROUP_KEYS as readonly string[]).includes(value);
}

/** Validate a window/group query and aggregate the ledger. Shared by `openswarm cost` and GET /api/usage. */
export function queryUsage(query: UsageQuery): UsageQueryResult {
  const now = query.now ?? Date.now();
  const since = parseUsageSince(query.since, now);
  if (since === null) return { ok: false, error: `invalid --since '${query.since}': use a duration (90m, 24h, 7d) or an ISO date` };
  if (!isUsageGroupKey(query.by)) return { ok: false, error: `invalid --by '${query.by}': one of ${USAGE_GROUP_KEYS.join(', ')}` };
  const records = readUsage({ since, until: now });
  return { ok: true, since, until: now, by: query.by, aggregate: aggregateUsage(records, query.by), dir: usageLedgerDir() };
}
