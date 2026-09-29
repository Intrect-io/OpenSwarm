// The daily creation budget must be claimed ATOMICALLY across processes. A
// process-local hold only serializes callers inside one process: a second runner
// reads the same pre-creation count, both pass the cap check, both create
// external children, and the day overshoots with no way to undo the issues
// already in the tracker. (AGT-3468)

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type RunnerStateModule = typeof import('./runnerState.js');

let tempHome = '';
let mod: RunnerStateModule;

// Static imports cannot work here: the module reads its state-file paths at
// import time, and each test needs a fresh instance standing in for a separate
// process, so the specifier is re-imported after `vi.resetModules()`.
async function loadFreshModule() {
  vi.resetModules();
  tempHome = mkdtempSync(join(tmpdir(), 'openswarm-reserve-'));
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('USERPROFILE', tempHome);
  for (const v of ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'OPENSWARM_RUNNER_REJECTION_STATE_FILE',
    'OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE']) {
    vi.stubEnv(v, '');
  }
  mod = await import('./runnerState.js');
}

/** Slots the shared state file currently holds for in-flight decompositions. */
function reservationsOnDisk(module: RunnerStateModule): number {
  const raw = JSON.parse(readFileSync(module.DECOMPOSITION_STATE_FILE, 'utf8')) as {
    reservations?: Record<string, { count: number }>;
  };
  return Object.values(raw.reservations ?? {}).reduce((total, hold) => total + hold.count, 0);
}

