import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordUsage } from '../support/usageLedger.js';
import { formatCostTable, queryUsage } from './costCommand.js';

describe('openswarm cost', () => {
  let dir = '';
  let prevDir: string | undefined;
  const now = Date.parse('2026-09-02T12:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-cost-'));
    prevDir = process.env.OPENSWARM_USAGE_DIR;
    process.env.OPENSWARM_USAGE_DIR = dir;
    recordUsage({ ts: '2026-09-02T11:00:00.000Z', adapter: 'openrouter', model: 'z-ai/glm-5.3', stage: 'decompose', promptTokens: 400_000, completionTokens: 3_000, cachedTokens: 0, reasoningTokens: 800, costUsd: 0.57 });
    recordUsage({ ts: '2026-09-02T11:30:00.000Z', adapter: 'openrouter', model: 'deepseek/deepseek-v4-flash', stage: 'worker', promptTokens: 700_000, completionTokens: 4_000, cachedTokens: 500_000, reasoningTokens: 0, costUsd: 0.06 });
    recordUsage({ ts: '2026-09-02T11:40:00.000Z', adapter: 'codex-responses', model: 'gpt-5.6-sol', stage: 'worker', promptTokens: 10_000, completionTokens: 200, cachedTokens: 0, reasoningTokens: 0, costUsd: null });
    recordUsage({ ts: '2026-09-02T11:45:00.000Z', adapter: 'openrouter', model: 'qwen/qwen3-235b-a22b-2507', stage: 'draft', promptTokens: 117, completionTokens: 2, cachedTokens: 0, reasoningTokens: 0, costUsd: 0.0000082803 });
    recordUsage({ ts: '2026-09-01T11:40:00.000Z', adapter: 'openrouter', model: 'z-ai/glm-5.3', stage: 'orchestrator', promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, costUsd: 9 });
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.OPENSWARM_USAGE_DIR;
    else process.env.OPENSWARM_USAGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unknown window or group key', () => {
    expect(queryUsage({ since: 'soon', by: 'model', now })).toMatchObject({ ok: false, error: expect.stringContaining("--since 'soon'") });
    expect(queryUsage({ since: '1h', by: 'colour', now })).toMatchObject({ ok: false, error: expect.stringContaining("--by 'colour'") });
  });

  it('renders the window as a table with an unmetered footnote', () => {
    const result = queryUsage({ since: '2h', by: 'model', now });
    if (!result.ok) throw new Error(result.error);
    const table = formatCostTable(result);
    const lines = table.split('\n');
    expect(lines[0]).toContain('Usage since 2026-09-02T10:00:00.000Z');
    expect(lines[1].trim().split(/\s+/)).toEqual(['model', 'calls', 'in', 'out', 'cached', 'cost']);
    expect(lines[3].trim().split(/\s+/)).toEqual(['z-ai/glm-5.3', '1', '400.0k', '3.0k', '0', '$0.5700']);
    expect(lines[4].trim().split(/\s+/)).toEqual(['deepseek/deepseek-v4-flash', '1', '700.0k', '4.0k', '500.0k', '$0.0600']);
    expect(lines[5].trim().split(/\s+/)).toEqual(['qwen/qwen3-235b-a22b-2507', '1', '117', '2', '0', '$0.000008']);
    expect(lines[6].trim().split(/\s+/)).toEqual(['gpt-5.6-sol', '1', '10.0k', '200', '0', '—']);
    expect(lines[8].trim().split(/\s+/)).toEqual(['total', '4', '1.11M', '7.2k', '500.0k', '$0.6300*']);
    expect(lines[9]).toContain('1 call(s) reported no price');
    expect(table).not.toContain('orchestrator');
  });

  it('groups by stage for the API payload', () => {
    const result = queryUsage({ since: '24h', by: 'stage', now });
    if (!result.ok) throw new Error(result.error);
    expect(result.aggregate.rows.map((r) => [r.key, r.calls])).toEqual([['decompose', 1], ['worker', 2], ['draft', 1]]);
  });
});
