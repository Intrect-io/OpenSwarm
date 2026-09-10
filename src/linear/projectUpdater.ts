// ============================================
// OpenSwarm - Linear Project Updater (PO Agent)
// Rich project status updates + overview auto-refresh
// Uses pipeline history, rejection state, knowledge graph

import { LinearClient } from '@linear/sdk';
import { getPipelineHistory, getAllRejectionEntries, type PipelineHistoryEntry, type RejectionEntry } from '../automation/runnerState.js';
import { getGraph, toProjectSlug, getProjectHealth, type ModuleHealth } from '../knowledge/index.js';
import type { ProjectSummary } from '../knowledge/index.js';
import { getDateLocale } from '../locale/index.js';
import { withRateLimit } from '../support/rateLimiter.js';

// Debounce: prevent duplicate calls within 60 seconds per project
const lastUpdateTime = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

// LinearClient is initialized in linear.ts. Must be set separately here.
let client: LinearClient | null = null;

export function setLinearClient(c: LinearClient): void {
  client = c;
}

function getClient(): LinearClient {
  if (!client) throw new Error('projectUpdater: LinearClient not set');
  return client;
}

export interface CompletedTaskInfo {
  title: string;
  success: boolean;
  duration: number;
  issueIdentifier?: string;
  cost?: number;
  projectPath?: string;
}

// Metrics Collection

interface TodayActivity {
  completed: number;
  failed: number;
  cost: number;
  entries: PipelineHistoryEntry[];
}

interface RollingMetrics {
  totalTasks: number;
  successCount: number;
  failCount: number;
  successRate: number;
  avgDuration: number;
  totalCost: number;
  startDate: string;
  endDate: string;
  // 7-day trend (current 7d vs previous 7d)
  trend: {
    tasks: number;
    successRate: number;
    cost: number;
  };
}

interface KnowledgeMetrics {
  summary: ProjectSummary;
  riskModules: ModuleHealth[];
}

interface ProjectMetrics {
  today: TodayActivity;
  rolling: RollingMetrics;
  rejections: RejectionEntry[];
  knowledge: KnowledgeMetrics | null;
}

function collectProjectMetrics(projectName: string): ProjectMetrics {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Pipeline history for this project
  const allHistory = getPipelineHistory(100);
  const projectHistory = allHistory.filter(e => e.projectName === projectName);

  // Today's activity
  const todayEntries = projectHistory.filter(e => e.completedAt.startsWith(todayStr));
  const todayCompleted = todayEntries.filter(e => e.success);
  const todayFailed = todayEntries.filter(e => !e.success);
  const todayCost = todayEntries.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);

  // 30-day rolling metrics
  const rollingEntries = projectHistory.filter(e => new Date(e.completedAt) >= thirtyDaysAgo);
  const rollingSuccess = rollingEntries.filter(e => e.success);
  const rollingFail = rollingEntries.filter(e => !e.success);
  const rollingCost = rollingEntries.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);
  const rollingAvgDuration = rollingEntries.length > 0
    ? rollingEntries.reduce((sum, e) => sum + e.totalDuration, 0) / rollingEntries.length
    : 0;

  // 7-day trend: current 7d vs previous 7d
  const current7d = rollingEntries.filter(e => new Date(e.completedAt) >= sevenDaysAgo);
  const prev7d = rollingEntries.filter(e => {
    const d = new Date(e.completedAt);
    return d >= fourteenDaysAgo && d < sevenDaysAgo;
  });

  const current7dRate = current7d.length > 0
    ? current7d.filter(e => e.success).length / current7d.length * 100
    : 0;
  const prev7dRate = prev7d.length > 0
    ? prev7d.filter(e => e.success).length / prev7d.length * 100
    : 0;
  const current7dCost = current7d.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);
  const prev7dCost = prev7d.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);

  // Rolling date range
  const rollingDates = rollingEntries.map(e => e.completedAt.slice(0, 10));
  const startDate = rollingDates.length > 0 ? rollingDates[rollingDates.length - 1] : todayStr;
  const endDate = rollingDates.length > 0 ? rollingDates[0] : todayStr;

  // Rejection state
  let rejections: RejectionEntry[] = [];
  try {
    rejections = getAllRejectionEntries().filter(r => r.count > 0);
  } catch { /* graceful fallback */ }

  // Knowledge graph is async — collected separately by caller via collectKnowledgeMetrics()

  return {
    today: {
      completed: todayCompleted.length,
      failed: todayFailed.length,
      cost: todayCost,
      entries: todayEntries,
    },
    rolling: {
      totalTasks: rollingEntries.length,
      successCount: rollingSuccess.length,
      failCount: rollingFail.length,
      successRate: rollingEntries.length > 0
        ? Math.round(rollingSuccess.length / rollingEntries.length * 100)
        : 0,
      avgDuration: rollingAvgDuration,
      totalCost: rollingCost,
      startDate,
      endDate,
      trend: {
        tasks: current7d.length - prev7d.length,
        successRate: Math.round((current7dRate - prev7dRate) * 10) / 10,
        cost: Math.round((current7dCost - prev7dCost) * 100) / 100,
      },
    },
    rejections,
    knowledge: null,
  };
}

