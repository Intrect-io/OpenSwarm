// ============================================
// OpenSwarm - Daily Status Report Scheduler
// Consolidates Linear Status Updates to once daily at 6 PM
// ============================================

import { Cron } from 'croner';
import { LinearClient, type Project } from '@linear/sdk';
import { postStatusUpdate } from '../linear/index.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

let cronJob: Cron | null = null;
let linearClient: LinearClient | null = null;
let discordReporter: ((content: any) => Promise<void>) | null = null;
let teamId: string | null = null;
let reportInFlight: Promise<void> | null = null;
// Project path mapping (projectId → projectPath) for knowledge graph metrics
let projectPathMapping = new Map<string, string>();

// Watermark file — records which projects have had their status update
// published for a given day. It is only ever written after a publish actually
// happened, so a crash or an outright generation failure leaves the previous
// record intact. `complete` flips to true once every active project has been
// published; only then does a later run of the same day skip outright.
const WATERMARK_FILE = join(homedir(), '.openswarm', 'daily-reporter-watermark.json');

interface DailyWatermark {
  /** Day (UTC, YYYY-MM-DD) this record describes. */
  date: string;
  /** Project ids whose status update was already published for `date`. */
  publishedProjectIds: string[];
  /** True once every active project was published for `date`. */
  complete: boolean;
}

function readWatermark(): DailyWatermark | null {
  try {
    if (!existsSync(WATERMARK_FILE)) return null;
    const parsed = JSON.parse(readFileSync(WATERMARK_FILE, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'date' in parsed &&
      typeof parsed.date === 'string'
    ) {
      const ids = 'publishedProjectIds' in parsed ? parsed.publishedProjectIds : undefined;
      return {
        date: parsed.date,
        publishedProjectIds: Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === 'string')
          : [],
        // Records written before per-project progress existed only ever landed
        // after a fully successful day, so a missing flag still means complete.
        complete: !('complete' in parsed) || parsed.complete === true,
      };
    }
  } catch {
    // A corrupt watermark must never suppress a report.
  }
  return null;
}

function writeWatermark(date: string, publishedProjectIds: string[], complete: boolean): void {
  const dir = dirname(WATERMARK_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic: write to temp then rename so a crash never corrupts the watermark.
  const tmp = WATERMARK_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ date, publishedProjectIds, complete }), 'utf8');
  renameSync(tmp, WATERMARK_FILE);
}

export interface DailyReporterConfig {
  schedule: string; // Cron expression (default: "0 18 * * *" for 6 PM daily)
  enabled: boolean;
}

export function setLinearClient(client: LinearClient): void {
  linearClient = client;
}

export function setDailyReporterDiscord(reporter: (content: any) => Promise<void>): void {
  discordReporter = reporter;
}

export function setTeamId(id: string): void {
  teamId = id;
}

/**
 * Set project path mapping for knowledge graph metrics
 * Called by autonomousRunner when project paths are resolved
 */
export function registerProjectPath(projectId: string, projectPath: string): void {
  projectPathMapping.set(projectId, projectPath);
}

/**
 * Start the daily reporter cron job
 */
export function startDailyReporter(config: DailyReporterConfig): void {
  if (!config.enabled) {
    console.log('[DailyReporter] Disabled by config');
    return;
  }

  if (cronJob) {
    console.warn('[DailyReporter] Already running, stopping first');
    stopDailyReporter();
  }

  const schedule = config.schedule || '0 18 * * *';
  console.log(`[DailyReporter] Starting with schedule: ${schedule}`);

  cronJob = new Cron(schedule, async () => {
    if (reportInFlight) {
      console.log('[DailyReporter] Previous report still in progress, skipping');
      return;
    }
    reportInFlight = generateDailyReports();
    try {
      await reportInFlight;
    } finally {
      reportInFlight = null;
    }
  });

  console.log('[DailyReporter] Cron job started');
}

/**
 * Stop the daily reporter cron job
 */
export function stopDailyReporter(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[DailyReporter] Stopped');
  }
}

/**
 * Generate daily status reports for all active projects
 * Per-project progress is persisted as each update is published, so a retry
 * republishes only the projects that failed; the day is marked complete once
 * every project succeeded.
 */
