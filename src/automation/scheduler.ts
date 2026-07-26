// ============================================
// OpenSwarm - Dynamic Scheduler
// Spawn-based execution (no tmux required)
// ============================================

import { Cron } from 'croner';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { checkWorkAllowed } from '../support/timeWindow.js';
import { extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { t, getDateLocale } from '../locale/index.js';
import { randomUUID } from 'crypto';
import { withFileLock } from '../support/fileLock.js';

// Schedule storage path
const SCHEDULE_DIR = resolve(homedir(), '.openswarm');
const SCHEDULE_FILE = resolve(SCHEDULE_DIR, 'schedules.json');
const SCHEDULE_LOCK_FILE = resolve(SCHEDULE_DIR, 'schedules.json.lock');

// Scheduled job interface
export interface ScheduledJob {
  id: string;
  name: string;
  projectPath: string;
  prompt: string;
  schedule: string; // cron expression or interval (e.g. "30m", "1h", "0 9 * * *")
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  createdBy?: string; // Discord user
  /** Consecutive failed runs; reset on success. Auto-paused at the threshold. (INT-1958) */
  consecutiveFailures?: number;
}

/** Consecutive failures before a schedule auto-pauses itself. (INT-1958) */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Pure: next failure state for a run. Success resets the counter; failures
 * increment and trigger auto-pause once the threshold is reached. (INT-1958)
 */
export function nextFailureState(
  current: number,
  success: boolean,
  threshold = MAX_CONSECUTIVE_FAILURES,
): { consecutiveFailures: number; autoPause: boolean } {
  if (success) return { consecutiveFailures: 0, autoPause: false };
  const consecutiveFailures = current + 1;
  return { consecutiveFailures, autoPause: consecutiveFailures >= threshold };
}

// Job result interface
export interface JobResult {
  jobId: string;
  success: boolean;
  output: string;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

// Active cron jobs
const activeJobs: Map<string, Cron> = new Map();

// Running processes (to prevent concurrent execution)
const runningProcesses: Map<string, ReturnType<typeof spawn>> = new Map();

/** Wall-clock ceiling for a scheduled claude job — a hang here would silently
 *  wedge the schedule (every later fire skipped "already running"). (INT-2521) */
const CRON_JOB_TIMEOUT_MS = 20 * 60_000;

// Recent results (for reporting)
const recentResults: JobResult[] = [];
const MAX_RESULTS = 50;
const MAX_CLI_BUFFER_CHARS = 128 * 1024;

// Result listener (Discord reporting, etc.)
type ResultListener = (result: JobResult) => void;
let resultListener: ResultListener | null = null;

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CLI_BUFFER_CHARS
    ? next.slice(next.length - MAX_CLI_BUFFER_CHARS)
    : next;
}

/**
 * Register result listener
 */
export function setResultListener(listener: ResultListener): void {
  resultListener = listener;
}

/**
 * Load schedule file
 */
async function loadSchedules(): Promise<ScheduledJob[]> {
  try {
    await fs.mkdir(SCHEDULE_DIR, { recursive: true });
    const data = await fs.readFile(SCHEDULE_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed) || !parsed.every(isScheduledJob)) {
      throw new Error('schedule file does not contain a valid schedule array');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Failed to load schedules from ${SCHEDULE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function isScheduledJob(value: unknown): value is ScheduledJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === 'string' && job.id.length > 0 &&
    typeof job.name === 'string' && job.name.length > 0 &&
    typeof job.projectPath === 'string' &&
    typeof job.prompt === 'string' &&
    typeof job.schedule === 'string' && job.schedule.length > 0 &&
    typeof job.enabled === 'boolean' &&
    typeof job.createdAt === 'number' && Number.isFinite(job.createdAt)
  );
}

/**
 * Save schedule file
 */
async function saveSchedules(schedules: ScheduledJob[]): Promise<void> {
  await fs.mkdir(SCHEDULE_DIR, { recursive: true });
  const tempFile = `${SCHEDULE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(schedules, null, 2), { mode: 0o600 });
  await fs.rename(tempFile, SCHEDULE_FILE);
}

/**
 * Read the schedule file, transform it and write it back, all under one lock.
 *
 * The write was already atomic, but load → mutate → save was not: two jobs
 * finishing near the same moment each read the file before the other wrote, so
 * one job's lastRun, consecutiveFailures and auto-pause were discarded by
 * whichever saved last. An auto-pause lost that way leaves a failing job
 * running on schedule.
 *
 * The callback receives the state as it is *inside* the lock, so callers must
 * not decide anything from a read taken before calling this. Returning a null
 * `next` skips the write, for the cases that decide there is nothing to do.
 */
async function mutateSchedules<T>(
  mutate: (schedules: ScheduledJob[]) => Promise<{ next: ScheduledJob[] | null; result: T }>,
): Promise<T> {
  return withFileLock(SCHEDULE_LOCK_FILE, async () => {
    const current = await loadSchedules();
    const { next, result } = await mutate(current);
    if (next) await saveSchedules(next);
    return result;
  });
}

/**
 * Convert interval string to cron expression
 */
function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return interval;

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  switch (unit) {
    case 'm':
      return `*/${num} * * * *`;
    case 'h':
      if (num === 1) return '0 * * * *';
      return `0 */${num} * * *`;
    case 'd':
      return `0 9 */${num} * *`;
    default:
      return interval;
  }
}

function validateScheduleExpression(schedule: string): string {
  const cronExpr = intervalToCron(schedule.trim());
  const probe = new Cron(cronExpr, { paused: true });
  probe.stop();
  return cronExpr;
}

/**
 * Run Claude CLI via spawn
 */
async function runClaudeCli(
  projectPath: string,
  prompt: string,
  jobId: string
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const expandedPath = projectPath.replace('~', homedir());

    // Invoke claude directly (no shell). `cwd` already handles the directory.
    console.log(`[Scheduler] Spawning Claude CLI for ${jobId}...`);
    const proc = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--max-turns',
        '15',
      ],
      {
        cwd: expandedPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    runningProcesses.set(jobId, proc);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: { success: boolean; output: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      runningProcesses.delete(jobId);
      resolve(r);
    };
    // Without this a hung `claude` never resolves → the job stays in
    // runningProcesses forever → every later fire is skipped "already running"
    // and the schedule is silently dead until restart. Kill + resolve as a
    // failure so the consecutive-failure auto-pause can engage. (INT-2521)
    const watchdog = setTimeout(() => {
      if (settled) return;
      console.warn(`[Scheduler] Job ${jobId} exceeded ${Math.round(CRON_JOB_TIMEOUT_MS / 60_000)}min — killing`);
      proc.kill('SIGKILL');
      finish({ success: false, output: '', error: `Job timed out after ${CRON_JOB_TIMEOUT_MS}ms` });
    }, CRON_JOB_TIMEOUT_MS);

    proc.stdout?.on('data', (data) => {
      stdout = appendBounded(stdout, data.toString());
    });

    proc.stderr?.on('data', (data) => {
      stderr = appendBounded(stderr, data.toString());
    });

    proc.on('close', (code) => {
      runningProcesses.delete(jobId);

      // Extract cost from stream-json output
      const costInfo = extractCostFromStreamJson(stdout);
      if (costInfo) {
        console.log(`[Scheduler] Job ${jobId} cost: ${formatCost(costInfo)}`);
      }

      // Extract result from stream-json output
      let resultText = stdout;
      try {
        const lines = stdout.split('\n').filter(Boolean);
        const resultLine = lines.find((l) => l.includes('"type":"result"'));
        if (resultLine) {
          const parsed = JSON.parse(resultLine);
          resultText = parsed.result || stdout;
        }
      } catch {
        // Use original on parse failure
      }

      finish({
        success: code === 0,
        output: resultText.slice(0, 2000), // max 2000 chars
        error: stderr || undefined,
      });
    });

    proc.on('error', (err) => {
      finish({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

/**
 * Run scheduled job
 */
async function runScheduledJob(
  job: ScheduledJob,
  opts: { bypassTimeWindow?: boolean } = {},
): Promise<boolean> {
  // Check time window
  if (!opts.bypassTimeWindow) {
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      console.log(
        `[Scheduler] Job "${job.name}" skipped: ${timeCheck.reason} (current: ${timeCheck.currentTime})`
      );
      return false;
    }
  }

  // Check if already running
  if (runningProcesses.has(job.id)) {
    console.log(`[Scheduler] Job "${job.name}" already running, skipping`);
    return false;
  }

  console.log(`[Scheduler] Running job: ${job.name}${opts.bypassTimeWindow ? ' (bypassing time window)' : ''}`);
  const startedAt = Date.now();

  try {
    const { success, output, error } = await runClaudeCli(
      job.projectPath,
      job.prompt,
      job.id
    );

    const result: JobResult = {
      jobId: job.id,
      success,
      output,
      error,
      startedAt,
      finishedAt: Date.now(),
    };

    // Save result
    recentResults.unshift(result);
    if (recentResults.length > MAX_RESULTS) {
      recentResults.pop();
    }

    // Notify listener
    if (resultListener) {
      resultListener(result);
    }

    // Update last run + consecutive-failure tracking; auto-pause on repeated failure.
    // Read and write under one lock: several jobs finish near the same moment,
    // and an unlocked read-modify-write let the last writer discard another
    // job's failure count — including an auto-pause, which would leave a
    // failing job running on schedule.
    const failureState = await mutateSchedules(async (schedules) => {
      const latest = schedules.find((schedule) => schedule.id === job.id);
      if (!latest) {
        console.log(`[Scheduler] Job "${job.name}" was removed while running; skipping state update`);
        return { next: null, result: null };
      }
      const state = nextFailureState(latest.consecutiveFailures ?? 0, success);
      const updated = schedules.map((s) =>
        s.id === job.id
          ? {
              ...s,
              lastRun: Date.now(),
              consecutiveFailures: state.consecutiveFailures,
              enabled: state.autoPause ? false : s.enabled,
            }
          : s
      );
      return { next: updated, result: state };
    });
    if (!failureState) return success;

    if (failureState.autoPause) {
      activeJobs.get(job.id)?.stop();
      activeJobs.delete(job.id);
      const msg = `[Scheduler] Job "${job.name}" auto-paused after ${failureState.consecutiveFailures} consecutive failures — fix it and re-enable with \`openswarm schedule pause ${job.name}\``;
      console.warn(msg);
      resultListener?.({ ...result, output: `${result.output}\n${msg}`.trim() });
    }

    console.log(
      `[Scheduler] Job ${job.name} ${success ? 'completed' : 'failed'} (${Math.round((result.finishedAt - startedAt) / 1000)}s)`
    );
    return success;
  } catch (err) {
    console.error(`[Scheduler] Job ${job.name} error:`, err);
    return false;
  }
}

