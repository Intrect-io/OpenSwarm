import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { resolvePerIssueAttemptsPerDay } from '../automation/runLedgerCost.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), existsSync: vi.fn(actual.existsSync) };
});

const base = { language: 'en', agents: [{ name: 'main', projectPath: '/p' }] };

describe('autonomous.budget (AGT-4807)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISCORD_TOKEN = 't';
    process.env.DISCORD_CHANNEL_ID = 'c';
    process.env.LINEAR_API_KEY = 'k';
    process.env.LINEAR_TEAM_ID = 'team';
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    for (const key of ['DISCORD_TOKEN', 'DISCORD_CHANNEL_ID', 'LINEAR_API_KEY', 'LINEAR_TEAM_ID']) delete process.env[key];
  });

  it('carries both budgets through to the autonomous config', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { budget: { perProjectDailyUsd: 20, perIssueUsd: 4 } } }));
    expect(loadConfig('/tmp/config.json').autonomous?.budget).toEqual({ perProjectDailyUsd: 20, perIssueUsd: 4 });
  });

  it('is optional', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: {} }));
    expect(loadConfig('/tmp/config.json').autonomous?.budget).toBeUndefined();
  });

  it('carries perIssueAttemptsPerDay, which defaults to 3 at admission when unset (AGT-4787)', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { budget: { perIssueAttemptsPerDay: 5 } } }));
    expect(loadConfig('/tmp/config.json').autonomous?.budget).toEqual({ perIssueAttemptsPerDay: 5 });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { budget: { perIssueUsd: 4 } } }));
    expect(resolvePerIssueAttemptsPerDay(loadConfig('/tmp/config.json').autonomous?.budget)).toBe(3);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: {} }));
    expect(resolvePerIssueAttemptsPerDay(loadConfig('/tmp/config.json').autonomous?.budget)).toBe(3);
  });

  it('rejects a zero, negative or fractional perIssueAttemptsPerDay', () => {
    for (const perIssueAttemptsPerDay of [0, -1, 2.5, '3']) {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { budget: { perIssueAttemptsPerDay } } }));
      expect(() => loadConfig('/tmp/config.json')).toThrow();
    }
  });

  it('rejects a zero or negative budget, which would park everything', () => {
    for (const budget of [{ perIssueUsd: 0 }, { perProjectDailyUsd: -1 }]) {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { budget } }));
      expect(() => loadConfig('/tmp/config.json')).toThrow();
    }
  });
});

// AGT-4810 review: the digest borrowed dailyReporter.schedule; it has its own key now.
describe('autonomous.factoryDigest (AGT-4810)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISCORD_TOKEN = 't';
    process.env.DISCORD_CHANNEL_ID = 'c';
    process.env.LINEAR_API_KEY = 'k';
    process.env.LINEAR_TEAM_ID = 'team';
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    for (const key of ['DISCORD_TOKEN', 'DISCORD_CHANNEL_ID', 'LINEAR_API_KEY', 'LINEAR_TEAM_ID']) delete process.env[key];
  });

  it('carries autonomous.factoryDigest.schedule through loadConfig, and leaves it unset by default', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: { factoryDigest: { schedule: '30 0 * * *' } } }));
    expect(loadConfig('/tmp/config.json').autonomous?.factoryDigest).toEqual({ schedule: '30 0 * * *' });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...base, autonomous: {} }));
    expect(loadConfig('/tmp/config.json').autonomous?.factoryDigest).toBeUndefined();
  });
});
