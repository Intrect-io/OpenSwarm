// ============================================
// OpenSwarm - Daily Status Report Scheduler
// Consolidates Linear Status Updates to once daily at 6 PM
// ============================================

import { Cron } from 'croner';
import { LinearClient } from '@linear/sdk';
import { postStatusUpdate } from '../linear/index.js';

let cronJob: Cron | null = null;
let linearClient: LinearClient | null = null;
let discordReporter: ((content: any) => Promise<void>) | null = null;
let teamId: string | null = null;
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
 * Start daily reporter with cron schedule
 */
export function startDailyReporter(config: DailyReporterConfig): void {
  if (!config.enabled) {
    console.log('[DailyReporter] Disabled in configuration');
    return;
  }

  if (cronJob) {
    console.log('[DailyReporter] Already running');
    return;
  }

  const schedule = config.schedule || '0 18 * * *'; // Default: 6 PM daily

  cronJob = new Cron(schedule, async () => {
    await generateDailyReports();
  });

  console.log(`[DailyReporter] Started with schedule: ${schedule}`);
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
 * Manually trigger daily reports (for testing)
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

  console.log('[DailyReporter] Generating daily reports...');

  try {
    // Fetch all active projects from Linear
    const team = await linearClient.team(teamId);
    if (!team) {
      console.warn('[DailyReporter] Team not found');
      return;
    }

    const projects = await team.projects({ first: 50 });
    const activeProjects = projects.nodes.filter(p => p.state !== 'canceled');

    if (activeProjects.length === 0) {
      console.log('[DailyReporter] No active projects found');
      return;
    }

    console.log(`[DailyReporter] Found ${activeProjects.length} active projects`);

    // Generate status update for each project
    let successCount = 0;
    let failCount = 0;

    for (const project of activeProjects) {
      try {
        const projectPath = projectPathMapping.get(project.id);
        await postStatusUpdate(project.id, project.name, projectPath);
        successCount++;
      } catch (err) {
        console.error(`[DailyReporter] Failed to post update for "${project.name}":`, err);
        failCount++;
      }
    }

    console.log(`[DailyReporter] Reports completed: ${successCount} success, ${failCount} failed`);

    // Send summary to Discord
    if (discordReporter && successCount > 0) {
      await sendDiscordSummary(activeProjects.length, successCount, failCount);
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
