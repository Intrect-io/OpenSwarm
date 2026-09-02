import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateUsage,
  parseUsageSince,
  readUsage,
  recordUsage,
  resetUsageLedgerWarning,
  usageDayKey,
  type UsageRecord,
} from './usageLedger.js';

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: '2026-09-02T03:00:00.000Z',
    adapter: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    taskId: 'AGT-1',
    stage: 'worker',
    cwd: '/work/vega-agent',
    promptTokens: 1000,
    completionTokens: 100,
    cachedTokens: 400,
    reasoningTokens: 0,
    costUsd: 0.0012,
    durationMs: 900,
    ...overrides,
  };
}

describe('usage ledger', () => {
  let dir = '';
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-usage-'));
    prevDir = process.env.OPENSWARM_USAGE_DIR;
    process.env.OPENSWARM_USAGE_DIR = dir;
    resetUsageLedgerWarning();
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.OPENSWARM_USAGE_DIR;
    else process.env.OPENSWARM_USAGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('appends one JSON line per call into the UTC day file of its timestamp', () => {
    recordUsage(record({ ts: '2026-09-01T23:59:59.000Z' }));
    recordUsage(record({ ts: '2026-09-02T00:00:00.000Z', model: 'z-ai/glm-5.3' }));
    expect(readdirSync(dir).sort()).toEqual(['2026-09-01.jsonl', '2026-09-02.jsonl']);
    const lines = readFileSync(join(dir, '2026-09-02.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).model).toBe('z-ai/glm-5.3');
  });

  it('reads back only the window, spanning day files and skipping corrupt lines', () => {
    recordUsage(record({ ts: '2026-09-01T22:00:00.000Z', taskId: 'old' }));
    recordUsage(record({ ts: '2026-09-01T23:30:00.000Z', taskId: 'in-1' }));
    recordUsage(record({ ts: '2026-09-02T00:30:00.000Z', taskId: 'in-2' }));
    recordUsage(record({ ts: '2026-09-02T02:00:00.000Z', taskId: 'future' }));
    writeFileSync(join(dir, '2026-09-02.jsonl'), '{"truncated": tru\n', { flag: 'a' });

    const since = Date.parse('2026-09-01T23:00:00.000Z');
    const until = Date.parse('2026-09-02T01:00:00.000Z');
    expect(readUsage({ since, until }).map((r) => r.taskId)).toEqual(['in-1', 'in-2']);
  });

  it('never throws on a write failure and warns exactly once', () => {
    process.env.OPENSWARM_USAGE_DIR = join(dir, 'not-a-dir');
    writeFileSync(join(dir, 'not-a-dir'), 'file, not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recordUsage(record())).not.toThrow();
    expect(() => recordUsage(record())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[UsageLedger] write failed');
  });

  it('aggregates by model, ordering by cost and counting unmetered calls separately', () => {
    const rows = aggregateUsage([
      record({ model: 'cheap', costUsd: 0.001 }),
      record({ model: 'cheap', costUsd: 0.002, cachedTokens: 0 }),
      record({ model: 'pricey', costUsd: 0.5, promptTokens: 50 }),
      record({ model: 'local', costUsd: null, promptTokens: 9999 }),
    ], 'model');
    expect(rows.rows.map((r) => r.key)).toEqual(['pricey', 'cheap', 'local']);
    expect(rows.rows[1]).toMatchObject({ calls: 2, meteredCalls: 2, promptTokens: 2000, cachedTokens: 400, costUsd: 0.003 });
    expect(rows.rows[2]).toMatchObject({ calls: 1, meteredCalls: 0, costUsd: 0 });
    expect(rows.total).toMatchObject({ calls: 4, meteredCalls: 3, costUsd: 0.503 });
  });

  it('groups by stage, task, project basename and UTC day', () => {
    const records = [
      record({ stage: undefined, taskId: undefined, cwd: undefined }),
      record({ ts: '2026-09-03T01:00:00.000Z', cwd: '/work/cgf-portal' }),
    ];
    expect(aggregateUsage(records, 'stage').rows.map((r) => r.key).sort()).toEqual(['(unattributed)', 'worker']);
    expect(aggregateUsage(records, 'task').rows.map((r) => r.key).sort()).toEqual(['(unattributed)', 'AGT-1']);
    expect(aggregateUsage(records, 'project').rows.map((r) => r.key).sort()).toEqual(['(unknown)', 'cgf-portal']);
    expect(aggregateUsage(records, 'day').rows.map((r) => r.key).sort()).toEqual(['2026-09-02', '2026-09-03']);
  });

  it('parses durations back from now and ISO dates', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z');
    expect(parseUsageSince('90m', now)).toBe(now - 90 * 60_000);
    expect(parseUsageSince('24h', now)).toBe(now - 24 * 3_600_000);
    expect(parseUsageSince('7d', now)).toBe(now - 7 * 86_400_000);
    expect(parseUsageSince('2026-09-01', now)).toBe(Date.parse('2026-09-01'));
    expect(parseUsageSince('yesterday', now)).toBeNull();
    expect(usageDayKey(new Date('2026-09-02T23:59:59.999Z'))).toBe('2026-09-02');
  });
});
