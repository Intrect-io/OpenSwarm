// ============================================
// OpenSwarm - Scheduler Coverage Tests
// ============================================
//
// Companion to scheduler.test.ts (the pure `nextFailureState` helper) and
// scheduler.runNow.test.ts (bypass-execution smoke tests). This file targets
// the branches those two don't reach: the private runClaudeCli result
// mapping / deadline / failure handling, removeSchedule /
// toggleSchedule / startAllSchedules / stopAllSchedules, the auto-pause
// path, the time-window-blocked path, invalid cron expressions, the
// intervalToCron shorthand conversion, and the two pure formatting helpers
// (formatScheduleList, parseScheduleFromNaturalLanguage).
//
// Same mocking convention as scheduler.runNow.test.ts: `os.homedir` and
// `runClaudeTask` are mocked so nothing here touches the real
// `~/.openswarm/schedules.json` or spawns a real `claude` process. Process
// teardown and the wall-clock deadline themselves belong to spawnCli and are
// covered in src/adapters/base.spawn.test.ts.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDateLocale, t } from '../locale/index.js';
import { getTimeWindowConfig, setTimeWindowConfig } from '../support/timeWindow.js';

const testHome = vi.hoisted(() => ({
  path: `/tmp/openswarm-scheduler-coverage-${process.pid}`,
}));

const fake = vi.hoisted(() => {
  type Result = { success: boolean; stdout: string; resultText: string; error?: string };
  type Run = {
    options: { prompt: string; cwd: string; timeoutMs: number; maxTurns?: number; signal?: AbortSignal };
    close: (code: number, extra?: Partial<Result>) => void;
  };
  return { runs: [] as Run[] };
});

const runClaudeTaskMock = vi.hoisted(() => vi.fn());

vi.mock('os', () => ({
  homedir: () => testHome.path,
}));

vi.mock('../adapters/claudeTask.js', () => ({
  runClaudeTask: runClaudeTaskMock,
}));

import {
  addSchedule,
  formatScheduleList,
  getRecentResults,
  getRunningJobs,
  listSchedules,
  MAX_CONSECUTIVE_FAILURES,
  parseScheduleFromNaturalLanguage,
  removeSchedule,
  runNow,
  setResultListener,
  startAllSchedules,
  stopAllSchedules,
  toggleSchedule,
  type ScheduledJob,
} from './scheduler.js';

type FakeRun = (typeof fake.runs)[number];

/** A run that stays in flight until the test closes it. */
function queuePendingRun(): void {
  runClaudeTaskMock.mockImplementationOnce((options: FakeRun['options']) => new Promise((resolve) => {
    fake.runs.push({
      options,
      close: (code, extra = {}) => resolve({ success: code === 0, stdout: '', resultText: '', ...extra }),
    });
  }));
}

/** Queue a run that finishes with the given exit status on the next microtask. */
function queueSpawnClosingWith(code: number, extra: Record<string, unknown> = {}): void {
  runClaudeTaskMock.mockImplementationOnce(async (options: FakeRun['options']) => {
    fake.runs.push({ options, close: () => {} });
    return { success: code === 0, stdout: '', resultText: '', ...extra };
  });
}

