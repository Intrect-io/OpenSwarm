// ============================================
// OpenSwarm - schedule file update races
// ============================================
//
// The write to schedules.json was already atomic, but load → mutate → save was
// not. Several jobs finish near the same moment, and each read the file before
// the other wrote — so the last writer discarded the other's update. Losing a
// lastRun is cosmetic; losing an auto-pause leaves a failing job running on
// schedule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

/** Load the scheduler with ~/.openswarm pointed at a temp directory. */
async function loadScheduler() {
  vi.resetModules();
  const mockOs = async (importOriginal: () => Promise<typeof import('node:os')>) => {
    const actual = await importOriginal();
    return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
  };
  vi.doMock('node:os', mockOs);
  vi.doMock('os', mockOs);
  return await import('./scheduler.js');
}

const scheduleFile = () => join(home, '.openswarm', 'schedules.json');
const readSchedules = () => JSON.parse(readFileSync(scheduleFile(), 'utf-8')) as Array<Record<string, unknown>>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openswarm-sched-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.doUnmock('node:os');
  vi.doUnmock('os');
});

describe('concurrent schedule updates', () => {
  // Adds racing each other: without a lock both read the same file and the
  // second write drops the first job entirely.
  it('keeps every schedule when adds run concurrently', async () => {
    const { addSchedule } = await loadScheduler();

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        addSchedule(`job-${i}`, '/repo', 'do something', '30m'),
      ),
    );

    const names = readSchedules().map((s) => s.name).sort();
    expect(names).toEqual(['job-0', 'job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
  }, 30_000);

  // The clock is frozen deliberately. With the lock in place each add takes
  // more than a millisecond anyway, so a Date.now()-based id would look fine
  // here — the property worth pinning is that uniqueness does not depend on
  // clock resolution at all.
  it('gives each schedule a distinct id even when the clock does not move', async () => {
    const { addSchedule } = await loadScheduler();
    const frozen = 1_785_050_644_884;
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    try {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => addSchedule(`job-${i}`, '/repo', 'p', '30m')),
      );
    } finally {
      now.mockRestore();
    }

    const ids = readSchedules().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it('rejects a duplicate name even when both adds race', async () => {
    const { addSchedule } = await loadScheduler();

    const results = await Promise.allSettled([
      addSchedule('same', '/repo', 'p', '30m'),
      addSchedule('same', '/repo', 'p', '30m'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(readSchedules()).toHaveLength(1);
  }, 30_000);

  // A toggle and a remove touching different jobs must both survive.
  it('does not lose a toggle to a concurrent remove', async () => {
    const { addSchedule, toggleSchedule, removeSchedule } = await loadScheduler();
    await addSchedule('keeper', '/repo', 'p', '30m');
    await addSchedule('goner', '/repo', 'p', '30m');

    await Promise.all([toggleSchedule('keeper'), removeSchedule('goner')]);

    const rows = readSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'keeper', enabled: false });
  }, 30_000);

  it('leaves no temp files behind', async () => {
    const { addSchedule } = await loadScheduler();
    await Promise.all(Array.from({ length: 4 }, (_, i) => addSchedule(`j${i}`, '/repo', 'p', '30m')));

    const { readdirSync } = await import('node:fs');
    const stray = readdirSync(join(home, '.openswarm')).filter((f) => f.endsWith('.tmp'));
    expect(stray).toEqual([]);
  }, 30_000);
});
