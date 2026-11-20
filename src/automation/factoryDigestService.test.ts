import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutonomousStartupConfig } from '../core/types.js';

const stop = vi.fn();
vi.mock('./factoryDigest.js', () => ({ DEFAULT_FACTORY_DIGEST_SCHEDULE: '5 0 * * *', startFactoryDigest: vi.fn(() => stop) }));
vi.mock('../support/webFactoryDigest.js', () => ({ setFactoryDigestOptions: vi.fn() }));
vi.mock('./automationDbPath.js', () => ({ defaultAutomationDbPath: () => '/default/automation.db' }));

const { startFactoryDigest } = await import('./factoryDigest.js');
const { setFactoryDigestOptions } = await import('../support/webFactoryDigest.js');
const { startConfiguredFactoryDigest } = await import('./factoryDigestService.js');

const send = async () => {};

// AGT-4810 review: the digest borrowed the daily reporter's schedule in host
// local time and its stop handle was dropped, so a stopped service kept posting.
describe('startConfiguredFactoryDigest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules in UTC on autonomous.factoryDigest.schedule and returns the stop handle', () => {
    const autonomous = { factoryDigest: { schedule: '15 0 * * *' }, automationDbPath: '/x/a.db' } as AutonomousStartupConfig;
    expect(startConfiguredFactoryDigest(autonomous, send)).toBe(stop);
    const opts = vi.mocked(startFactoryDigest).mock.calls[0][0];
    expect(opts).toMatchObject({ schedule: '15 0 * * *', timezone: 'UTC', send });
    expect(opts.dbPath()).toBe('/x/a.db');
  });

  it('defaults to shortly after 00:00 UTC and the default database', () => {
    startConfiguredFactoryDigest({} as AutonomousStartupConfig, send);
    const opts = vi.mocked(startFactoryDigest).mock.calls[0][0];
    expect(opts).toMatchObject({ schedule: '5 0 * * *', timezone: 'UTC' });
    expect(opts.dbPath()).toBe('/default/automation.db');
  });

  it('prices unpriced attempts as the budget does, for the cron and the dashboard', () => {
    const autonomous = { spend: { unknownAttemptCostUsd: 1.5 } } as AutonomousStartupConfig;
    startConfiguredFactoryDigest(autonomous, send);
    expect(setFactoryDigestOptions).toHaveBeenCalledWith({ unknownAttemptCostUsd: 1.5 });
    expect(vi.mocked(startFactoryDigest).mock.calls[0][0].unknownAttemptCostUsd?.()).toBe(1.5);
  });
});