export async function generateDailyReports(): Promise<void> {
  if (!linearClient) {
    console.warn('[DailyReporter] LinearClient not set, skipping reports');
    return;
  }

  if (!teamId) {
    console.warn('[DailyReporter] Team ID not set, skipping reports');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const watermark = readWatermark();
  if (watermark?.date === today && watermark.complete) {
    console.log(`[DailyReporter] Reports already completed for ${today}, skipping`);
    return;
  }
  // Publications already durably recorded for today — a retry must not
  // republish a project whose status update already landed in Linear.
  const alreadyPublished =
    watermark?.date === today ? new Set(watermark.publishedProjectIds) : new Set<string>();

  console.log('[DailyReporter] Generating daily reports...');

  try {
    // Fetch all active projects from Linear
    const team = await linearClient.team(teamId);
    if (!team) {
      console.warn('[DailyReporter] Team not found');
      return;
    }

    const activeProjects: Project[] = [];
    let after: string | undefined;
    do {
      const projects = await team.projects({ first: 50, after });
      activeProjects.push(...projects.nodes.filter(p => p.state !== 'canceled'));
      after = projects.pageInfo.hasNextPage ? projects.pageInfo.endCursor ?? undefined : undefined;
    } while (after);

    if (activeProjects.length === 0) {
      console.log('[DailyReporter] No active projects found');
      return;
    }

    console.log(`[DailyReporter] Found ${activeProjects.length} active projects`);

    // Generate status update for each project
    let successCount = 0;
    let failCount = 0;
    const publishedProjectIds = new Set(alreadyPublished);

    for (const project of activeProjects) {
      if (alreadyPublished.has(project.id)) {
        console.log(`[DailyReporter] Skipping "${project.name}" — already published for ${today}`);
        continue;
      }
      const projectPath = projectPathMapping.get(project.id);
      try {
        await postStatusUpdate(project.id, project.name, projectPath);
      } catch (err) {
        console.error(`[DailyReporter] Failed to post update for "${project.name}":`, err);
        failCount++;
        continue;
      }
      successCount++;
      // Record the publication immediately: if a later project fails, the
      // retry skips this one instead of posting a duplicate Linear update.
      // A persistence error here is not a publish failure — it escapes to the
      // outer handler so the run stops instead of publishing unrecorded work.
      publishedProjectIds.add(project.id);
      writeWatermark(today, [...publishedProjectIds], false);
    }

    console.log(
      `[DailyReporter] Reports completed: ${successCount} success, ${failCount} failed` +
        (alreadyPublished.size > 0 ? `, ${alreadyPublished.size} already published` : ''),
    );

    // Only mark the day complete when EVERY project has been published.
    // If any failed, the record keeps the projects that succeeded so the next
    // run retries only the failed ones instead of republishing all of them.
    if (failCount === 0) {
      writeWatermark(today, [...publishedProjectIds], true);
      console.log(`[DailyReporter] Watermark persisted: ${today}`);
    } else {
      console.warn(`[DailyReporter] ${failCount} report(s) failed — watermark NOT completed`);
    }

    // Send summary to Discord
    if (discordReporter && successCount > 0) {
      await sendDiscordSummary(activeProjects.length, successCount, failCount);
    }
  } catch (error) {
    console.error('[DailyReporter] Failed to generate reports:', error);
    // Watermark NOT persisted on exception — retry next window.
  }
}

/**
 * Send daily report summary to Discord
 */
async function sendDiscordSummary(
  totalProjects: number,
  successCount: number,
  failCount: number,
): Promise<void> {
  if (!discordReporter) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const message = `📊 **Daily Status Reports Generated** (${dateStr})\n\n` +
    `✅ Projects updated: ${successCount}/${totalProjects}\n` +
    (failCount > 0 ? `❌ Failed: ${failCount}\n` : '') +
    `\nAll project Status Updates have been posted to Linear.`;

  try {
    await discordReporter(message);
    console.log('[DailyReporter] Discord summary sent');
  } catch (err) {
    console.error('[DailyReporter] Failed to send Discord summary:', err);
  }
}
