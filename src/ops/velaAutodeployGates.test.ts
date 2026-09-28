import { describe, expect, it } from 'vitest';
import { ACTIVE_LEASE_STATES } from '../automation/runLedgerTypes.js';
import {
  AUTODEPLOY_ACTIVE_LEDGER_STATES,
  AUTODEPLOY_RATE_LIMIT_MIN_DEFAULT,
  decideAutodeployGate,
} from './velaAutodeployGates.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('decideAutodeployGate', () => {
  it('keeps ledger safety states in sync with ACTIVE_LEASE_STATES', () => {
    expect([...AUTODEPLOY_ACTIVE_LEDGER_STATES].sort()).toEqual(
      [...ACTIVE_LEASE_STATES].sort(),
    );
  });

  it('skips when last-built sha equals origin/main', () => {
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: MAIN,
        ledgerActiveCount: 0,
        containerAgeMinutes: 120,
      }),
    ).toEqual({
      action: 'skip',
      reason: `running image already built from ${MAIN}`,
    });
  });

  it('skips when ledger DB cannot be queried', () => {
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: OTHER,
        ledgerActiveCount: null,
        containerAgeMinutes: 120,
      }),
    ).toEqual({
      action: 'skip',
      reason: 'cannot query automation DB — daemon may be down or starting',
    });
  });

  it('skips when ledger has active VERIFYING/PUBLISHING/EXECUTING/CLAIMED rows', () => {
    expect(AUTODEPLOY_ACTIVE_LEDGER_STATES).toEqual([
      'VERIFYING',
      'PUBLISHING',
      'EXECUTING',
      'CLAIMED',
    ]);
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: OTHER,
        ledgerActiveCount: 2,
        containerAgeMinutes: 120,
      }),
    ).toEqual({
      action: 'skip',
      reason: 'ledger has 2 active run(s) in VERIFYING/PUBLISHING/EXECUTING/CLAIMED',
    });
  });

  it('skips when container age is under the rate limit', () => {
    expect(AUTODEPLOY_RATE_LIMIT_MIN_DEFAULT).toBe(55);
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: OTHER,
        ledgerActiveCount: 0,
        containerAgeMinutes: 10,
      }),
    ).toEqual({
      action: 'skip',
      reason: 'container started 10m ago (< 55m rate limit)',
    });
  });

  it('deploys when sha advanced, ledger idle, and rate limit clear', () => {
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: OTHER,
        ledgerActiveCount: 0,
        containerAgeMinutes: 60,
      }),
    ).toEqual({ action: 'deploy' });
  });

  it('deploys when container is not running (fresh deploy)', () => {
    expect(
      decideAutodeployGate({
        mainSha: MAIN,
        lastBuiltSha: null,
        ledgerActiveCount: 0,
        containerAgeMinutes: null,
      }),
    ).toEqual({ action: 'deploy' });
  });
});
