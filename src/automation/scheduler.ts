// ============================================
// Claude Swarm - Dynamic Scheduler
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

// Schedule storage path
const SCHEDULE_DIR = resolve(homedir(), '.claude-swarm');
const SCHEDULE_FILE = resolve(SCHEDULE_DIR, 'schedules.json');

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

// Recent results (for reporting)
const recentResults: JobResult[] = [];
const MAX_RESULTS = 50;

// Result listener (Discord reporting, etc.)
type ResultListener = (result: JobResult) => void;
let resultListener: ResultListener | null = null;

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
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Save schedule file
 */
async function saveSchedules(schedules: ScheduledJob[]): Promise<void> {
  await fs.mkdir(SCHEDULE_DIR, { recursive: true });
  await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
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

    // Save prompt to file
    const promptFile = `${SCHEDULE_DIR}/prompt-${jobId}.txt`;
    fs.writeFile(promptFile, prompt).then(() => {
      const cmd = 'bash';
      const args = [
        '-c',
        `cd "${expandedPath}" && claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions`,
      ];

      console.log(`[Scheduler] Spawning Claude CLI for ${jobId}...`);
      const proc = spawn(cmd, args, {
        cwd: expandedPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runningProcesses.set(jobId, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
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

        resolve({
          success: code === 0,
          output: resultText.slice(0, 2000), // max 2000 chars
          error: stderr || undefined,
        });
      });

      proc.on('error', (err) => {
        runningProcesses.delete(jobId);
        resolve({
          success: false,
          output: '',
          error: err.message,
        });
      });
    });
  });
}

/**
 * Run scheduled job
 */
async function runScheduledJob(job: ScheduledJob): Promise<void> {
  // Check time window
  const timeCheck = checkWorkAllowed();
  if (!timeCheck.allowed) {
    console.log(
      `[Scheduler] Job "${job.name}" skipped: ${timeCheck.reason} (current: ${timeCheck.currentTime})`
    );
    return;
  }

  // Check if already running
  if (runningProcesses.has(job.id)) {
    console.log(`[Scheduler] Job "${job.name}" already running, skipping`);
    return;
  }

  console.log(`[Scheduler] Running job: ${job.name}`);
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

    // Update last run time
    const schedules = await loadSchedules();
    const updated = schedules.map((s) =>
      s.id === job.id ? { ...s, lastRun: Date.now() } : s
    );
    await saveSchedules(updated);

    console.log(
      `[Scheduler] Job ${job.name} ${success ? 'completed' : 'failed'} (${Math.round((result.finishedAt - startedAt) / 1000)}s)`
    );
  } catch (err) {
    console.error(`[Scheduler] Job ${job.name} error:`, err);
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
  const schedules = await loadSchedules();

  // Check for duplicates
  const existing = schedules.find((s) => s.name === name);
  if (existing) {
    throw new Error(`Schedule "${name}" already exists`);
  }

  const job: ScheduledJob = {
    id: `job-${Date.now()}`,
    name,
    projectPath,
    prompt,
    schedule,
    enabled: true,
    createdAt: Date.now(),
    createdBy,
  };

  schedules.push(job);
  await saveSchedules(schedules);

  // Start cron job
  await startCronJob(job);

  console.log(`[Scheduler] Added schedule: ${name} (${schedule})`);
  return job;
}

/**
 * Remove a scheduled job
 */
export async function removeSchedule(nameOrId: string): Promise<boolean> {
  const schedules = await loadSchedules();
  const index = schedules.findIndex(
    (s) => s.name === nameOrId || s.id === nameOrId
  );

  if (index === -1) return false;

  const job = schedules[index];

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

  // Save
  schedules.splice(index, 1);
  await saveSchedules(schedules);

  console.log(`[Scheduler] Removed schedule: ${job.name}`);
  return true;
}

/**
 * Toggle schedule pause/resume
 */
export async function toggleSchedule(
  nameOrId: string
): Promise<ScheduledJob | null> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return null;

  job.enabled = !job.enabled;
  await saveSchedules(schedules);

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

  const cronExpr = intervalToCron(job.schedule);

  try {
    const cron = new Cron(cronExpr, () => {
      void runScheduledJob(job).catch((err) => {
        console.error(`[Scheduler] Job ${job.name} error:`, err);
      });
    });

    activeJobs.set(job.id, cron);
    console.log(`[Scheduler] Started cron for ${job.name}: ${cronExpr}`);
  } catch (err) {
    console.error(`[Scheduler] Failed to start cron for ${job.name}:`, err);
  }
}

/**
 * Load and start all schedules
 */
export async function startAllSchedules(): Promise<void> {
  const schedules = await loadSchedules();
  console.log(`[Scheduler] Loading ${schedules.length} schedules...`);

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
    console.log(`[Scheduler] Running job: ${job.name} (bypassing time window)`);
    const { success } = await runClaudeCli(job.projectPath, job.prompt, job.id);

    const updatedSchedules = await loadSchedules();
    const updated = updatedSchedules.map((s) =>
      s.id === job.id ? { ...s, lastRun: Date.now() } : s
    );
    await saveSchedules(updated);
    return success;
  }

  await runScheduledJob(job);
  return true;
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
  const intervalMatch = text.match(/(\d+)\s*(분|시간|일|min|hour|h|m|d)/i);
  if (intervalMatch) {
    const [, num, unit] = intervalMatch;
    const unitMap: Record<string, string> = {
      분: 'm',
      min: 'm',
      m: 'm',
      시간: 'h',
      hour: 'h',
      h: 'h',
      일: 'd',
      d: 'd',
    };
    result.schedule = `${num}${unitMap[unit.toLowerCase()] || 'm'}`;
  }

  // Daily/weekly etc.
  if (text.includes('매일') || text.includes('daily')) {
    result.schedule = '0 9 * * *';
  }
  if (text.includes('매주') || text.includes('weekly')) {
    result.schedule = '0 9 * * 1';
  }

  return Object.keys(result).length > 0 ? result : null;
}