async function collectKnowledgeMetrics(projectPath: string): Promise<KnowledgeMetrics | null> {
  try {
    const slug = toProjectSlug(projectPath);
    const graph = await getGraph(slug);
    if (!graph) return null;
    const { summary, riskModules } = getProjectHealth(graph);
    return { summary, riskModules };
  } catch {
    return null;
  }
}

// Health Determination

type HealthStatus = 'onTrack' | 'atRisk' | 'offTrack';

function determineHealth(metrics: ProjectMetrics): { health: HealthStatus; score: number } {
  let score = 100;

  // Success rate signal
  if (metrics.rolling.totalTasks > 0) {
    if (metrics.rolling.successRate < 50) score -= 40;
    else if (metrics.rolling.successRate < 70) score -= 20;
    else if (metrics.rolling.successRate < 85) score -= 10;
  }

  // Active rejections
  if (metrics.rejections.length >= 3) score -= 20;
  else if (metrics.rejections.length >= 1) score -= 10;

  // Declining trend
  if (metrics.rolling.trend.successRate < -15) score -= 15;
  else if (metrics.rolling.trend.successRate < -5) score -= 5;

  // No activity in 30 days
  if (metrics.rolling.totalTasks === 0) score -= 10;

  // Today's failures exceed completions
  if (metrics.today.failed > metrics.today.completed && metrics.today.failed > 0) score -= 15;

  // Knowledge graph risk modules
  if (metrics.knowledge) {
    const highRisk = metrics.knowledge.riskModules.filter(m => m.risk === 'high');
    if (highRisk.length >= 5) score -= 10;
    else if (highRisk.length >= 2) score -= 5;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let health: HealthStatus;
  if (score >= 70) health = 'onTrack';
  else if (score >= 40) health = 'atRisk';
  else health = 'offTrack';

  return { health, score };
}

// Status Update Body Builder

function buildStatusUpdateBody(
  projectName: string,
  metrics: ProjectMetrics,
): string {
  const today = new Date().toLocaleDateString(getDateLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const lines: string[] = [];
  lines.push(`## ${projectName} -- Status Update (${today})`);
  lines.push('');

  // Today's Activity
  lines.push('### Today\'s Activity');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Completed | ${metrics.today.completed} |`);
  lines.push(`| Failed | ${metrics.today.failed} |`);
  lines.push(`| Cost | $${metrics.today.cost.toFixed(2)} |`);
  lines.push('');

  // 30-Day Metrics
  if (metrics.rolling.totalTasks > 0) {
    const trendTasks = formatTrend(metrics.rolling.trend.tasks, '');
    const trendRate = formatTrend(metrics.rolling.trend.successRate, '%');
    const trendCost = formatTrend(metrics.rolling.trend.cost, '', '$');

    lines.push(`### 30-Day Metrics (${metrics.rolling.startDate} ~ ${metrics.rolling.endDate})`);
    lines.push('| Metric | Value | Trend (7d) |');
    lines.push('|--------|-------|------------|');
    lines.push(`| Tasks | ${metrics.rolling.totalTasks} | ${trendTasks} |`);
    lines.push(`| Success Rate | ${metrics.rolling.successRate}% | ${trendRate} |`);
    lines.push(`| Avg Duration | ${formatDuration(metrics.rolling.avgDuration)} | - |`);
    lines.push(`| Total Cost | $${metrics.rolling.totalCost.toFixed(2)} | ${trendCost} |`);
    lines.push('');
  }

  // Recent Tasks (up to 10)
  const recentEntries = metrics.today.entries.length > 0
    ? metrics.today.entries.slice(0, 10)
    : getPipelineHistory(10).filter(e => e.projectName === projectName).slice(0, 5);

  if (recentEntries.length > 0) {
    lines.push('### Recent Tasks');
    lines.push('| | ID | Task | Duration/Cost | PR |');
    lines.push('|-|----|------|---------------|----|');
    for (const e of recentEntries) {
      const icon = e.success ? '\u2713' : '\u2717';
      const id = e.issueIdentifier || '-';
      const title = e.taskTitle.length > 40 ? e.taskTitle.slice(0, 37) + '...' : e.taskTitle;
      const dur = formatDuration(e.totalDuration);
      const cost = e.cost?.costUsd ? `$${e.cost.costUsd.toFixed(2)}` : '-';
      const pr = e.prUrl ? `[PR](${e.prUrl})` : '-';
      lines.push(`| ${icon} | ${id} | ${title} | ${dur} ${cost} | ${pr} |`);
    }
    lines.push('');
  }

  // Failed Tasks (grouped by issue with failure count and latest reason)
  const failedEntries = metrics.today.entries.filter(e => !e.success);
  if (failedEntries.length > 0) {
    // Group by issueIdentifier
    const failedByIssue = new Map<string, { count: number; latestReason: string; taskTitle: string }>();

    for (const e of failedEntries) {
      const id = e.issueIdentifier || e.taskTitle.slice(0, 20);
      const reason = e.reviewerFeedback || e.finalStatus || 'Unknown failure';

      if (!failedByIssue.has(id)) {
        failedByIssue.set(id, { count: 0, latestReason: reason, taskTitle: e.taskTitle });
      }

      const entry = failedByIssue.get(id)!;
      entry.count++;
      entry.latestReason = reason; // Keep latest reason (entries are newest first)
    }

    lines.push('### Failed Tasks');
    for (const [id, { count, latestReason }] of failedByIssue) {
      const countStr = count > 1 ? ` (${count}회 실패)` : '';
      const reasonStr = latestReason.length > 150 ? latestReason.slice(0, 147) + '...' : latestReason;
      lines.push(`- **${id}**${countStr}: ${reasonStr}`);
    }
    lines.push('');
  }

  // Blocked / Rejected Items
  if (metrics.rejections.length > 0) {
    lines.push('### Blocked / Rejected Items');
    for (const r of metrics.rejections.slice(0, 10)) {
      const latestReason = r.reasons.length > 0 ? r.reasons[r.reasons.length - 1] : 'unknown';
      const shortId = r.issueId.slice(0, 8);
      lines.push(`- Issue ${shortId}...: ${r.count} rejection(s) -- ${latestReason.slice(0, 80)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Public API

/**
 * Update Linear project Overview after task completion
 * NOTE: Status Updates are now handled by dailyReporter (scheduled once daily)
 */
export async function updateProjectAfterTask(
  projectId: string,
  projectName: string,
  task: CompletedTaskInfo,
): Promise<void> {
  // Debounce
  const last = lastUpdateTime.get(projectId) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return;

  // Only refresh overview (Status Updates now handled by dailyReporter)
  await refreshProjectOverview(projectId, task.projectPath);
  lastUpdateTime.set(projectId, Date.now());
}

// B-1. Create Status Update

/**
 * Post Status Update for a project (called by dailyReporter)
 * @param projectId - Linear project ID
 * @param projectName - Project name
 * @param projectPath - Optional project path for knowledge graph metrics
 */
export async function postStatusUpdate(
  projectId: string,
  projectName: string,
  projectPath?: string,
): Promise<void> {
  const linear = getClient();

  // Collect metrics
  const metrics = collectProjectMetrics(projectName);

  // Async knowledge graph collection
  if (projectPath) {
    metrics.knowledge = await collectKnowledgeMetrics(projectPath);
  }

  // Build body
  const body = buildStatusUpdateBody(projectName, metrics);

  // Determine health
  const { health } = determineHealth(metrics);

  try {
    await linear.createProjectUpdate({
      projectId,
      body,
      health: health as any,
    });
    console.log(`[ProjectUpdater] Status update posted for "${projectName}" (health=${health})`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to post status update:`, err);
  }
}

// B-2. Project Overview refresh

const AUTOMATION_SECTION_MARKER = '## Automation Status';
const PROJECT_OVERVIEW_PAGE_SIZE = 100;
const PROJECT_OVERVIEW_MAX_PAGES = 10;
const PROJECT_DESCRIPTION_LIMIT = 255;

/**
 * Build a Linear project description that always retains the compact automation
 * summary within the 255-character hard limit (truncates the base text first).
 */
export function buildBoundedProjectDescription(
  baseDesc: string,
  counts: { done: number; inProgress: number; todo: number },
): string {
  const bracketedSummary = `[Done:${counts.done} InProgress:${counts.inProgress} Todo:${counts.todo}]`;
  const sep = baseDesc ? '\n\n' : '';
  const baseBudget = PROJECT_DESCRIPTION_LIMIT - bracketedSummary.length - sep.length;
  let clippedBase = '';
  if (baseBudget > 0 && baseDesc) {
    clippedBase = baseDesc.length > baseBudget
      ? `${baseDesc.slice(0, Math.max(0, baseBudget - 3))}...`
      : baseDesc;
  }
  const finalDesc = clippedBase
    ? `${clippedBase}${sep}${bracketedSummary}`
    : bracketedSummary.slice(0, PROJECT_DESCRIPTION_LIMIT);
  return finalDesc.length > PROJECT_DESCRIPTION_LIMIT
    ? finalDesc.slice(0, PROJECT_DESCRIPTION_LIMIT)
    : finalDesc;
}

interface ProjectOverviewIssueNode {
  priority: number;
  state?: { name?: string | null } | null;
}

const PROJECT_OVERVIEW_ISSUES_QUERY = `
  query OswProjectOverviewIssues($projectId: String!, $first: Int, $after: String) {
    project(id: $projectId) {
      issues(first: $first, after: $after) {
        nodes {
          priority
          state { name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

async function fetchProjectOverviewIssues(
  linear: LinearClient,
  projectId: string,
): Promise<ProjectOverviewIssueNode[]> {
  const gql = (linear as unknown as {
    client: { rawRequest: <T>(q: string, v?: Record<string, unknown>) => Promise<{ data: T }> };
  }).client;
  const issueNodes: ProjectOverviewIssueNode[] = [];
  let after: string | undefined;
  let complete = false;

  for (let page = 0; page < PROJECT_OVERVIEW_MAX_PAGES; page++) {
    const res = await withRateLimit('linear', () =>
      gql.rawRequest<{
        project?: {
          issues?: {
            nodes: ProjectOverviewIssueNode[];
            pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          };
        } | null;
      }>(PROJECT_OVERVIEW_ISSUES_QUERY, {
        projectId,
        first: PROJECT_OVERVIEW_PAGE_SIZE,
        after,
      }),
    );
    const issues = res.data.project?.issues;
    if (!issues) break;

    issueNodes.push(...issues.nodes);
    if (!issues.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    after = issues.pageInfo.endCursor ?? undefined;
    if (!after) break;
  }

  if (!complete && issueNodes.length >= PROJECT_OVERVIEW_MAX_PAGES * PROJECT_OVERVIEW_PAGE_SIZE) {
    throw new Error(`Project overview exceeds the ${PROJECT_OVERVIEW_MAX_PAGES * PROJECT_OVERVIEW_PAGE_SIZE}-issue safety cap`);
  }

  return issueNodes;
}

async function refreshProjectOverview(projectId: string, projectPath?: string): Promise<void> {
  const linear = getClient();

  try {
    const project = await linear.project(projectId);
    if (!project) return;

    // Issue stats: one paged GraphQL query embeds state names and avoids per-issue lazy resolver calls.
    const issueNodes = await fetchProjectOverviewIssues(linear, projectId);
    const stateCounts = new Map<string, number>();
    const priorityCounts = new Map<number, number>();

    for (const issue of issueNodes) {
      const state = issue.state?.name ?? 'Unknown';
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
      priorityCounts.set(issue.priority, (priorityCounts.get(issue.priority) ?? 0) + 1);
    }

    // Collect metrics
    const metrics = collectProjectMetrics(project.name);

    // Async knowledge graph
    if (projectPath) {
      metrics.knowledge = await collectKnowledgeMetrics(projectPath);
    }

    // Linear limits project description to 255 characters.
    // Keep only the base description (before automation section marker).
    // The full overview section is posted via Status Updates instead.
    const currentDesc = project.description ?? '';
    const markerIdx = currentDesc.indexOf(AUTOMATION_SECTION_MARKER);
    const stripped = markerIdx >= 0
      ? currentDesc.slice(0, markerIdx).trimEnd()
      : currentDesc;
    // Strip any previously-appended compact summary so it isn't doubled on each call.
    const baseDesc = stripped.replace(/\s*\[Done:\d+ InProgress:\d+ Todo:\d+\]$/, '').trimEnd();

    // Build a compact summary line for description (fits within 255 chars).
    // Reserve capacity for the summary first so truncation never chops it off.
    const doneCount = stateCounts.get('Done') ?? 0;
    const inProgressCount = stateCounts.get('In Progress') ?? 0;
    const todoCount = stateCounts.get('Todo') ?? 0;
    const finalDesc = buildBoundedProjectDescription(baseDesc, {
      done: doneCount,
      inProgress: inProgressCount,
      todo: todoCount,
    });

    await linear.updateProject(projectId, { description: finalDesc });
    console.log(`[ProjectUpdater] Project overview updated for "${project.name}"`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to update project overview:`, err);
  }
}

// Helpers

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatTrend(value: number, suffix: string, prefix = ''): string {
  if (value === 0) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${prefix}${value}${suffix}`;
}
