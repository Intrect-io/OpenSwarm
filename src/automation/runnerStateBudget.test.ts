import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type RunnerStateModule = typeof import('./runnerState.js');

let tempHome = '';
let mod: RunnerStateModule;

async function loadFreshModule() {
  vi.resetModules();
  tempHome = mkdtempSync(join(tmpdir(), 'openswarm-budget-'));
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('USERPROFILE', tempHome);
  for (const v of ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'OPENSWARM_RUNNER_REJECTION_STATE_FILE',
    'OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE']) {
    vi.stubEnv(v, '');
  }
  mod = await import('./runnerState.js');
}

describe('daily creation budget reservations', () => {
  beforeEach(async () => {
    await loadFreshModule();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('grants a reservation that fits and refuses one that does not', () => {
    expect(mod.reserveDailyCreations(5, 5)).toBe(true);
    expect(mod.reserveDailyCreations(1, 5)).toBe(false);
  });

  it('stops a second caller from spending slots the first is holding', () => {
    // The defect this guards: both callers read the same pre-creation count
    // during the await-wide window before either registers, and both proceed.
    // (AGT-4122)
    expect(mod.reserveDailyCreations(3, 5)).toBe(true);
    expect(mod.reserveDailyCreations(3, 5)).toBe(false);
    // The hold blocks the second caller without being counted as spending.
    expect(mod.getHeldDailyCreations()).toBe(3);
    expect(mod.getDailyCreationCount()).toBe(0);
  });

  it('returns the slots when a held reservation is released', () => {
    mod.reserveDailyCreations(4, 5);
    mod.releaseDailyReservation(4);
    expect(mod.getDailyCreationCount()).toBe(0);
    expect(mod.reserveDailyCreations(5, 5)).toBe(true);
  });

  it('leaves what was actually registered behind after the hold is released', () => {
    mod.reserveDailyCreations(3, 10);
    mod.registerDecomposition('parent-1', undefined, ['child-1', 'child-2']);
    mod.releaseDailyReservation(3);
    // Two children were created under a hold of three: the budget reflects the
    // two, not the reservation.
    expect(mod.getDailyCreationCount()).toBe(2);
  });

  it('persists only what was created, not what was held', async () => {
    // A hold folded into the persisted state would survive a restart and be
    // read back as real spending for the rest of the day. (gate round 4)
    mod.reserveDailyCreations(5, 10);
    mod.registerDecomposition('parent-1', undefined, ['child-1', 'child-2']);
    mod.releaseDailyReservation(5);

    vi.resetModules();
    const reloaded = await import('./runnerState.js');
    expect(reloaded.getDailyCreationCount()).toBe(2);
    expect(reloaded.getHeldDailyCreations()).toBe(0);
  });

  it('never drives the count below zero on an over-release', () => {
    mod.releaseDailyReservation(9);
    expect(mod.getDailyCreationCount()).toBe(0);
  });
});