/**
 * Add a scheduled job
 */
export async function addSchedule(
  name: string,
  projectPath: string,
  prompt: string,
  schedule: string,
  createdBy?: string
): Promise<ScheduledJob> {
  validateScheduleExpression(schedule);

  // The duplicate-name check and the append have to be one atomic step, or two
  // concurrent adds of the same name both see "no duplicate" and one is lost.
  const job = await mutateSchedules<ScheduledJob>(async (schedules) => {
    if (schedules.some((s) => s.name === name)) {
      throw new Error(`Schedule "${name}" already exists`);
    }
    const created: ScheduledJob = {
      // randomUUID, not Date.now(): ids are looked up by removeSchedule and
      // toggleSchedule, and two schedules added in the same millisecond would
      // otherwise share one.
      id: `job-${randomUUID()}`,
      name,
      projectPath,
      prompt,
      schedule,
      enabled: true,
      createdAt: Date.now(),
      createdBy,
    };
    return { next: [...schedules, created], result: created };
  });

  // Start cron job
  await startCronJob(job);

  console.log(`[Scheduler] Added schedule: ${name} (${schedule})`);
  return job;
}

/**
 * Remove a scheduled job
 */
export async function removeSchedule(nameOrId: string): Promise<boolean> {
  const job = await mutateSchedules<ScheduledJob | null>(async (schedules) => {
    const index = schedules.findIndex((s) => s.name === nameOrId || s.id === nameOrId);
    if (index === -1) return { next: null, result: null };
    const removed = schedules[index];
    return { next: schedules.filter((_, i) => i !== index), result: removed };
  });

  if (!job) return false;

  // Stop cron job
  const cron = activeJobs.get(job.id);
  if (cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  // Kill running process
  const proc = runningProcesses.get(job.id);
  if (proc) {
    proc.kill('SIGTERM');
    runningProcesses.delete(job.id);
  }

  console.log(`[Scheduler] Removed schedule: ${job.name}`);
  return true;
}

/**
 * Toggle schedule pause/resume
 */
export async function toggleSchedule(
  nameOrId: string
): Promise<ScheduledJob | null> {
  const job = await mutateSchedules<ScheduledJob | null>(async (schedules) => {
    const found = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);
    if (!found) return { next: null, result: null };
    const toggled = { ...found, enabled: !found.enabled };
    if (toggled.enabled) validateScheduleExpression(toggled.schedule);
    return {
      next: schedules.map((s) => (s.id === found.id ? toggled : s)),
      result: toggled,
    };
  });

  if (!job) return null;

  // Toggle cron job
  const cron = activeJobs.get(job.id);
  if (job.enabled && !cron) {
    await startCronJob(job);
  } else if (!job.enabled && cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  console.log(
    `[Scheduler] ${job.enabled ? 'Enabled' : 'Disabled'} schedule: ${job.name}`
  );
  return job;
}

/**
 * Start cron job
 */
async function startCronJob(job: ScheduledJob): Promise<void> {
  if (!job.enabled) return;

  const cronExpr = validateScheduleExpression(job.schedule);
  const existing = activeJobs.get(job.id);
  if (existing) {
    existing.stop();
    activeJobs.delete(job.id);
  }

  const cron = new Cron(cronExpr, () => {
    void runScheduledJob(job).catch((err) => {
      console.error(`[Scheduler] Job ${job.name} error:`, err);
    });
  });

  activeJobs.set(job.id, cron);
  console.log(`[Scheduler] Started cron for ${job.name}: ${cronExpr}`);
}

/**
 * Load and start all schedules
 */
export async function startAllSchedules(): Promise<void> {
  const schedules = await loadSchedules();
  console.log(`[Scheduler] Loading ${schedules.length} schedules...`);

  for (const job of schedules) {
    if (job.enabled) validateScheduleExpression(job.schedule);
  }

  for (const job of schedules) {
    if (job.enabled) {
      await startCronJob(job);
    }
  }
}

/**
 * Stop all schedules
 */
export function stopAllSchedules(): void {
  for (const [id, cron] of activeJobs) {
    cron.stop();
    console.log(`[Scheduler] Stopped cron: ${id}`);
  }
  activeJobs.clear();

  // Also kill running processes
  for (const [id, proc] of runningProcesses) {
    proc.kill('SIGTERM');
    console.log(`[Scheduler] Killed process: ${id}`);
  }
  runningProcesses.clear();
}

/**
 * List all schedules
 */
export async function listSchedules(): Promise<ScheduledJob[]> {
  return loadSchedules();
}

/**
 * Run immediately
 */
export async function runNow(
  nameOrId: string,
  bypassTimeWindow = false
): Promise<boolean> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return false;

  if (bypassTimeWindow) {
    return runScheduledJob(job, { bypassTimeWindow: true });
  }

  return runScheduledJob(job);
}