describe('scheduler coverage', () => {
  let savedTimeWindowConfig: ReturnType<typeof getTimeWindowConfig>;

  beforeEach(async () => {
    stopAllSchedules();
    fake.runs = [];
    runClaudeTaskMock.mockReset();
    await rm(testHome.path, { recursive: true, force: true });
    savedTimeWindowConfig = getTimeWindowConfig();
    setResultListener(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setTimeWindowConfig(savedTimeWindowConfig);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================
  // Pure helpers: formatScheduleList
  // ==========================================================

  describe('formatScheduleList', () => {
    it('reports no schedules when the list is empty', () => {
      expect(formatScheduleList([])).toBe(t('service.scheduler.noSchedules'));
    });

    it('formats enabled and disabled jobs with distinct status glyphs and last-run labels', () => {
      const enabledJob: ScheduledJob = {
        id: 'job-1',
        name: 'nightly-build',
        projectPath: '~/dev/app',
        prompt: 'run build',
        schedule: '0 3 * * *',
        enabled: true,
        createdAt: 1720000000000,
      };
      const disabledJob: ScheduledJob = {
        id: 'job-2',
        name: 'paused-job',
        projectPath: '~/dev/other',
        prompt: 'run tests',
        schedule: '0 4 * * *',
        enabled: false,
        createdAt: 1720000000000,
        lastRun: 1720000500000,
      };

      const output = formatScheduleList([enabledJob, disabledJob]);
      const entries = output.split('\n\n');

      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('✅');
      expect(entries[0]).toContain('nightly-build');
      expect(entries[0]).toContain(t('common.fallback.none'));
      expect(entries[1]).toContain('⏸️');
      expect(entries[1]).toContain('paused-job');
      expect(entries[1]).toContain(new Date(disabledJob.lastRun!).toLocaleString(getDateLocale()));
    });
  });

  // ==========================================================
  // Pure helpers: parseScheduleFromNaturalLanguage
  // ==========================================================

  describe('parseScheduleFromNaturalLanguage', () => {
    it('returns null when nothing can be extracted', () => {
      expect(parseScheduleFromNaturalLanguage('')).toBeNull();
    });

    it('extracts a quoted name and a minute interval', () => {
      expect(parseScheduleFromNaturalLanguage('"nightly build" every 30 min')).toEqual({
        name: 'nightly build',
        schedule: '30m',
      });
    });

    it('extracts an unquoted first token as the name', () => {
      const result = parseScheduleFromNaturalLanguage('nightly run every 2h');
      expect(result?.name).toBe('nightly');
      expect(result?.schedule).toBe('2h');
    });

    it('maps the "hour" and "h" unit spellings to the h suffix', () => {
      expect(parseScheduleFromNaturalLanguage('job every 1 hour')?.schedule).toBe('1h');
      expect(parseScheduleFromNaturalLanguage('job every 4h')?.schedule).toBe('4h');
    });

    it('keeps the d unit as-is', () => {
      expect(parseScheduleFromNaturalLanguage('job every 3d')?.schedule).toBe('3d');
    });

    it('overrides the schedule with a fixed daily cron expression', () => {
      expect(parseScheduleFromNaturalLanguage('job daily')?.schedule).toBe('0 9 * * *');
    });

    it('overrides the schedule with a fixed weekly cron expression', () => {
      expect(parseScheduleFromNaturalLanguage('job weekly')?.schedule).toBe('0 9 * * 1');
    });
  });

  // ==========================================================
  // intervalToCron (private) — exercised indirectly via addSchedule,
  // observed through the "Started cron for ..." log line.
  // ==========================================================

  describe('interval shorthand conversion (via addSchedule)', () => {
    it.each([
      ['5m', '*/5 * * * *'],
      ['1h', '0 * * * *'],
      ['3h', '0 */3 * * *'],
      ['2d', '0 9 */2 * *'],
    ])('converts "%s" into the cron expression "%s"', async (interval, expectedCron) => {
      const job = await addSchedule(`interval-${interval}`, testHome.path, 'do work', interval);

      expect(job.schedule).toBe(interval); // stored verbatim; conversion happens only when the cron starts
      expect(
        vi
          .mocked(console.log)
          .mock.calls.some(
            ([msg]) => typeof msg === 'string' && msg.includes(`Started cron for ${job.name}: ${expectedCron}`),
          ),
      ).toBe(true);
    });

    it('rejects an invalid cron expression before persisting it', async () => {
      await expect(
        addSchedule('bad-cron-job', testHome.path, 'do work', 'not a valid cron at all'),
      ).rejects.toThrow();

      expect((await listSchedules()).find((s) => s.name === 'bad-cron-job')).toBeUndefined();
    });
  });

  it('fails visibly when the persisted schedule file is corrupt', async () => {
    const scheduleDir = `${testHome.path}/.openswarm`;
    await mkdir(scheduleDir, { recursive: true });
    await writeFile(`${scheduleDir}/schedules.json`, '{not-json');

    await expect(listSchedules()).rejects.toThrow('Failed to load schedules');
  });

  // ==========================================================
  // addSchedule — duplicate name guard
  // ==========================================================

  it('rejects adding a schedule whose name already exists', async () => {
    await addSchedule('dup-job', testHome.path, 'do work', '0 3 * * *');
    await expect(addSchedule('dup-job', testHome.path, 'do work', '0 4 * * *')).rejects.toThrow(
      'already exists',
    );
  });

  // ==========================================================
  // runClaudeCli (private) — exercised via runNow/runScheduledJob.
  // ==========================================================

  describe('claude CLI process handling', () => {
    it('logs the cost and keeps the parsed result text from the stream-json result event', async () => {
      queueSpawnClosingWith(0, {
        stdout: `${JSON.stringify({
          type: 'result',
          result: 'Build succeeded.',
          total_cost_usd: 0.031,
          usage: { input_tokens: 120, output_tokens: 40 },
        })}\n`,
        resultText: 'Build succeeded.',
      });

      await addSchedule('cost-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('cost-job', true)).resolves.toBe(true);

      const result = getRecentResults(1)[0];
      expect(result.output).toBe('Build succeeded.');
      expect(
        vi.mocked(console.log).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('cost:')),
      ).toBe(true);
    });

    it('runs through runClaudeTask with the job deadline, a turn cap, and an abort signal', async () => {
      queueSpawnClosingWith(0);
      await addSchedule('opts-job', testHome.path, 'do work', '0 3 * * *');
      await runNow('opts-job', true);

      const { options } = fake.runs[0];
      expect(options.prompt).toBe('do work');
      expect(options.cwd).toBe(testHome.path);
      expect(options.timeoutMs).toBe(20 * 60_000); // mirrors CRON_JOB_TIMEOUT_MS
      expect(options.maxTurns).toBe(15);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('resolves as a failure and surfaces the error when the run fails', async () => {
      queueSpawnClosingWith(1, { error: 'claude CLI failed with code 1: ENOENT' });

      await addSchedule('spawn-error-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('spawn-error-job', true)).resolves.toBe(false);

      const result = getRecentResults(1)[0];
      expect(result.success).toBe(false);
      expect(result.error).toBe('claude CLI failed with code 1: ENOENT');
      expect(result.output).toBe('');
    });

    it('fails the job and frees the slot when the run hits its deadline', async () => {
      queueSpawnClosingWith(1, { error: 'claude timeout after 1200000ms' });

      await addSchedule('hung-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('hung-job', true)).resolves.toBe(false);

      expect(getRecentResults(1)[0].error).toContain('timeout');
      expect(getRunningJobs()).toHaveLength(0);
    });

    it('caps the output it stores at 2000 characters', async () => {
      queueSpawnClosingWith(0, { resultText: 'x'.repeat(5000) });
      await addSchedule('long-output-job', testHome.path, 'do work', '0 3 * * *');
      await runNow('long-output-job', true);
      expect(getRecentResults(1)[0].output).toHaveLength(2000);
    });
  });

  // ==========================================================
  // runScheduledJob — time window, listener, and auto-pause branches.
  // ==========================================================

  describe('runScheduledJob', () => {
    it('skips the run and returns false when the time window blocks work (default runNow path)', async () => {
      setTimeWindowConfig({
        enabled: true,
        restrictedDays: [], // empty (not just falsy) — the blockedWindows check always applies
        blockedWindows: [{ start: '00:00', end: '23:59' }],
        allowedWindows: [],
      });

      await addSchedule('blocked-job', testHome.path, 'do work', '0 3 * * *');
      // No bypass argument here — exercises runNow's default (non-bypass) path.
      await expect(runNow('blocked-job')).resolves.toBe(false);

      expect(runClaudeTaskMock).not.toHaveBeenCalled();
    });

    it('notifies the registered result listener on completion', async () => {
      const listener = vi.fn();
      setResultListener(listener);
      queueSpawnClosingWith(0);

      await addSchedule('listener-job', testHome.path, 'do work', '0 3 * * *');
      await runNow('listener-job', true);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toMatchObject({ success: true });
    });

    it('treats a throwing result listener as a failed run without crashing the scheduler', async () => {
      setResultListener(() => {
        throw new Error('listener boom');
      });
      queueSpawnClosingWith(0);

      await addSchedule('throwing-listener-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('throwing-listener-job', true)).resolves.toBe(false);

      expect(
        vi
          .mocked(console.error)
          .mock.calls.some(([, err]) => err instanceof Error && err.message === 'listener boom'),
      ).toBe(true);
    });

    it('auto-pauses the schedule after MAX_CONSECUTIVE_FAILURES consecutive failures', async () => {
      await addSchedule('flaky-job', testHome.path, 'do work', '0 3 * * *');

      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
        queueSpawnClosingWith(1); // non-zero exit code == failure
        await runNow('flaky-job', true);
      }

      const [job] = await listSchedules();
      expect(job.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
      expect(job.enabled).toBe(false);
      expect(
        vi.mocked(console.warn).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('auto-paused')),
      ).toBe(true);
    });

    it('merges a completed run with the latest persisted failure counter', async () => {
      const job = await addSchedule('concurrent-state-job', testHome.path, 'do work', '0 3 * * *');
      queuePendingRun();
      const pending = runNow(job.id, true);
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

      const scheduleFile = `${testHome.path}/.openswarm/schedules.json`;
      const latest = await listSchedules();
      latest[0].consecutiveFailures = 1;
      await writeFile(scheduleFile, JSON.stringify(latest));
      fake.runs[0].close(1);
      await pending;

      expect((await listSchedules())[0].consecutiveFailures).toBe(2);
    });

    it('caps recent results at MAX_RESULTS by evicting the oldest entry', async () => {
      await addSchedule('bulk-job', testHome.path, 'do work', '0 3 * * *');

      for (let i = 0; i < 51; i += 1) {
        queueSpawnClosingWith(0);
        await runNow('bulk-job', true);
      }

      expect(getRecentResults(100)).toHaveLength(50);
    });
  });

  // ==========================================================
  // removeSchedule
  // ==========================================================

  describe('removeSchedule', () => {
    it('returns false for an unknown name or id', async () => {
      await expect(removeSchedule('does-not-exist')).resolves.toBe(false);
    });

    it('stops the active cron and deletes the schedule', async () => {
      await addSchedule('removable-job', testHome.path, 'do work', '0 3 * * *');
      await expect(removeSchedule('removable-job')).resolves.toBe(true);
      expect(await listSchedules()).toHaveLength(0);
      // A second removal on the now-missing job is a no-op.
      await expect(removeSchedule('removable-job')).resolves.toBe(false);
    });

    it('kills a still-running process when the schedule is removed mid-run', async () => {
      queuePendingRun(); // an in-flight run
      await addSchedule('mid-run-job', testHome.path, 'do work', '0 3 * * *');

      const pending = runNow('mid-run-job', true);
      for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(getRunningJobs()).toHaveLength(1);

      await expect(removeSchedule('mid-run-job')).resolves.toBe(true);
      const run = fake.runs[0];
      expect(run.options.signal?.aborted).toBe(true);

      // Let the in-flight run settle so no dangling promise leaks into later tests.
      run.close(0);
      await pending;
    });
  });

  // ==========================================================
  // toggleSchedule
  // ==========================================================

  describe('toggleSchedule', () => {
    it('returns null for an unknown name or id', async () => {
      await expect(toggleSchedule('does-not-exist')).resolves.toBeNull();
    });

    it('disables an enabled schedule and stops its cron', async () => {
      await addSchedule('togglable-job', testHome.path, 'do work', '0 3 * * *');
      const toggled = await toggleSchedule('togglable-job');

      expect(toggled?.enabled).toBe(false);
      expect((await listSchedules())[0].enabled).toBe(false);
    });

    it('re-enables a disabled schedule and restarts its cron', async () => {
      await addSchedule('re-enable-job', testHome.path, 'do work', '0 3 * * *');
      await toggleSchedule('re-enable-job'); // disable
      const toggled = await toggleSchedule('re-enable-job'); // re-enable

      expect(toggled?.enabled).toBe(true);
      expect((await listSchedules())[0].enabled).toBe(true);
    });
  });

  // ==========================================================
  // startAllSchedules / stopAllSchedules
  // ==========================================================

  it('starts a cron for every schedule on disk and logs the count, regardless of enabled state', async () => {
    await addSchedule('startall-enabled', testHome.path, 'do work', '0 3 * * *');
    await addSchedule('startall-disabled', testHome.path, 'do work', '0 4 * * *');
    await toggleSchedule('startall-disabled'); // persist enabled:false
    stopAllSchedules(); // clear in-memory cron state, keep the schedule file

    await startAllSchedules();

    expect(
      vi.mocked(console.log).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Loading 2 schedules')),
    ).toBe(true);
  });

  it('can start all schedules repeatedly without retaining duplicate cron jobs', async () => {
    await addSchedule('idempotent-start', testHome.path, 'do work', '0 3 * * *');

    await startAllSchedules();
    await startAllSchedules();

    expect(
      vi.mocked(console.log).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('Started cron for idempotent-start'),
      ),
    ).toHaveLength(3);
  });

  it('kills a running process when stopping all schedules', async () => {
    queuePendingRun(); // never closes on its own
    await addSchedule('stopall-job', testHome.path, 'do work', '0 3 * * *');

    const pending = runNow('stopall-job', true);
    for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(getRunningJobs()).toHaveLength(1);

    stopAllSchedules();

    expect(getRunningJobs()).toHaveLength(0);
    const run = fake.runs[fake.runs.length - 1];
    expect(run.options.signal?.aborted).toBe(true);

    run.close(0);
    await pending;
  });
});
