// ============================================
// OpenSwarm - `openswarm cost`
// ============================================
//
// Reads the usage ledger and prints spend grouped by model / stage / task /
// project / adapter / day. The same aggregate backs GET /api/usage so the
// CLI and the dashboard never disagree. (AGT-4178)

import { queryUsage, type UsageAggregateRow, type UsageQueryResult } from '../support/usageLedger.js';

export { queryUsage };

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function usd(row: UsageAggregateRow): string {
  if (row.meteredCalls === 0) return '—';
  // Sub-cent rows (one cheap call) would all print as $0.0000 at four places.
  const value = `$${row.costUsd.toFixed(row.costUsd < 0.01 ? 6 : 4)}`;
  return row.meteredCalls < row.calls ? `${value}*` : value;
}

/** Render the aggregate as a fixed-width table. Pure so it can be asserted on. */
export function formatCostTable(result: Extract<UsageQueryResult, { ok: true }>): string {
  const { aggregate } = result;
  const rows = aggregate.rows;
  const keyWidth = Math.max(aggregate.by.length, 5, ...rows.map((r) => r.key.length), 5);
  const header = [
    aggregate.by.padEnd(keyWidth), 'calls'.padStart(6), 'in'.padStart(9), 'out'.padStart(8),
    'cached'.padStart(9), 'cost'.padStart(11),
  ].join('  ');
  const line = (r: UsageAggregateRow, label = r.key) => [
    label.padEnd(keyWidth), String(r.calls).padStart(6), tokens(r.promptTokens).padStart(9),
    tokens(r.completionTokens).padStart(8), tokens(r.cachedTokens).padStart(9), usd(r).padStart(11),
  ].join('  ');
  const out: string[] = [
    `Usage since ${new Date(result.since).toISOString()} (${result.dir})`,
    header,
    '-'.repeat(header.length),
    ...rows.map((r) => line(r)),
  ];
  if (rows.length === 0) out.push('(no calls recorded in this window)');
  out.push('-'.repeat(header.length), line(aggregate.total, 'total'));
  const unmetered = aggregate.total.calls - aggregate.total.meteredCalls;
  if (unmetered > 0) {
    out.push(`* ${unmetered} call(s) reported no price (subscription or local provider) and are excluded from cost.`);
  }
  return out.join('\n');
}

export async function runCostCommand(opts: { since?: string; by?: string; json?: boolean }): Promise<void> {
  const result = queryUsage({ since: opts.since ?? '24h', by: opts.by ?? 'model' });
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ since: new Date(result.since).toISOString(), until: new Date(result.until).toISOString(), ...result.aggregate }, null, 2));
    return;
  }
  console.log(formatCostTable(result));
}