/**
 * Get recent results
 */
export function getRecentResults(limit = 10): JobResult[] {
  return recentResults.slice(0, limit);
}

/**
 * Get running jobs
 */
export function getRunningJobs(): string[] {
  return Array.from(runningProcesses.keys());
}

/**
 * Format schedule list
 */
export function formatScheduleList(schedules: ScheduledJob[]): string {
  if (schedules.length === 0) {
    return t('service.scheduler.noSchedules');
  }

  return schedules
    .map((s, i) => {
      const status = s.enabled ? '✅' : '⏸️';
      const lastRun = s.lastRun
        ? new Date(s.lastRun).toLocaleString(getDateLocale())
        : t('common.fallback.none');
      return `${i + 1}. ${status} **${s.name}**\n   📁 ${s.projectPath}\n   ⏰ ${s.schedule} | ${t('service.scheduler.lastRunLabel', { time: lastRun })}`;
    })
    .join('\n\n');
}

/**
 * Parse schedule info from natural language
 */
export function parseScheduleFromNaturalLanguage(
  text: string
): {
  name?: string;
  schedule?: string;
  projectPath?: string;
  prompt?: string;
} | null {
  const result: {
    name?: string;
    schedule?: string;
    projectPath?: string;
    prompt?: string;
  } = {};

  // Extract project name
  const nameMatch = text.match(/["']([^"']+)["']|^(\S+)/);
  if (nameMatch) {
    result.name = nameMatch[1] || nameMatch[2];
  }

  // Extract interval
  const intervalMatch = text.match(/(\d+)\s*(min|hour|h|m|d)/i);
  if (intervalMatch) {
    const [, num, unit] = intervalMatch;
    const unitMap: Record<string, string> = {
      min: 'm',
      m: 'm',
      hour: 'h',
      h: 'h',
      d: 'd',
    };
    result.schedule = `${num}${unitMap[unit.toLowerCase()] || 'm'}`;
  }

  // Daily/weekly etc.
  if (text.includes('daily')) {
    result.schedule = '0 9 * * *';
  }
  if (text.includes('weekly')) {
    result.schedule = '0 9 * * 1';
  }

  return Object.keys(result).length > 0 ? result : null;
}
