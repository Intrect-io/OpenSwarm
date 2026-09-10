// ============================================
// OpenSwarm - Daily Status Report Scheduler
// Consolidates Linear Status Updates to once daily at 6 PM
// ============================================

import { Cron } from 'croner';
import { LinearClient, type Project } from '@linear/sdk';
import { postStatusUpdate } from '../linear/index.js';

let cronJob: Cron | null = null;
let linearClient: LinearClient | null = null;
let discordReporter: ((content: any) => Promise<void>) | null = null;
let teamId: string | null = null;
let reportInFlight: Promise<void> | null = null;
// Project path mapping (projectId → projectPath) for knowledge graph metrics
let projectPathMapping = new Map<string, string>();

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
 * Start daily reporter
 */
export function startDailyReporter(config: DailyReporterConfig): void {
  if (!config.enabled) {
    console.log('[DailyReporter] Disabled by config');
    return;
  }

  if (cronJob) {
    console.log('[DailyReporter] Already running');
    return;
  }

  const schedule = config.schedule || '0 18 * * *';
  console.log(`[DailyReporter] Starting with schedule: ${schedule}`);

  cronJob = new Cron(schedule, async () => {
    if (reportInFlight) {
      console.log('[DailyReporter] Previous report still in progress — skipping');
      return;
    }
    reportInFlight = generateDailyReports();
    try {
      await reportInFlight;
    } finally {
      reportInFlight = null;
    }
  });
}

/**
 * Stop daily reporter
 */
export function stopDailyReporter(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[DailyReporter] Stopped');
  }
}

/**
 * Generate daily reports for all active projects
 * Tracks per-project outcomes so retries target only failed projects.
 */
export async function generateDailyReports(): Promise<void> {
  if (!linearClient || !teamId) {
    console.warn('[DailyReporter] Linear client or team ID not configured');
    return;
  }

  try {
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

    // Track per-project publication outcome so retries target only failed projects
    const projectResults: { id: string; name: string; ok: boolean }[] = [];

    for (const project of activeProjects) {
      try {
        const projectPath = projectPathMapping.get(project.id);
        await postStatusUpdate(project.id, project.name, projectPath);
        projectResults.push({ id: project.id, name: project.name, ok: true });
      } catch (err) {
        console.error(`[DailyReporter] Failed to post update for "${project.name}":`, err);
        projectResults.push({ id: project.id, name: project.name, ok: false });
      }
    }

    const successCount = projectResults.filter(r => r.ok).length;
    const failCount = projectResults.filter(r => !r.ok).length;
    const failedProjects = projectResults.filter(r => !r.ok).map(r => r.name);

    console.log(`[DailyReporter] Reports completed: ${successCount} success, ${failCount} failed`);

    // Retry only failed projects (up to 1 retry each)
    if (failCount > 0) {
      console.log(`[DailyReporter] Retrying ${failCount} failed project(s): ${failedProjects.join(', ')}`);
      for (const result of projectResults) {
        if (!result.ok) {
          try {
            const projectPath = projectPathMapping.get(result.id);
            await postStatusUpdate(result.id, result.name, projectPath);
            result.ok = true;
            console.log(`[DailyReporter] Retry succeeded for "${result.name}"`);
          } catch (err) {
            console.error(`[DailyReporter] Retry also failed for "${result.name}":`, err);
          }
        }
      }
    }

    // Outcome counts must reflect post-retry state so Discord/summary stay accurate.
    const finalSuccessCount = projectResults.filter(r => r.ok).length;
    const finalFailCount = projectResults.filter(r => !r.ok).length;
    if (finalSuccessCount !== successCount || finalFailCount !== failCount) {
      console.log(`[DailyReporter] After retry: ${finalSuccessCount} success, ${finalFailCount} failed`);
    }

    // Send summary to Discord
    if (discordReporter && finalSuccessCount > 0) {
      await sendDiscordSummary(activeProjects.length, finalSuccessCount, finalFailCount);
    }
  } catch (error) {
    console.error('[DailyReporter] Failed to generate reports:', error);
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