describe('cross-process decomposition capacity reservation', () => {
  beforeEach(async () => {
    await loadFreshModule();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses a second reservation that the first process already spent', async () => {
    expect(mod.reserveDailyCreations(3, 5)).toBe(true);

    // Simulate the other process: a fresh module instance holding no in-memory
    // hold, reading the same durable state file.
    vi.resetModules();
    const other = await import('./runnerState.js');
    expect(other.reserveDailyCreations(3, 5)).toBe(false);
  });

  it('sees a release made by another process', async () => {
    expect(mod.reserveDailyCreations(5, 5)).toBe(true);
    // The hold is visible to a peer through the shared file, or a second runner
    // would read a free budget while the first is still spending it.
    expect(reservationsOnDisk(mod)).toBe(5);

    mod.releaseDailyReservation(5);
    // The release must be durable too, not just local: the next process reads
    // this file, not our memory.
    expect(reservationsOnDisk(mod)).toBe(0);

    vi.resetModules();
    const other = await import('./runnerState.js');
    expect(other.reserveDailyCreations(5, 5)).toBe(true);
  });

  it('does not leak capacity when creation fails after a reservation', async () => {
    // A failed creation must return the reservation, cross-process: the next
    // process (or the next attempt) has to be able to use the slots again.
    expect(mod.reserveDailyCreations(2, 5)).toBe(true);
    mod.releaseDailyReservation(2);
    expect(reservationsOnDisk(mod)).toBe(0);

    vi.resetModules();
    const other = await import('./runnerState.js');
    expect(other.getDailyCreationCount()).toBe(0);
    expect(other.reserveDailyCreations(2, 5)).toBe(true);
  });

  it('keeps the reservation out of the durable count it charges against', async () => {
    // Held slots must block the cap check without being persisted as spending —
    // a restart would otherwise read the inflation as real for the rest of the day.
    expect(mod.reserveDailyCreations(3, 5)).toBe(true);
    const raw = JSON.parse(readFileSync(mod.DECOMPOSITION_STATE_FILE, 'utf8'));
    expect(raw.dailyCreationCount).toBe(0);
  });

  it('cannot let two runners both pass the cap and both create beyond the limit', async () => {
    // The reported defect, end to end: each runner reads the count, passes the
    // check, creates its children externally, and only then registers. Both pass
    // on the pre-creation count, so the day overshoots with no way to undo the
    // issues already in the tracker. (AGT-3468)
    //
    // One slot left, two runners: exactly one may proceed.
    vi.resetModules();
    const runnerA = await import('./runnerState.js');
    vi.resetModules();
    const runnerB = await import('./runnerState.js');

    const admitted = [runnerA, runnerB].filter((runner) => runner.reserveDailyCreations(1, 1));
    expect(admitted).toHaveLength(1);

    // Only the admitted runner creates; the refused one creates nothing, so the
    // day ends at the cap rather than one past it.
    runnerA.registerDecomposition('parent-a', undefined, ['child-a']);

    vi.resetModules();
    const nextDay = await import('./runnerState.js');
    expect(nextDay.getDailyCreationCount()).toBe(1);
  });

  it('releases the reservation of a runner whose external creation failed', async () => {
    // Creation can fail outside this process — the tracker rejects, the pipeline
    // throws. That runner must give the slots back, or the day is short by a
    // budget nobody spent. (AGT-3468)
    vi.resetModules();
    const failing = await import('./runnerState.js');
    expect(failing.reserveDailyCreations(2, 2)).toBe(true);

    // The creation failed, so the runner releases the whole hold.
    failing.releaseDailyReservation(2);

    vi.resetModules();
    const retry = await import('./runnerState.js');
    expect(retry.getDailyCreationCount()).toBe(0);
    // A later attempt can now use the capacity that was never spent.
    expect(retry.reserveDailyCreations(2, 2)).toBe(true);
  });

  it('keeps a reservation that a live sibling process is still holding', async () => {
    // Only *provably gone* holders may be reclaimed. A live peer's hold — here a
    // second module instance in this pid space — is a promise it still owes.
    expect(mod.reserveDailyCreations(2, 2)).toBe(true);

    vi.resetModules();
    const sibling = await import('./runnerState.js');
    expect(sibling.reserveDailyCreations(1, 2)).toBe(false);
    expect(reservationsOnDisk(sibling)).toBe(2);
  });

  it('admits exactly one of two real concurrent runner processes', async () => {
    // The defect end to end, with two actual OS processes sharing one state
    // directory: each reads the pre-creation count, passes the cap check, and
    // creates its children externally, so the day overshoots with no way to undo
    // the issues already in the tracker. (AGT-3468)
    //
    // Each child prints its verdict as soon as it has one and only then lingers,
    // so the process that wins the race is still ALIVE — and therefore still
    // holding its slots — while the loser decides. Without the durable hold both
    // read zero held slots and both are granted.
    const fixture = fileURLToPath(new URL('./runnerState.reservation.fixture.ts', import.meta.url));
    const exits: Promise<void>[] = [];
    const spawn = () => new Promise<string>((resolve, reject) => {
      const child = childSpawn(
        process.execPath,
        ['--import', 'tsx', fixture, '1', '1', '2000'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      // Verdict first, exit later: waiting for the exit would let the winner
      // become a dead holder, which a peer may legitimately reclaim.
      child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
      exits.push(new Promise<void>((done, fail) => {
        child.on('exit', (code) => {
          if (code !== 0) fail(new Error(stderr || `child exited ${code}`));
          else done();
        });
      }));
    });

    const results = await Promise.all([spawn(), spawn()]);
    expect(results.filter((r) => r === '1')).toHaveLength(1);
    expect(results.filter((r) => r === '0')).toHaveLength(1);

    // No stray children left once the test is done.
    await Promise.all(exits);
  }, 30_000);

  it('reclaims a hold left by a dead predecessor that had our own pid', async () => {
    // Container pid numbering is deterministic: a restarted daemon routinely
    // inherits its predecessor's pid, so a plain liveness probe answers "alive"
    // against the wrong generation and the hold would block the budget all day.
    // (AGT-3468)
    expect(mod.reserveDailyCreations(2, 2)).toBe(true);
    const statePath = mod.DECOMPOSITION_STATE_FILE;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    // Re-key the hold the module just wrote — it carries this process's real pid
    // space — as a previous generation: our pid, written long before we started.
    // The module's own token is fresh per load, so the successor cannot mistake it
    // for its own hold.
    const [written] = Object.values(state.reservations) as Array<Record<string, unknown>>;
    state.reservations = {
      [`${process.pid}:a-previous-generation`]: {
        ...written,
        holderId: `${process.pid}:a-previous-generation`,
        pid: process.pid,
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    };
    writeFileSync(statePath, JSON.stringify(state));

    vi.resetModules();
    const successor = await import('./runnerState.js');
    expect(successor.reserveDailyCreations(2, 2)).toBe(true);
  });
});
